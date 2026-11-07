import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Box, Check, ChevronDown, Droplets, Download, Hand, Loader2, Pause, Play, RotateCcw, Search, Shuffle, X } from 'lucide-react';
import { scenarios, taskNames, phaseAt, duration, sampleHz, type Task } from './tabletop-scenarios';
import { TabletopRenderer } from './tabletop-renderer';
import type { TableEpisode } from './tabletop-physics';
import './tabletop.css';

export function Tabletop({ onFoundations }: { onFoundations: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null), renderer = useRef<TabletopRenderer | null>(null), worker = useRef<Worker | null>(null);
  const selectedRef = useRef(0), episodeRef = useRef<TableEpisode | null>(null), frameRef = useRef(0), playingRef = useRef(true), speedRef = useRef(1);
  const [selected, setSelected] = useState(0), [episode, setEpisode] = useState<TableEpisode | null>(null), [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(true), [speed, setSpeed] = useState(1), [filter, setFilter] = useState<Task | 'all'>('all'), [query, setQuery] = useState('');
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(true), [error, setError] = useState(''), [visited, setVisited] = useState<Set<number>>(new Set()), [browserOpen, setBrowserOpen] = useState(false);
  const scenario = scenarios[selected], time = frame / sampleHz;
  const filtered = scenarios.filter(s => (filter === 'all' || s.task === filter) && `${s.title} ${s.id + 1} ${s.seed}`.toLowerCase().includes(query.toLowerCase()));
  function choose(id: number) {
    selectedRef.current = id; setSelected(id); setBusy(true); setError(''); setBrowserOpen(false);
    episodeRef.current = null; setEpisode(null); frameRef.current = 0; setFrame(0);
    worker.current?.postMessage({ type: 'select', id });
  }
  function move(delta: number) { const list = filtered.length ? filtered : scenarios; const current = list.findIndex(s => s.id === selectedRef.current); choose(list[(current + delta + list.length) % list.length].id); }
  function togglePlay() { playingRef.current = !playingRef.current; setPlaying(playingRef.current); }
  function seek(value: number) { frameRef.current = value; setFrame(value); const e = episodeRef.current; if (e) renderer.current?.frame(e.frames[value]); }
  useEffect(() => {
    let view: TabletopRenderer;
    try { view = new TabletopRenderer(canvas.current!); renderer.current = view; }
    catch (err) { setError(`3D rendering unavailable: ${(err as Error).message}`); setBusy(false); return; }
    const w = new Worker(new URL('./tabletop.worker.ts', import.meta.url), { type: 'module' }); worker.current = w;
    w.onmessage = event => {
      const data = event.data;
      if (data.type === 'ready') setReady(true);
      if (data.type === 'error') { setError(data.error); setBusy(false); }
      if (data.type === 'episode') {
        setVisited(prev => new Set([...prev, data.id]));
        if (data.id !== selectedRef.current) return;
        const next: TableEpisode = data.episode;
        episodeRef.current = next; setEpisode(next); frameRef.current = 0; setFrame(0); view.load(next); setBusy(false);
      }
    };
    w.onerror = event => { setError(event.message || 'Simulation worker failed. Reload to retry.'); setBusy(false); };
    w.postMessage({ type: 'init' }); w.postMessage({ type: 'select', id: selectedRef.current });
    let last = performance.now(), animation = 0, cursor = 0;
    const tick = (now: number) => {
      const elapsed = Math.min((now - last) / 1000, .1); last = now;
      const e = episodeRef.current;
      if (e && playingRef.current) {
        if (Math.floor(cursor) !== frameRef.current) cursor = frameRef.current;
        cursor += elapsed * sampleHz * speedRef.current;
        if (cursor >= e.frames.length) cursor = 0;
        const index = Math.floor(cursor); frameRef.current = index; setFrame(index); view.frame(e.frames[index]);
      } else cursor = frameRef.current;
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(animation); w.terminate(); view.dispose(); renderer.current = null; worker.current = null; };
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('input,select,textarea,button')) return;
      if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
      if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [filter, query]);
  function download() {
    if (!episode) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(episode)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `tabletop-${String(selected + 1).padStart(3, '0')}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <main className="tabletop-app">
    <header className="tt-header">
      <div className="wordmark"><img className="labbit-mark" src="/labbit.svg" alt=""/><span>labbit<span className="wordmark-light"> / lab</span></span></div>
      <nav className="tt-modes" aria-label="Workspace"><button className="active">Tabletop</button><button onClick={onFoundations}>Hand studies</button></nav>
      <span className={`status ${ready ? 'online' : ''}`}><i/>{ready ? 'PHYSICS READY' : 'LOADING PHYSICS'}</span>
    </header>
    <div className="tt-layout">
      <aside className={`tt-library ${browserOpen ? 'open' : ''}`} aria-label="Simulation library">
        <div className="tt-library-title"><div><span className="tt-eyebrow">THE COLLECTION</span><h1>Tabletop studies <span>100</span></h1></div><button className="tt-close-library" aria-label="Close simulation browser" onClick={() => setBrowserOpen(false)}><X size={20}/></button></div>
        <p className="tt-library-intro">Small objects. Deliberate movements.<br/>A reproducible manipulation playground.</p>
        <label className="tt-search"><Search size={16}/><input aria-label="Search simulations" placeholder="Find a shape, task, or episode…" value={query} onChange={e => setQuery(e.target.value)}/></label>
        <div className="tt-filters" aria-label="Filter simulations">{(['all', 'transfer', 'push', 'stack', 'pour'] as const).map(task => <button key={task} aria-pressed={filter === task} className={filter === task ? 'active' : ''} onClick={() => setFilter(task)}>{task === 'all' ? 'All studies' : taskNames[task]} <span>{task === 'all' ? 100 : 25}</span></button>)}</div>
        <div className="tt-list" role="list" aria-label="Episodes">
          {filtered.map(s => <button role="listitem" aria-label={`Episode ${s.id + 1}: ${s.title}`} aria-current={selected === s.id ? 'true' : undefined} className={`tt-card ${selected === s.id ? 'selected' : ''}`} key={s.id} onClick={() => choose(s.id)}>
            <span className={`tt-object-icon shape-${s.task === 'pour' ? 'cup' : s.shape}`} style={{ '--object-color': s.color } as React.CSSProperties}>{s.task === 'pour' ? <Droplets size={22}/> : <Box size={22}/>}</span>
            <span className="tt-card-copy"><span className="tt-card-title">{s.task === 'pour' ? 'Cup to cup' : taskNames[s.task]}</span><span className="tt-card-detail">{s.task === 'pour' ? 'Particle pour' : s.shape} <span>·</span> 12 seconds</span></span>
            <span className="tt-card-number">{visited.has(s.id) ? <Check size={12}/> : null}{String(s.id + 1).padStart(3, '0')}</span>
          </button>)}
          {!filtered.length && <p className="tt-empty">No matching studies. Try another search.</p>}
        </div>
        <div className="tt-library-bottom"><span><i/>{visited.size} explored / 100 scenarios</span><span>Seeded · generated on demand</span></div>
      </aside>
      <section className="tt-workspace" aria-label="Selected simulation">
        <div className="tt-scene-top"><div><span className="tt-eyebrow">STUDY {String(selected + 1).padStart(3, '0')} / 100</span><h2>{scenario.title}</h2><p>{scenario.task === 'pour' ? 'Tilt, transfer particles, return the source cup.' : scenario.task === 'push' ? 'A contact-driven sweep across the work surface.' : scenario.task === 'stack' ? 'Lift, align, and release onto a raised pedestal.' : 'Lift, transport, and release inside the target ring.'}</p></div><button className="tt-browse" onClick={() => setBrowserOpen(true)}>Browse studies <ChevronDown size={16}/></button><button title="Export this simulated episode with provenance" aria-label="Download simulated episode" disabled={!episode || busy} onClick={download}><Download size={19}/></button></div>
        <div className="tt-viewport"><canvas ref={canvas} aria-label="3D tabletop manipulation simulation"/>
          {!busy && !error && <><div className="tt-scene-badge"><span className="tt-pulse"/>{phaseAt(scenario.task, time)}</div><div className="tt-camera-hint">Drag to orbit · scroll to zoom <button aria-label="Reset camera" title="Reset camera" onClick={() => renderer.current?.resetCamera()}><RotateCcw size={14}/></button></div></>}
          {busy && <div className="tt-loading"><Loader2 className="spin" size={25}/><strong>{ready ? 'Simulating this study' : 'Preparing the physics workspace'}</strong><span>{ready ? 'Computing contacts and a 12-second trajectory…' : 'Downloading MuJoCo and the licensed hand model…'}</span></div>}
          {error && <div className="tt-error" role="alert"><strong>Couldn’t prepare this study</strong><p>{error}</p><button onClick={() => ready ? choose(selected) : location.reload()}>Retry</button></div>}
        </div>
        <div className="tt-inspector"><div><span className="tt-eyebrow">CONTROLLER</span><strong>{scenario.task === 'push' ? 'Contact-driven pusher' : 'Assisted wrist & grasp'}</strong></div><div><span className="tt-eyebrow">{scenario.task === 'pour' ? 'PARTICLES IN RECEIVER' : 'FINAL TARGET ERROR'}</span><strong>{episode ? scenario.task === 'pour' ? `${episode.metrics.retainedParticles} / ${episode.metrics.totalParticles}` : `${(episode.metrics.goalDistance * 100).toFixed(1)} cm` : '—'}</strong></div><div><span className="tt-eyebrow">{scenario.task === 'pour' ? 'FLUID MODEL' : 'OBJECT MASS'}</span><strong>{scenario.task === 'pour' ? 'Discrete rigid particles' : `${Math.round(scenario.mass * 1000)} g`}</strong></div><div><span className="tt-eyebrow">SEED</span><strong>{scenario.seed}</strong></div></div>
        <div className="tt-playback">
          <div className="tt-transport"><button aria-label="Previous simulation" onClick={() => move(-1)}><ArrowLeft size={18}/></button><button className="tt-play" disabled={!episode || busy} aria-label={playing ? 'Pause tabletop playback' : 'Play tabletop playback'} onClick={togglePlay}>{playing ? <Pause size={19}/> : <Play size={19}/>}</button><button aria-label="Next simulation" onClick={() => move(1)}><ArrowRight size={18}/></button><button aria-label="Restart tabletop playback" disabled={!episode} onClick={() => seek(0)}><RotateCcw size={17}/></button></div>
          <div className="tt-timeline"><div className="tt-timeline-label"><span>{time.toFixed(1)} <span className="muted">/ {duration}.0s</span></span><span>{episode ? phaseAt(scenario.task, time) : 'Preparing'} <span className="tt-shortcut">← → navigate · space pause</span></span></div><input aria-label="Tabletop playback position" type="range" min="0" max={duration * sampleHz} step="1" value={frame} disabled={!episode || busy} onChange={e => seek(Number(e.target.value))}/><div className="tt-phase-labels"><span>Approach</span><span>{scenario.task === 'pour' ? 'Pour' : 'Manipulate'}</span><span>Release</span><span>Settle</span></div></div>
          <label className="tt-speed"><span className="tt-eyebrow">SPEED</span><select aria-label="Playback speed" value={speed} onChange={e => { speedRef.current = Number(e.target.value); setSpeed(speedRef.current); }}>{[.25, .5, 1, 2].map(n => <option key={n} value={n}>{n}×</option>)}</select></label><button aria-label="Random simulation" title="Explore another study" onClick={() => choose(filtered[Math.floor(Math.random() * filtered.length)]?.id ?? 0)}><Shuffle size={18}/></button>
        </div>
        <div className="tt-method"><Hand size={15}/><span>Custom 5-finger hand · 20 actuators. Real MuJoCo contacts; assisted grasp constraints, not a learned policy. Water is approximated with 36 rigid particles.</span></div>
      </section>
    </div>
  </main>;
}
