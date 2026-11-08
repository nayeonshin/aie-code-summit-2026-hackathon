import { WasmEngine } from './wasm-engine';
import { simulateTabletop } from './tabletop-physics';
import { scenarios, createCollection, withArm } from './tabletop-scenarios';

let engine: Promise<WasmEngine> | undefined;
let initialized = false;
let recordings: TabletopRecordings | null = null;
async function episodeFor(id: number, signal: AbortSignal) {
  const scenario = collection[id];
  const published = await recordings?.load(scenario, signal);
  signal.throwIfAborted();
  if (published) return published;
  // Keep one shared initialization, but never serialize replay behind an
  // abandoned consumer's WASM/robot downloads. Failed initialization can retry.
  engine ??= WasmEngine.create().catch(error => { engine = undefined; throw error; });
  const physics = await withAbort(engine, signal);
  signal.throwIfAborted();
  return simulateTabletop(physics.mj, scenario, signal);
}
let pending: number | null = null;
let gridQueue: number[] = [];
let working = false;
let collection = withArm(scenarios);
let revision = 0;
let active: AbortController | undefined;
function supersede() { revision++; active?.abort(); pending = null; gridQueue = []; }
const cache = new Map<number, Awaited<ReturnType<typeof simulateTabletop>>>();
async function drain() {
  if (working || !initialized) return;
  working = true;
  try {
    while (pending !== null || gridQueue.length) {
      const grid = pending === null;
      const id: number = grid ? gridQueue.shift()! : pending!; if (!grid) pending = null;
      const generation = revision;
      const controller = new AbortController(); active = controller;
      try {
        let episode = cache.get(id);
        if (!episode) { episode = await episodeFor(id, controller.signal); if (generation !== revision) continue; if (!grid) cache.set(id, episode); }
        // Keep memory bounded: only six full episodes are resident in the worker.
        if (cache.size > 6) cache.delete(cache.keys().next().value!);
        if (grid) {
          // Grid playback needs transforms only: 10 Hz and packed float buffers.
          const frames = episode.frames.filter((_, i) => i % 3 === 0);
          const positions = new Float32Array(frames.flatMap(f => f.positions.flat()));
          const rotations = new Float32Array(frames.flatMap(f => f.rotations.flat()));
          self.postMessage({ type: 'gridEpisode', id, scenario: episode.scenario, geoms: episode.geoms, metrics: episode.metrics, provenance: episode.provenance, recording: episode.recording, positions, rotations, length: frames.length }, { transfer: [positions.buffer, rotations.buffer] });
        } else self.postMessage({ type: 'episode', id, episode });
      } catch (error) {
        if (generation === revision) self.postMessage({ type: 'error', id, grid, error: (error as Error).message });
        // A failed/stale download must not discard a newer queued selection.
      } finally { if (active === controller) active = undefined; }
    }
  } catch (error) { self.postMessage({ type: 'error', error: (error as Error).message }); }
  finally { working = false; }
}
self.onmessage = async event => {
  const { type, id, plan, ids } = event.data;
  if (type === 'grid' && Array.isArray(ids)) { revision++; gridQueue = ids.filter(id => Number.isInteger(id) && id >= 0 && id < collection.length).slice(0, 25); void drain(); }
  if (type === 'collection') { try { collection = withArm(createCollection(plan)); revision++; cache.clear(); } catch (error) { self.postMessage({ type: 'error', error: (error as Error).message }); } }
  if (type === 'select' && Number.isInteger(id) && id >= 0 && id < collection.length) { pending = id; void drain(); }
  if (type === 'init') {
    try { recordings = await TabletopRecordings.open(); initialized = true; self.postMessage({ type: 'ready' }); void drain(); }
    catch (error) { self.postMessage({ type: 'error', error: (error as Error).message }); }
  }
};
