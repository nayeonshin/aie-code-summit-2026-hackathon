import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Box, Check, ChevronDown, Droplets, Download, Loader2, Pause, Play, RotateCcw, Search, Shuffle, X, Database } from 'lucide-react';
import { scenarios, createCollection, withArm, taskNames, durationOf, isPour, sampleHz, type Task, type TablePlan } from './tabletop-scenarios';
import { DataExplorer } from './data-explorer';
import './data-explorer.css';
import { TabletopRenderer } from './tabletop-renderer';
import type { TableEpisode } from './tabletop-physics';
import './tabletop.css';
import { TabletopGrid } from './tabletop-grid';
import { Dropdown } from './dropdown';

export function Tabletop({ onFoundations }: { onFoundations: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null), renderer = useRef<TabletopRenderer | null>(null), worker = useRef<Worker | null>(null);
  const selectedRef = useRef(0), episodeRef = useRef<TableEpisode | null>(null), frameRef = useRef(0), playingRef = useRef(true), speedRef = useRef(1);
  const [selected, setSelected] = useState(0), [episode, setEpisode] = useState<TableEpisode | null>(null), [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(true), [speed, setSpeed] = useState(1), [filter, setFilter] = useState<Task | 'all'>('all'), [query, setQuery] = useState('');
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(true), [error, setError] = useState(''), [visited, setVisited] = useState<Set<number>>(new Set()), [browserOpen, setBrowserOpen] = useState(false);
  const [collection, setCollection] = useState(() => withArm(scenarios)), [plan, setPlan] = useState<TablePlan | null>(null), [dataOpen, setDataOpen] = useState(false);
  const [grid, setGrid] = useState(false), [views, setViews] = useState(9), [page, setPage] = useState(0);
  const time = frame / sampleHz, duration = durationOf(collection[selected]?.task ?? 'transfer');
  const filtered = collection.filter(s => (filter === 'all' || s.task === filter) && `${s.title} ${s.id + 1} ${s.seed} ${s.proposal?.rationale ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => { setPage(0); }, [filter, query]);
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
      if (data.type === 'error' && (!Number.isInteger(data.id) || data.id === selectedRef.current)) { setError(data.error); setBusy(false); }
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
        try { const response = await fetch(url, { signal: AbortSignal.timeout(5000) }); if (!response.ok) continue; const next = await response.json(); const studies = withArm(createCollection(next)); if (disposed) return; setPlan(next); setCollection(studies); w.postMessage({ type: 'collection', plan: next }); break; } catch {}
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
      if (dataOpen) return;
      if ((event.target as HTMLElement).closest('input,select,textarea,button')) return;
      if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
      if (event.key === 'ArrowRight') { event.preventDefault(); if (grid) setPage(p => Math.min(p + 1, Math.max(0, Math.ceil(filtered.length / views) - 1))); else move(1); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); if (grid) setPage(p => Math.max(0, p - 1)); else move(-1); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [filter, query, collection, dataOpen, grid, views]);
  function download() {
    if (!episode) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(episode)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `tabletop-${String(selected + 1).padStart(3, '0')}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const gridIds = filtered.slice(page * views, (page + 1) * views).map(s => s.id);
  return <main className={`tabletop-app ${grid ? 'grid-mode' : ''}`}>
    <header className="tt-header">
      <div className="wordmark"><img className="labbit-mark" src="/labbit.svg" alt=""/><span>labbit<span className="wordmark-light"> / lab</span></span></div>
      <nav className="tt-modes" aria-label="Workspace"><button className={!grid ? 'active' : ''} onClick={() => setGrid(false)}>Single</button><button className={grid ? 'active' : ''} onClick={() => setGrid(true)}>Grid</button></nav>
      <div className="tt-header-tools">{grid && <><select aria-label="Grid task" value={filter} onChange={e => setFilter(e.target.value as Task | 'all')}>{['all', 'transfer', 'push', 'stack', 'pour', 'so101'].map(task => <option key={task} value={task}>{task === 'all' ? 'All' : task}</option>)}</select><select aria-label="Simultaneous simulations" value={views} onChange={e => { setViews(Number(e.target.value)); setPage(0); }}>{[4, 9, 16, 25].map(n => <option key={n} value={n}>{n} views</option>)}</select></>}<button className="tt-data-button" aria-label="Data & AI" title="Data & AI" onClick={() => setDataOpen(true)}><Database size={16}/></button></div>
    </header>
    <div className="tt-layout">
      <aside className={`tt-library ${browserOpen ? 'open' : ''}`} aria-label="Simulation library">
        <div className="tt-library-title"><span>{collection.length.toLocaleString()}</span><button className="tt-close-library" aria-label="Close simulation browser" onClick={() => setBrowserOpen(false)}><X size={20}/></button></div>
        <label className="tt-search"><Search size={16}/><input aria-label="Search simulations" placeholder="Find a shape, task, or episode…" value={query} onChange={e => setQuery(e.target.value)}/></label>
        <div className="tt-filters" aria-label="Filter simulations">{(['all', 'transfer', 'push', 'stack', 'pour', 'so101'] as const).map(task => <button key={task} aria-pressed={filter === task} className={filter === task ? 'active' : ''} onClick={() => setFilter(task)}>{task === 'all' ? 'All studies' : taskNames[task]} <span>{task === 'all' ? collection.length : collection.filter(s => s.task === task).length}</span></button>)}</div>
        <div className="tt-list" role="list" aria-label="Episodes">
          {filtered.map(s => <button role="listitem" aria-label={`Episode ${s.id + 1}: ${s.title}`} aria-current={selected === s.id ? 'true' : undefined} className={`tt-card ${selected === s.id ? 'selected' : ''}`} key={s.id} onClick={() => choose(s.id)}>
            <span className={`tt-object-icon shape-${isPour(s.task) ? 'cup' : s.shape}`} style={{ '--object-color': s.color } as React.CSSProperties}>{isPour(s.task) ? <Droplets size={22}/> : <Box size={22}/>}</span>
             <span className="tt-card-copy"><span className="tt-card-title">{s.task === 'pour' ? 'Pour' : taskNames[s.task]}</span><span className="tt-card-detail">{s.task === 'so101' ? 'arm · cups' : s.task === 'pour' ? 'cup' : s.shape}</span></span>
            <span className="tt-card-number">{visited.has(s.id) ? <Check size={12}/> : null}{String(s.id + 1).padStart(3, '0')}</span>
          </button>)}
          {!filtered.length && <p className="tt-empty">No matching studies. Try another search.</p>}
        </div>
      </aside>
      <section className="tt-workspace" aria-label="Selected simulation">
         <div className="tt-scene-top"><span aria-label="Selected episode">{selected + 1}</span><button className="tt-browse" onClick={() => setBrowserOpen(true)}>Browse <ChevronDown size={16}/></button><button title="Export episode" aria-label="Download simulated episode" disabled={!episode || busy} onClick={download}><Download size={19}/></button><button aria-label="Reset camera" title="Reset camera" onClick={() => renderer.current?.resetCamera()}><RotateCcw size={14}/></button></div>
        <div className="tt-viewport"><canvas ref={canvas} aria-label="3D tabletop manipulation simulation"/>
           {busy && <div className="tt-loading" role="status" aria-label="Loading simulation"><Loader2 className="spin" size={25}/></div>}
          {error && <div className="tt-error" role="alert"><strong>Couldn’t prepare this study</strong><p>{error}</p><button onClick={() => ready ? choose(selected) : location.reload()}>Retry</button></div>}
        </div>
        <div className="tt-playback">
          <div className="tt-transport"><button aria-label="Previous simulation" onClick={() => move(-1)}><ArrowLeft size={18}/></button><button className="tt-play" disabled={!episode || busy} aria-label={playing ? 'Pause tabletop playback' : 'Play tabletop playback'} onClick={togglePlay}>{playing ? <Pause size={19}/> : <Play size={19}/>}</button><button aria-label="Next simulation" onClick={() => move(1)}><ArrowRight size={18}/></button><button aria-label="Restart tabletop playback" disabled={!episode} onClick={() => seek(0)}><RotateCcw size={17}/></button></div>
           <div className="tt-timeline"><div className="tt-timeline-label"><span>{time.toFixed(1)} / {duration.toFixed(1)}s</span></div><input aria-label="Tabletop playback position" type="range" min="0" max={episode ? episode.frames.length - 1 : Math.round(duration * sampleHz)} step="1" value={frame} disabled={!episode || busy} onChange={e => seek(Number(e.target.value))}/></div>
          <label className="tt-speed"><span className="tt-eyebrow">SPEED</span><select aria-label="Playback speed" value={speed} onChange={e => { speedRef.current = Number(e.target.value); setSpeed(speedRef.current); }}>{[.25, .5, 1, 2].map(n => <option key={n} value={n}>{n}×</option>)}</select></label><button aria-label="Random simulation" title="Explore another study" onClick={() => choose(filtered[Math.floor(Math.random() * filtered.length)]?.id ?? 0)}><Shuffle size={18}/></button>
        </div>
      </section>
      {grid && <section className="tt-grid-workspace" aria-label="Simultaneous tabletop simulations">{gridIds.length ? <TabletopGrid ids={gridIds} collection={collection} plan={plan} playing={playing} speed={speed} onSelect={id => { setGrid(false); choose(id); }}/> : <p>No matches</p>}<div className="tt-grid-controls"><button aria-label="Previous simulation page" disabled={page === 0} onClick={() => setPage(p => p - 1)}><ArrowLeft size={18}/></button><button aria-label={playing ? 'Pause grid playback' : 'Play grid playback'} onClick={togglePlay}>{playing ? <Pause size={18}/> : <Play size={18}/>}</button><span>{page + 1} / {Math.max(1, Math.ceil(filtered.length / views))}</span><button aria-label="Next simulation page" disabled={(page + 1) * views >= filtered.length} onClick={() => setPage(p => p + 1)}><ArrowRight size={18}/></button></div></section>}
    </div>
    {dataOpen && <DataExplorer episode={grid ? null : episode} plan={plan} onLegacy={onFoundations} onClose={() => setDataOpen(false)}/>}
  </main>;
}
