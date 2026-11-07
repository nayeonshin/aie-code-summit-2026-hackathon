"""Resumable headless generation. A shard is the commit/checkpoint boundary."""
import argparse
from concurrent.futures import ProcessPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import time
import pyarrow as pa
import pyarrow.parquet as pq
from backend.simulation import episode, load_model, provenance, RECIPES
from backend.objectives import allocation, schedule, PLAN

_model = None

def init_worker():
    global _model
    _model = load_model()

def work(args):
    index, seed, seconds, recipe = args
    return episode(_model, index, seed, seconds, recipe)

def atomic_json(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, indent=2))
    os.replace(temp, path)

def generate(output, count=1000, workers=2, seed=42, seconds=20, shard_size=100):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    config = {'count': count, 'seed': seed, 'seconds': seconds, 'shard_size': shard_size, 'provenance': provenance(), 'objective_quotas': allocation(count)}
    recipes = schedule(count, seed)
    fingerprint = hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()
    manifest_path = output / 'manifest.json'
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        if manifest['fingerprint'] != fingerprint:
            raise ValueError('Resume configuration does not match the saved run.')
        for shard in manifest['shards']:
            file = output / shard['file']
            if not file.exists() or hashlib.sha256(file.read_bytes()).hexdigest() != shard['sha256']:
                raise ValueError(f'Committed shard is missing or corrupted: {shard["file"]}')
    else:
        manifest = {'schema_version': 1, 'fingerprint': fingerprint, 'config': config, 'shards': [],
                    'attempted': 0, 'valid': 0, 'objective_passed': 0, 'annotated': 0, 'status': 'running', 'coverage': {r: 0 for r in RECIPES}}
    # Orphaned shards (a crash between rename and manifest update) are regenerated.
    start = manifest['attempted']
    manifest['status'] = 'running'
    manifest['process_pid'] = os.getpid()
    manifest.pop('error', None)
    atomic_json(manifest_path, manifest)
    started = time.monotonic()
    try:
        with ProcessPoolExecutor(max_workers=workers, initializer=init_worker) as pool:
            for first in range(start, count, shard_size):
                if (output / 'cancel').exists():
                    manifest['status'] = 'cancelled'
                    break
                last = min(first + shard_size, count)
                rows = list(pool.map(work, [(i, seed + i, seconds, recipes[i]) for i in range(first, last)], chunksize=4))
                name = f'shard-{first:06d}.parquet'
                temp = output / (name + '.tmp')
                table = pa.Table.from_pylist(rows)
                # Compact nested float arrays without storing geometry per frame.
                for field in ['qpos', 'qvel', 'ctrl', 'actuator_force', 'external_force']:
                    idx = table.schema.get_field_index(field)
                    table = table.set_column(idx, field, table[field].cast(pa.list_(pa.list_(pa.float32(), 16))))
                pq.write_table(table, temp, compression='zstd')
                os.replace(temp, output / name)
                manifest['shards'].append({'file': name, 'episodes': len(rows), 'bytes': (output / name).stat().st_size,
                                           'sha256': hashlib.sha256((output / name).read_bytes()).hexdigest()})
                manifest['attempted'] = last
                manifest['valid'] += sum(r['valid'] for r in rows)
                manifest['objective_passed'] += sum(r['objective_pass'] for r in rows)
                for row in rows: manifest['coverage'][row['recipe']] += 1
                manifest['episodes_per_second'] = (last - start) / max(time.monotonic() - started, .001)
                atomic_json(manifest_path, manifest)
            else:
                manifest['status'] = 'complete'
    except Exception as exc:
        manifest['status'] = 'failed'
        manifest['error'] = str(exc)
        raise
    finally:
        atomic_json(manifest_path, manifest)
    return manifest

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', default='data/runs/default')
    parser.add_argument('--count', type=int, default=1000)
    parser.add_argument('--workers', type=int, default=2)
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--seconds', type=float, default=20)
    parser.add_argument('--shard-size', type=int, default=100)
    args = parser.parse_args()
    if not 1 <= args.count <= 100000 or not 1 <= args.workers <= 32 or not .1 <= args.seconds <= 30 or not 1 <= args.shard_size <= 1000:
        parser.error('Invalid count, workers, duration, or shard size.')
    print(json.dumps(generate(**vars(args)), indent=2))

if __name__ == '__main__': main()
