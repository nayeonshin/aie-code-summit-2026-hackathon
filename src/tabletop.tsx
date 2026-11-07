import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Box, Check, ChevronDown, Droplets, Download, Hand, Loader2, Pause, Play, RotateCcw, Search, Shuffle, X, Database, Sparkles } from 'lucide-react';
import { scenarios, createCollection, taskNames, phaseAt, duration, sampleHz, type Task, type TablePlan } from './tabletop-scenarios';
import { DataExplorer } from './data-explorer';
import { cloudFetch, setAdminToken } from './cloud-runtime';
import './data-explorer.css';
import { TabletopRenderer } from './tabletop-renderer';
import type { TableEpisode } from './tabletop-physics';
import './tabletop.css';

export function Tabletop({ onFoundations }: { onFoundations: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null), renderer = useRef<TabletopRenderer | null>(null), worker = useRef<Worker | null>(null);
  const selectedRef = useRef(0), episodeRef = useRef<TableEpisode | null>(null), frameRef = useRef(0), playingRef = useRef(true), speedRef = useRef(1);
  const [selected, setSelected] = useState(0), [episode, setEpisode] = useState<TableEpisode | null>(null), [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(true), [speed, setSpeed] = useState(1), [filter, setFilter] = useState<Task | 'all'>('all'), [query, setQuery] = useState('');
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(true), [error, setError] = useState(''), [visited, setVisited] = useState<Set<number>>(new Set()), [browserOpen, setBrowserOpen] = useState(false);
  const [collection, setCollection] = useState(scenarios), [plan, setPlan] = useState<TablePlan | null>(null), [dataOpen, setDataOpen] = useState(false), [museOpen, setMuseOpen] = useState(false), [planning, setPlanning] = useState(false), [token, setToken] = useState('');
  const scenario = collection[selected], time = frame / sampleHz;
  const phaseTime = time * (scenario.motion?.speed ?? 1);
  const filtered = collection.filter(s => (filter === 'all' || s.task === filter) && `${s.title} ${s.id + 1} ${s.seed} ${s.proposal?.rationale ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  function choose(id: number) {
    selectedRef.current = id; setSelected(id); setBusy(true); setError(''); setBrowserOpen(false);
    episodeRef.current = null; setEpisode(null); frameRef.current = 0; setFrame(0);
    worker.current?.postMessage({ type: 'select', id });
  }
  function move(delta: number) { const list = filtered.length ? filtered : collection; const current = list.findIndex(s => s.id === selectedRef.current); choose(list[(current + delta + list.length) % list.length].id); }
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
    let disposed = false;
    (async () => {
      for (const url of ['/api/tabletop/plans/latest', '/data/tabletop-plan.json']) {
        try { const response = await fetch(url, { signal: AbortSignal.timeout(5000) }); if (!response.ok) continue; const next = await response.json(); const studies = createCollection(next); if (disposed) return; setPlan(next); setCollection(studies); w.postMessage({ type: 'collection', plan: next }); break; } catch {}
      }
      if (!disposed) { w.postMessage({ type: 'init' }); w.postMessage({ type: 'select', id: selectedRef.current }); }
    })();
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
    return () => { disposed = true; cancelAnimationFrame(animation); w.terminate(); view.dispose(); renderer.current = null; worker.current = null; };
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (dataOpen || museOpen) return;
      if ((event.target as HTMLElement).closest('input,select,textarea,button')) return;
      if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
      if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [filter, query, collection, dataOpen, museOpen]);
  function download() {
    if (!episode) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(episode)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `tabletop-${String(selected + 1).padStart(3, '0')}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function diversify() { setPlanning(true); setError(''); try { if (token) setAdminToken(token); const next: TablePlan = await cloudFetch('/api/tabletop/plans', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 1000 }) }); setCollection(createCollection(next)); setPlan(next); setVisited(new Set()); worker.current?.postMessage({ type: 'collection', plan: next }); choose(0); setMuseOpen(false); } catch (e) { setError((e as Error).message); } finally { setPlanning(false); } }
  return <main className="tabletop-app">
    <header className="tt-header">
      <div className="wordmark"><img className="labbit-mark" src="/labbit.svg" alt=""/><span>labbit<span className="wordmark-light"> / lab</span></span></div>
      <nav className="tt-modes" aria-label="Workspace"><button className="active">Tabletop</button><button onClick={onFoundations}>Hand studies</button></nav>
      <div className="tt-header-tools"><button className="tt-data-button" onClick={() => setDataOpen(true)}><Database size={16}/> Data & AI</button><span className={`status ${ready ? 'online' : ''}`}><i/>{ready ? 'PHYSICS READY' : 'LOADING PHYSICS'}</span></div>
    </header>
    <div className="tt-layout">
      <aside className={`tt-library ${browserOpen ? 'open' : ''}`} aria-label="Simulation library">
        <div className="tt-library-title"><div><span className="tt-eyebrow">THE COLLECTION</span><h1>Tabletop studies <span>{collection.length.toLocaleString()}</span></h1></div><button className="tt-close-library" aria-label="Close simulation browser" onClick={() => setBrowserOpen(false)}><X size={20}/></button></div>
        <p className="tt-library-intro">Small objects. Deliberate movements.<br/>A reproducible manipulation playground.</p>
        <label className="tt-search"><Search size={16}/><input aria-label="Search simulations" placeholder="Find a shape, task, or episode…" value={query} onChange={e => setQuery(e.target.value)}/></label>
        <div className="tt-filters" aria-label="Filter simulations">{(['all', 'transfer', 'push', 'stack', 'pour'] as const).map(task => <button key={task} aria-pressed={filter === task} className={filter === task ? 'active' : ''} onClick={() => setFilter(task)}>{task === 'all' ? 'All studies' : taskNames[task]} <span>{task === 'all' ? collection.length : collection.filter(s => s.task === task).length}</span></button>)}</div>
        <div className="tt-muse-banner"><span><strong>{plan ? 'Muse-diversified' : 'Seeded baseline'}</strong><br/>{plan ? `${plan.variants.length} anchors · physical variations` : 'Add model-proposed diversity'}</span><button aria-label="Generate diversity with Muse" onClick={() => setMuseOpen(true)}><Sparkles size={13}/></button></div>
        <div className="tt-list" role="list" aria-label="Episodes">
          {filtered.map(s => <button role="listitem" aria-label={`Episode ${s.id + 1}: ${s.title}`} aria-current={selected === s.id ? 'true' : undefined} className={`tt-card ${selected === s.id ? 'selected' : ''}`} key={s.id} onClick={() => choose(s.id)}>
            <span className={`tt-object-icon shape-${s.task === 'pour' ? 'cup' : s.shape}`} style={{ '--object-color': s.color } as React.CSSProperties}>{s.task === 'pour' ? <Droplets size={22}/> : <Box size={22}/>}</span>
            <span className="tt-card-copy"><span className="tt-card-title">{s.task === 'pour' ? 'Cup to cup' : taskNames[s.task]}</span><span className="tt-card-detail">{s.task === 'pour' ? 'Particle pour' : s.shape} <span>·</span> 12 seconds</span></span>
            <span className="tt-card-number">{visited.has(s.id) ? <Check size={12}/> : null}{String(s.id + 1).padStart(3, '0')}</span>
          </button>)}
          {!filtered.length && <p className="tt-empty">No matching studies. Try another search.</p>}
        </div>
        <div className="tt-library-bottom"><span><i/>{visited.size} explored / {collection.length.toLocaleString()} scenarios</span><span>Seeded · generated on demand</span></div>
      </aside>
      <section className="tt-workspace" aria-label="Selected simulation">
        <div className="tt-scene-top"><div><span className="tt-eyebrow">STUDY {String(selected + 1).padStart(3, '0')} / {collection.length.toLocaleString()}</span><h2>{scenario.title}</h2><p>{scenario.task === 'pour' ? 'Tilt, transfer particles, return the source cup.' : scenario.task === 'push' ? 'A contact-driven sweep across the work surface.' : scenario.task === 'stack' ? 'Lift, align, and release onto a raised pedestal.' : 'Lift, transport, and release inside the target ring.'}</p>{scenario.proposal && <p className="tt-source-line">Muse variant {scenario.proposal.variant + 1} → MuJoCo · SubQ not reviewed</p>}</div><button className="tt-browse" onClick={() => setBrowserOpen(true)}>Browse studies <ChevronDown size={16}/></button><button title="Export this simulated episode with provenance" aria-label="Download simulated episode" disabled={!episode || busy} onClick={download}><Download size={19}/></button></div>
        <div className="tt-viewport"><canvas ref={canvas} aria-label="3D tabletop manipulation simulation"/>
          {!busy && !error && <><div className="tt-scene-badge"><span className="tt-pulse"/>{phaseAt(scenario.task, phaseTime)}</div><div className="tt-camera-hint">Drag to orbit · scroll to zoom <button aria-label="Reset camera" title="Reset camera" onClick={() => renderer.current?.resetCamera()}><RotateCcw size={14}/></button></div></>}
          {busy && <div className="tt-loading"><Loader2 className="spin" size={25}/><strong>{ready ? 'Simulating this study' : 'Preparing the physics workspace'}</strong><span>{ready ? 'Computing contacts and a 12-second trajectory…' : 'Downloading MuJoCo and the licensed hand model…'}</span></div>}
          {error && <div className="tt-error" role="alert"><strong>Couldn’t prepare this study</strong><p>{error}</p><button onClick={() => ready ? choose(selected) : location.reload()}>Retry</button></div>}
        </div>
        <div className="tt-inspector"><div><span className="tt-eyebrow">CONTROLLER</span><strong>{scenario.task === 'push' ? 'Contact-driven pusher' : 'Assisted wrist & grasp'}</strong></div><div><span className="tt-eyebrow">{scenario.task === 'pour' ? 'PARTICLES IN RECEIVER' : 'FINAL TARGET ERROR'}</span><strong>{episode ? scenario.task === 'pour' ? `${episode.metrics.retainedParticles} / ${episode.metrics.totalParticles}` : `${(episode.metrics.goalDistance * 100).toFixed(1)} cm` : '—'}</strong></div><div><span className="tt-eyebrow">{scenario.task === 'pour' ? 'FLUID MODEL' : 'OBJECT MASS'}</span><strong>{scenario.task === 'pour' ? 'Discrete rigid particles' : `${Math.round(scenario.mass * 1000)} g`}</strong></div><div><span className="tt-eyebrow">SEED</span><strong>{scenario.seed}</strong></div></div>
        <div className="tt-playback">
          <div className="tt-transport"><button aria-label="Previous simulation" onClick={() => move(-1)}><ArrowLeft size={18}/></button><button className="tt-play" disabled={!episode || busy} aria-label={playing ? 'Pause tabletop playback' : 'Play tabletop playback'} onClick={togglePlay}>{playing ? <Pause size={19}/> : <Play size={19}/>}</button><button aria-label="Next simulation" onClick={() => move(1)}><ArrowRight size={18}/></button><button aria-label="Restart tabletop playback" disabled={!episode} onClick={() => seek(0)}><RotateCcw size={17}/></button></div>
          <div className="tt-timeline"><div className="tt-timeline-label"><span>{time.toFixed(1)} <span className="muted">/ {duration}.0s</span></span><span>{episode ? phaseAt(scenario.task, phaseTime) : 'Preparing'} <span className="tt-shortcut">← → navigate · space pause</span></span></div><input aria-label="Tabletop playback position" type="range" min="0" max={duration * sampleHz} step="1" value={frame} disabled={!episode || busy} onChange={e => seek(Number(e.target.value))}/><div className="tt-phase-labels"><span>Approach</span><span>{scenario.task === 'pour' ? 'Pour' : 'Manipulate'}</span><span>Release</span><span>Settle</span></div></div>
          <label className="tt-speed"><span className="tt-eyebrow">SPEED</span><select aria-label="Playback speed" value={speed} onChange={e => { speedRef.current = Number(e.target.value); setSpeed(speedRef.current); }}>{[.25, .5, 1, 2].map(n => <option key={n} value={n}>{n}×</option>)}</select></label><button aria-label="Random simulation" title="Explore another study" onClick={() => choose(filtered[Math.floor(Math.random() * filtered.length)]?.id ?? 0)}><Shuffle size={18}/></button>
        </div>
        <div className="tt-method"><Hand size={15}/><span>Custom 5-finger hand · 20 actuators. Real MuJoCo contacts; assisted grasp constraints, not a learned policy. Water is approximated with 36 rigid particles.</span></div>
      </section>
    </div>
    {dataOpen && <DataExplorer episode={episode} onClose={() => setDataOpen(false)}/>}
    {museOpen && <div className="data-backdrop"><section className="data-explorer" role="dialog" aria-modal="true" aria-label="Muse diversity planner"><div className="data-title"><div><span className="tt-eyebrow">EXPAND THE COLLECTION</span><h2>Muse-driven physical diversity</h2></div><button aria-label="Close Muse planner" onClick={() => setMuseOpen(false)}><X size={20}/></button></div><div className="data-body"><p className="data-note">Create 24 new Muse Wonder anchors and expand them into 1,000 seeded scenarios. Task, shape, size, mass, friction, placement, path, lift and speed change within validated bounds. This makes one paid Meta request; simulation remains MuJoCo.</p><div className="muse-form"><input aria-label="Muse admin token" type="password" placeholder="Admin token (if not unlocked)" value={token} onChange={e => setToken(e.target.value)}/><button disabled={planning} onClick={diversify}>{planning ? <Loader2 className="spin" size={16}/> : <Sparkles size={16}/>} Generate 1,000 scenarios</button><span>Proposals ≠ completed recordings</span></div></div></section></div>}
  </main>;
}
