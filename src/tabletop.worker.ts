import { WasmEngine } from './wasm-engine';
import { simulateTabletop } from './tabletop-physics';
import { scenarios, createCollection, withArm } from './tabletop-scenarios';

let engine: WasmEngine;
let pending: number | null = null;
let gridQueue: number[] = [];
let working = false;
let collection = withArm(scenarios);
let revision = 0;
const cache = new Map<number, Awaited<ReturnType<typeof simulateTabletop>>>();
async function drain() {
  if (working || !engine) return;
  working = true;
  try {
    while (pending !== null || gridQueue.length) {
      const grid = pending === null;
      const id: number = grid ? gridQueue.shift()! : pending!; if (!grid) pending = null;
      const generation = revision;
      let episode = cache.get(id);
      if (!episode) { episode = await simulateTabletop(engine.mj, collection[id]); if (generation !== revision) continue; if (!grid) cache.set(id, episode); }
      // Keep memory bounded: the 100 scenarios are generated on demand, not all resident.
      if (cache.size > 6) cache.delete(cache.keys().next().value!);
      if (grid) {
        // Grid playback needs transforms only: 10 Hz and packed float buffers.
        const frames = episode.frames.filter((_, i) => i % 3 === 0);
        const positions = new Float32Array(frames.flatMap(f => f.positions.flat()));
        const rotations = new Float32Array(frames.flatMap(f => f.rotations.flat()));
        self.postMessage({ type: 'gridEpisode', id, scenario: episode.scenario, geoms: episode.geoms, metrics: episode.metrics, provenance: episode.provenance, positions, rotations, length: frames.length }, { transfer: [positions.buffer, rotations.buffer] });
      } else self.postMessage({ type: 'episode', id, episode });
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
    try { engine = await WasmEngine.create(); self.postMessage({ type: 'ready' }); void drain(); }
    catch (error) { self.postMessage({ type: 'error', error: (error as Error).message }); }
  }
};
