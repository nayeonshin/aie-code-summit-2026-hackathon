import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { Loader2 } from 'lucide-react';
import { TabletopRenderer } from './tabletop-renderer';
import type { TableEpisode, TableFrame } from './tabletop-physics';
import type { Scenario, TablePlan } from './tabletop-scenarios';

type Packed = Omit<TableEpisode, 'frames'> & { id: number; positions: Float32Array; rotations: Float32Array; length: number };
export function TabletopGrid({ ids, collection, plan, playing, speed, onSelect }: { ids: number[]; collection: Scenario[]; plan: TablePlan | null; playing: boolean; speed: number; onSelect: (id: number) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null), tiles = useRef(new Map<number, HTMLDivElement>());
  const playback = useRef({ playing, speed }); playback.current = { playing, speed };
  const [loaded, setLoaded] = useState(new Set<number>()), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => {
    setLoaded(new Set()); setError('');
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ canvas: canvas.current!, antialias: false, alpha: true }); }
    catch (e) { setError((e as Error).message); return; }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); renderer.setScissorTest(true);
    const views = new Map<number, { view: TabletopRenderer; episode: Packed; frame: TableFrame }>();
    const worker = new Worker(new URL('./tabletop.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.type === 'error') setError(data.error);
      if (data.type !== 'gridEpisode') return;
      const episode: Packed = data, viewport = tiles.current.get(data.id);
      if (!viewport) return;
      const view = new TabletopRenderer(canvas.current!, { renderer, viewport });
      const frame = { positions: episode.geoms.map(() => [0, 0, 0]), rotations: episode.geoms.map(() => Array(9).fill(0)) } as TableFrame;
      view.load({ ...episode, frames: [frame] }); views.set(data.id, { view, episode, frame });
      setLoaded(prev => new Set([...prev, data.id]));
    };
    worker.onerror = e => setError(e.message || 'Simulation worker failed');
    if (plan) worker.postMessage({ type: 'collection', plan });
    worker.postMessage({ type: 'grid', ids }); worker.postMessage({ type: 'init' });
    const fit = () => { const rect = canvas.current!.getBoundingClientRect(); renderer.setSize(rect.width, rect.height, false); };
    const resize = new ResizeObserver(fit); resize.observe(canvas.current!); fit();
    let animation = 0, last = performance.now(), time = 0;
    const tick = (now: number) => {
      if (!document.hidden) {
        if (playback.current.playing) time += Math.min((now - last) / 1000, .1) * playback.current.speed;
        views.forEach(({ view, episode, frame }) => {
          const index = Math.floor(time * 10) % episode.length;
          frame.positions.forEach((p, i) => { for (let j = 0; j < 3; j++) p[j] = episode.positions[(index * episode.geoms.length + i) * 3 + j]; });
          frame.rotations.forEach((r, i) => { for (let j = 0; j < 9; j++) r[j] = episode.rotations[(index * episode.geoms.length + i) * 9 + j]; });
          view.frame(frame); view.render();
        });
      }
      last = now; animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(animation); resize.disconnect(); worker.terminate(); views.forEach(({ view }) => view.dispose()); renderer.dispose(); };
  }, [ids.join(','), plan, retry]);
  return <div className="tt-grid" style={{ '--columns': Math.ceil(Math.sqrt(ids.length)) } as React.CSSProperties}>
    <canvas ref={canvas} aria-label="Tabletop simulation grid"/>
    {ids.map(id => <div className="tt-grid-tile" key={id} ref={el => { if (el) tiles.current.set(id, el); else tiles.current.delete(id); }}>
      <button className="tt-grid-number" aria-label={`Focus simulation ${id + 1}`} onClick={() => onSelect(id)}>{id + 1}</button>
      {!loaded.has(id) && <Loader2 className="spin tt-grid-loading" size={18}/>}
      <span className="tt-grid-label">{collection[id].task}</span>
    </div>)}
    {error && <p className="tt-grid-error" role="alert">{error} <button onClick={() => setRetry(n => n + 1)}>Retry</button></p>}
  </div>;
}
