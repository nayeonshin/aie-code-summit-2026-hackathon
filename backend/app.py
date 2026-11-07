import asyncio
from contextlib import asynccontextmanager
import json
import os
import re
import subprocess
import sys
import threading
import time
import uuid
import numpy as np
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from backend.simulation import ROOT, RECIPES, Simulation, load_model, scene_description
from backend.subq import SubQ, SubQError

load_dotenv(ROOT / '.env')
RUNS = ROOT / 'data/runs'
RUNS.mkdir(parents=True, exist_ok=True)
model = None
description = None
subq = SubQ()
jobs = {}
job_lock = threading.Lock()

def process_alive(pid):
    if not pid: return False
    try: os.kill(pid, 0); return True
    except (OSError, TypeError): return False

def generation_active():
    if any(j['process'].poll() is None for j in jobs.values()): return True
    for manifest in RUNS.glob('*/manifest.json'):
        saved = json.loads(manifest.read_text())
        if saved['status'] == 'running' and process_alive(saved.get('process_pid')): return True
    return False

def launch(ident, path, count, seconds, workers, shard_size=100, seed=42):
    env = {k: v for k, v in os.environ.items() if k != 'SUBQ_API_KEY'}
    with (path / 'worker.log').open('a') as log:
        process = subprocess.Popen([sys.executable, '-m', 'backend.generate', '--output', str(path), '--count', str(count),
                                    '--seconds', str(seconds), '--workers', str(workers), '--shard-size', str(shard_size), '--seed', str(seed)],
                                   cwd=ROOT, env=env, stdout=log, stderr=log)
    jobs[ident] = {'process': process, 'path': path, 'count': count}
    return {'id': ident}

@asynccontextmanager
async def lifespan(app):
    global model, description
    model = load_model()
    description = scene_description(model)
    yield
    for job in jobs.values():
        if job['process'].poll() is None: (job['path'] / 'cancel').touch()

app = FastAPI(lifespan=lifespan)
app.mount('/datasets', StaticFiles(directory=RUNS), name='datasets')

@app.get('/api/scene')
def scene(): return description

@app.get('/api/health')
def health(): return {'physics': 'mujoco', 'subq_configured': bool(os.getenv('SUBQ_API_KEY')), 'recipes': RECIPES}

@app.websocket('/api/live')
async def live(ws: WebSocket):
    await ws.accept()
    simulations = []
    paused = False
    seed = 42
    count = 9
    def reset():
        return [Simulation(model, RECIPES[i % len(RECIPES)], seed + i * 17) for i in range(count)]
    simulations = reset()
    pending = asyncio.create_task(ws.receive_json())
    deadline = time.monotonic()
    try:
        while True:
            if pending.done():
                command = pending.result()
                paused = bool(command.get('paused', paused))
                if 'count' in command: count = max(1, min(16, int(command['count'])))
                if command.get('reset') or 'count' in command:
                    seed = int(command.get('seed', seed + 101)) % (2 ** 32)
                    simulations = reset()
                pending = asyncio.create_task(ws.receive_json())
            if not paused:
                # Physics work runs off the event loop so requests/other viewers stay responsive.
                await asyncio.to_thread(lambda: [s.advance() for s in simulations])
            states = [s.state() for s in simulations]
            if not all(np.isfinite(s['qpos']).all() for s in states):
                await ws.send_json({'error': 'Non-finite physics state. Reset the simulations.'})
                paused = True
            else:
                await ws.send_json({'paused': paused, 'states': states, 'seed': seed})
            deadline += 1 / 30
            if deadline < time.monotonic() - .1: deadline = time.monotonic()
            await asyncio.sleep(max(0, deadline - time.monotonic()))
    except (WebSocketDisconnect, RuntimeError): pass
    finally:
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)

class Annotation(BaseModel):
    frames: list[str] = Field(min_length=1, max_length=4)
    summary: dict

@app.post('/api/annotate')
async def annotate(request: Annotation):
    if len(json.dumps(request.summary)) > 16000: raise HTTPException(413, 'Telemetry too large.')
    try: return await subq.annotate(request.frames, request.summary)
    except SubQError as exc: raise HTTPException(502, str(exc))

class Generate(BaseModel):
    count: int = Field(default=1000, ge=1, le=100000)
    seconds: float = Field(default=20, ge=.1, le=30)
    workers: int = Field(default=2, ge=1, le=8)

@app.post('/api/runs')
def start_run(request: Generate):
    with job_lock:
        if generation_active(): raise HTTPException(409, 'A generation job is already running.')
        ident = uuid.uuid4().hex[:12]
        path = RUNS / ident
        path.mkdir()
        return launch(ident, path, request.count, request.seconds, request.workers)

@app.get('/api/runs')
def list_runs():
    results = []
    for path in sorted(RUNS.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if not path.is_dir(): continue
        manifest = path / 'manifest.json'
        item = json.loads(manifest.read_text()) if manifest.exists() else {'status': 'starting', 'attempted': 0, 'valid': 0, 'config': {'count': jobs.get(path.name, {}).get('count', 0)}}
        job = jobs.get(path.name)
        if job and job['process'].poll() not in (None, 0) and item['status'] in ('running', 'starting'):
            item['status'] = 'failed'
        elif not job and item['status'] in ('running', 'starting') and not process_alive(item.get('process_pid')):
            item['status'] = 'interrupted'
        results.append({'id': path.name, **item})
    return results

@app.post('/api/runs/{ident}/cancel')
def cancel(ident: str):
    if not re.fullmatch(r'[A-Za-z0-9_-]+', ident): raise HTTPException(400, 'Invalid run.')
    path = RUNS / ident
    if not path.is_dir(): raise HTTPException(404, 'Unknown job.')
    (path / 'cancel').touch()
    return {'status': 'cancelling'}

@app.post('/api/runs/{ident}/resume')
def resume(ident: str):
    if not re.fullmatch(r'[A-Za-z0-9_-]+', ident): raise HTTPException(400, 'Invalid run.')
    path = RUNS / ident
    manifest = path / 'manifest.json'
    if not manifest.exists(): raise HTTPException(404, 'Run not found.')
    with job_lock:
        saved = json.loads(manifest.read_text())
        if generation_active():
            raise HTTPException(409, 'A generation job is already running.')
        if saved['status'] == 'complete': raise HTTPException(409, 'Run is already complete.')
        (path / 'cancel').unlink(missing_ok=True)
        config = saved['config']
        return launch(ident, path, config['count'], config['seconds'], 2, config['shard_size'], config['seed'])

@app.get('/api/runs/{ident}/episodes/{episode_id}')
def replay(ident: str, episode_id: int):
    import pyarrow.parquet as pq
    if not re.fullmatch(r'[A-Za-z0-9_-]+', ident) or episode_id < 0: raise HTTPException(400, 'Invalid episode.')
    path = RUNS / ident
    if not (path / 'manifest.json').exists(): raise HTTPException(404, 'Run not found.')
    manifest = json.loads((path / 'manifest.json').read_text())
    if episode_id >= manifest['attempted']: raise HTTPException(404, 'Episode is not yet recorded.')
    size = manifest['config']['shard_size']
    first = episode_id // size * size
    table = pq.read_table(path / f'shard-{first:06d}.parquet')
    row = table.slice(episode_id - first, 1).to_pylist()[0]
    data = Simulation(model, row['recipe'], row['seed']).data
    frames = []
    import mujoco
    for index, (timestamp, qpos) in enumerate(zip(row['time'], row['qpos'])):
        data.qpos[:] = qpos
        mujoco.mj_forward(model, data)
        frames.append({'time': timestamp, 'positions': data.geom_xpos.tolist(), 'rotations': data.geom_xmat.tolist(), 'qpos': qpos,
                       'qvel': row['qvel'][index], 'ctrl': row['ctrl'][index], 'contacts': row['contacts'][index],
                       'actuator_force': row['actuator_force'][index], 'external_force': row['external_force'][index]})
    return {'recipe': row['recipe'], 'frames': frames, 'valid': row['valid']}
