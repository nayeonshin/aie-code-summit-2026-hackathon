import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Pause, Play, Shuffle, Grid2X2, Grid3X3, Maximize2, Minimize2, Sparkles, Circle, X, ArrowUpRight, Download, Square, ChevronLeft, Loader2, RotateCcw, KeyRound } from 'lucide-react';
import { HandRenderer, type Description, type State } from './renderer';
import { type CloudRuntime, setAdminToken, getAdminToken } from './cloud-runtime';
import './style.css';

type Run = { id: string; status: string; attempted: number; valid: number; config: { count: number }; episodes_per_second?: number };
type Decision = { model: string; image_count: number; answers: { movement: { choice: string; confidence: number }; coordination: { score: number } } };
type Replay = { run: string; episode: number; frames: State[]; recipe: string };
let cloud: CloudRuntime | null = null;

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  if (cloud) return cloud.api(url, options);
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${response.status}).`);
  }
  return response.json();
}

function App() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<HandRenderer | null>(null);
  const cells = useRef<(HTMLElement | null)[]>([]);
  const socket = useRef<{ readyState: number; send(data: string): void; close(): void } | null>(null);
  const mounted = useRef(true);
  const [description, setDescription] = useState<Description | null>(null);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [count, setCount] = useState(9);
  const countRef = useRef(9);
  const [selected, setSelected] = useState(0);
  const [focus, setFocus] = useState<number | null>(null);
  const focusRef = useRef<number | null>(null);
  const [error, setError] = useState('');
  const [recordPanel, setRecordPanel] = useState(false);
  const [total, setTotal] = useState(100);
  const [runs, setRuns] = useState<Run[]>([]);
  const [starting, setStarting] = useState(false);
  const [annotating, setAnnotating] = useState(false);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [replay, setReplay] = useState<Replay | null>(null);
  const replayRef = useRef<Replay | null>(null);
  const [frame, setFrame] = useState(0);
  const frameRef = useRef(0);
  const [elapsed, setElapsed] = useState(0);
  const [aiConfigured, setAiConfigured] = useState(false);
  const [metaConfigured, setMetaConfigured] = useState(false);
  const [metaPlan, setMetaPlan] = useState<{ id: string; variants: unknown[]; model: string } | null>(null);
  const [planning, setPlanning] = useState(false);
  const [cloudMode, setCloudMode] = useState(false);
  const [unlock, setUnlock] = useState(false);
  const [adminToken, setToken] = useState(getAdminToken());

  const send = (command: object) => { if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(command)); };
  const togglePause = () => { const next = !pausedRef.current; pausedRef.current = next; setPaused(next); send({ paused: next || !!replayRef.current }); };

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let reconnect: ReturnType<typeof setTimeout>;
    let ws: WebSocket | undefined;
    const boot = async () => {
      try {
        const health = await api<{ subq_configured: boolean; meta_configured?: boolean; runtime?: string }>('/api/health');
        if (health.runtime === 'browser-wasm') {
          const { CloudRuntime } = await import('./cloud-runtime');
          const runtime = await new CloudRuntime().init();
          if (disposed) { runtime.close(); return; }
          cloud = runtime; socket.current = runtime;
          setDescription(runtime.description); setAiConfigured(health.subq_configured); setMetaConfigured(!!health.meta_configured); setCloudMode(true);
          engine.current = new HandRenderer(canvas.current!, runtime.description);
          runtime.onlive = states => {
            if (replayRef.current) return;
            if (engine.current) engine.current.states = focusRef.current === null ? states : [states[focusRef.current]];
            setElapsed(states[0]?.time ?? 0);
          };
          runtime.onerror = setError;
          setConnected(true); setError('');
          runtime.send(JSON.stringify({ count: countRef.current, paused: pausedRef.current }));
          return;
        }
        const scene = await api<Description>('/api/scene');
        if (disposed) return;
        setDescription(scene); setAiConfigured(health.subq_configured);
        engine.current = new HandRenderer(canvas.current!, scene);
        const connect = () => {
          if (disposed) return;
          ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/live`);
          socket.current = ws;
          ws.onopen = () => { setConnected(true); setError(''); ws!.send(JSON.stringify({ count: countRef.current, paused: pausedRef.current || !!replayRef.current })); };
          ws.onmessage = event => {
            const data = JSON.parse(event.data);
            if (data.error) { setError(data.error); return; }
            if (replayRef.current) return;
            const states: State[] = data.states;
            if (engine.current) engine.current.states = focusRef.current === null ? states : [states[focusRef.current]];
            setElapsed(states[0]?.time ?? 0);
          };
          ws.onclose = () => { if (!disposed) { setConnected(false); reconnect = setTimeout(connect, 1500); } };
        };
        connect();
      } catch (err) { if (!disposed) setError((err as Error).message + ' Reload to retry.'); }
    };
    void boot();
    return () => { disposed = true; mounted.current = false; clearTimeout(reconnect); ws?.close(); cloud?.close(); cloud = null; engine.current?.dispose(); engine.current = null; };
  }, []);

  useEffect(() => {
    focusRef.current = focus;
    if (engine.current) engine.current.elements = cells.current.filter((c): c is HTMLElement => !!c);
  }, [count, focus, description, replay]);

  useEffect(() => {
    const refresh = () => api<Run[]>('/api/runs').then(setRuns).catch(() => {});
    void refresh(); const interval = setInterval(refresh, 1500);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!replay) return;
    const interval = setInterval(() => {
      if (!pausedRef.current) { frameRef.current = (frameRef.current + 1) % replay.frames.length; setFrame(frameRef.current); }
      if (engine.current) engine.current.states = [replay.frames[frameRef.current]];
    }, 1000 / 30);
    return () => clearInterval(interval);
  }, [replay]);

  const changeCount = (n: number) => { countRef.current = n; setCount(n); setFocus(null); setSelected(0); setDecision(null); cells.current = []; send({ count: n }); };
  const focusTile = (index: number | null) => { cells.current = []; setFocus(index); setDecision(null); };
  const reset = () => { setDecision(null); send({ reset: true, seed: crypto.getRandomValues(new Uint32Array(1))[0] }); };

  const annotate = async () => {
    if (!engine.current || annotating) return;
    setAnnotating(true); setError(''); setDecision(null);
    const index = focus === null ? selected : 0;
    try {
      const samples = [];
      // Explicit user action only: no hidden continuous API spend or image uploads.
      for (let i = 0; i < 4; i++) {
        if (!mounted.current) return;
        samples.push(engine.current!.capture(index));
        if (i < 3) await new Promise(resolve => setTimeout(resolve, 650));
      }
      const result = await api<Decision>('/api/annotate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ frames: samples.map(s => s.image), summary: { samples: samples.map(s => s.telemetry) } }) });
      if (mounted.current) setDecision(result);
    } catch (err) { if (mounted.current) setError((err as Error).message); }
    finally { if (mounted.current) setAnnotating(false); }
  };

  const start = async () => {
    setStarting(true); setError('');
    try { await api('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: total, seconds: 20, plan_id: metaPlan?.id }) }); setRuns(await api('/api/runs')); }
    catch (err) { setError((err as Error).message); }
    finally { setStarting(false); }
  };

  const loadReplay = async (run: Run, episode = 0) => {
    try {
      const data = await api<{ frames: State[]; recipe: string }>(`/api/runs/${run.id}/episodes/${episode}`);
      const next = { ...data, run: run.id, episode };
      replayRef.current = next; setReplay(next); frameRef.current = 0; setFrame(0);
      pausedRef.current = false; setPaused(false); send({ paused: true });
      cells.current = []; setFocus(0); setRecordPanel(false); setDecision(null);
    } catch (err) { setError((err as Error).message); }
  };

  const leaveReplay = () => { replayRef.current = null; setReplay(null); cells.current = []; setFocus(null); setDecision(null); send({ paused: pausedRef.current }); };
  const activeRun = runs.find(r => ['running', 'starting'].includes(r.status));
  const visible = focus === null ? count : 1;
  const clock = replay ? replay.frames[frame]?.time ?? 0 : elapsed;

  return <main>
    <canvas ref={canvas} className="world" aria-label="Live MuJoCo robotic hand simulations" />
    <header>
      <div className="wordmark"><img className="labbit-mark" src="/labbit.svg" alt=""/><span>labbit<span className="wordmark-light"> / lab</span></span></div>
      <div className="header-right">{cloudMode && <button aria-label="Unlock cloud generation" title="Cloud admin access" onClick={() => setUnlock(!unlock)}><KeyRound size={13}/></button>}<span className={`status ${connected ? 'online' : ''}`}><i />{replay ? 'REPLAY' : connected ? 'LIVE' : 'OFFLINE'}</span><span className="engine-label">MuJoCo</span></div>
    </header>

    <section className={`grid grid-${visible} ${focus !== null ? 'focused' : ''}`} aria-label="Simulation grid">
      {Array.from({ length: visible }, (_, i) => {
        const index = focus ?? i;
        const recipe = replay?.recipe ?? description?.recipes[index % (description?.recipes.length ?? 9)] ?? '—';
        return <article key={`${focus}-${count}-${i}`} ref={element => { cells.current[i] = element; if (engine.current) engine.current.elements = cells.current.filter((c): c is HTMLElement => !!c); }}
          className={`tile ${selected === index ? 'selected' : ''}`} onClick={() => { if (!annotating) { setSelected(index); setDecision(null); } }} onDoubleClick={() => !replay && !annotating && focusTile(focus === null ? index : null)}>
          <div className="tile-heading"><span className="tile-number">{String(index + 1).padStart(2, '0')}</span><span>{recipe}</span></div>
          <div className="tile-actions"><button title={focus === null ? 'Focus simulation' : 'Show all simulations'} aria-label="Toggle focus" disabled={annotating || !!replay} onClick={e => { e.stopPropagation(); focusTile(focus === null ? index : null); }}>{focus === null ? <Maximize2 size={14}/> : <Minimize2 size={14}/>}</button></div>
          <span className="tile-cross">+</span>
        </article>;
      })}
    </section>

    {!description && !error && <div className="loading"><Loader2 size={19} className="spin"/></div>}
    {error && <div className="notice" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={14}/></button></div>}
    {unlock && <div className="unlock"><input aria-label="Cloud admin token" type="password" placeholder="Admin token" value={adminToken} onChange={e => setToken(e.target.value)}/><button aria-label="Save admin token" onClick={() => { setAdminToken(adminToken); setUnlock(false); }}><ArrowUpRight size={16}/></button></div>}
    {decision && <div className="decision" title="Advisory visual classification, not physics ground truth"><Sparkles size={14}/><span>{decision.answers.movement.choice}</span><span className="muted">{Math.round(decision.answers.movement.confidence * 100)}%</span><span className="decision-source">SubQ · {decision.image_count} frames</span><button onClick={() => setDecision(null)} aria-label="Dismiss annotation"><X size={13}/></button></div>}

    {recordPanel && <aside className="panel">
      <div className="panel-top"><span>Dataset</span><button onClick={() => setRecordPanel(false)} aria-label="Close dataset controls"><X size={16}/></button></div>
      <div className="generate-row"><label><input aria-label="Number of episodes" type="number" min="1" max="100000" value={total} onChange={e => setTotal(Number(e.target.value))}/><span>episodes</span></label><button className="generate" disabled={!!activeRun || starting || !connected || total < 1 || total > 100000} onClick={() => void start()} title="Generate headless dataset" aria-label="Start dataset generation">{starting ? <Loader2 size={18} className="spin"/> : <ArrowUpRight size={20}/>}</button></div>
      <div className="preset-row">{[100, 1000, 10000, 100000].map(n => <button key={n} className={total === n ? 'active' : ''} onClick={() => setTotal(n)}>{n < 1000 ? n : `${n / 1000}k`}</button>)}<span>20s · 30Hz</span></div>
      {cloudMode && <div className="preset-row"><button disabled={!metaConfigured || planning} title="Muse Wonder proposes bounded parameter variations (uses Meta credits)" onClick={async () => { setPlanning(true); setError(''); try { setMetaPlan(await api('/api/plans', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })); } catch (err) { setError((err as Error).message); } finally { setPlanning(false); } }}>{planning ? <Loader2 size={12} className="spin"/> : <Sparkles size={12}/>}<span style={{ marginLeft: 5 }}>Meta</span></button><span>{metaPlan ? `${metaPlan.variants.length} variants` : 'optional'}</span></div>}
      <div className="run-list">{runs.map(run => <div className="run" key={run.id}>
        <div className="run-line"><span>{run.attempted.toLocaleString()}<span className="muted"> / {run.config.count.toLocaleString()}</span></span><span className="run-status">{run.status}</span></div>
        <div className="progress"><i style={{ width: `${run.attempted / Math.max(1, run.config.count) * 100}%` }}/></div>
        <div className="run-bottom"><span>{run.valid.toLocaleString()} valid</span><div>
          {run.attempted > 0 && <><button title="Replay a recorded episode" aria-label="Replay episode" onClick={() => void loadReplay(run)}><Play size={13}/></button><a href={`/datasets/${run.id}/manifest.json`} download title="Download dataset manifest" aria-label="Download manifest"><Download size={13}/></a></>}
          {['running', 'starting'].includes(run.status) && <button title="Stop after this shard" aria-label="Cancel generation" onClick={() => void api(`/api/runs/${run.id}/cancel`, { method: 'POST' }).catch(err => setError(err.message))}><Square size={12}/></button>}
          {['cancelled', 'interrupted', 'failed'].includes(run.status) && <button disabled={!!activeRun} title="Resume generation" aria-label="Resume generation" onClick={() => void api(`/api/runs/${run.id}/resume`, { method: 'POST' }).catch(err => setError(err.message))}><RotateCcw size={13}/></button>}
        </div></div>
      </div>)}</div>
    </aside>}

    <footer>
      <div className="footer-left">{replay ? <button aria-label="Return to live simulations" title="Live" onClick={leaveReplay}><ChevronLeft size={17}/></button> : <span className="footer-count">{String(count).padStart(2, '0')} <span>parallel</span></span>}<span className="time">{clock.toFixed(2)}<span>s</span></span></div>
      <div className="toolbar">
        <button onClick={togglePause} disabled={!connected && !replay} title={paused ? 'Play' : 'Pause'} aria-label={paused ? 'Play simulations' : 'Pause simulations'}>{paused ? <Play size={17}/> : <Pause size={17}/>}</button>
        <button disabled={!connected || annotating} onClick={() => replay ? void loadReplay(runs.find(r => r.id === replay.run)!, Math.floor(Math.random() * (runs.find(r => r.id === replay.run)?.attempted ?? 1))) : reset()} title={replay ? 'Random recorded episode' : 'Reseed simulations'} aria-label="Shuffle simulations"><Shuffle size={17}/></button>
        <div className="divider"/>
        <button disabled={annotating || !!replay} className={count === 4 && focus === null ? 'active' : ''} onClick={() => changeCount(4)} title="4 simulations" aria-label="Show four simulations"><Grid2X2 size={17}/></button>
        <button disabled={annotating || !!replay} className={count === 9 && focus === null ? 'active' : ''} onClick={() => changeCount(9)} title="9 simulations" aria-label="Show nine simulations"><Grid3X3 size={17}/></button>
        <div className="divider"/>
        <button disabled={!aiConfigured || !connected || annotating} className={annotating ? 'active' : ''} onClick={() => void annotate()} title="Send 4 frames + telemetry to SubQ" aria-label="Evaluate selected hand with SubQ">{annotating ? <Loader2 size={17} className="spin"/> : <Sparkles size={17}/>}</button>
        <button className={recordPanel ? 'active' : ''} onClick={() => setRecordPanel(!recordPanel)} title="Generate dataset" aria-label="Open dataset generation"><Circle size={17}/>{activeRun && <i className="record-dot"/>}</button>
      </div>
      <div className="footer-right">{replay ? <input aria-label="Replay position" type="range" min="0" max={replay.frames.length - 1} value={frame} onChange={e => { frameRef.current = Number(e.target.value); setFrame(frameRef.current); }}/>: <span>LEAP <span className="muted">/ 16 DOF</span></span>}</div>
    </footer>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App/>);
