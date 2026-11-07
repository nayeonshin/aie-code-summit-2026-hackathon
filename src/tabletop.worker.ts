import { WasmEngine } from './wasm-engine';
import { simulateTabletop } from './tabletop-physics';
import { scenarios, createCollection } from './tabletop-scenarios';

let engine: WasmEngine;
let pending: number | null = null;
let working = false;
let collection = scenarios;
let revision = 0;
const cache = new Map<number, Awaited<ReturnType<typeof simulateTabletop>>>();
async function drain() {
  if (working || !engine) return;
  working = true;
  try {
    while (pending !== null) {
      const id: number = pending; pending = null;
      const generation = revision;
      let episode = cache.get(id);
      if (!episode) { episode = await simulateTabletop(engine.mj, collection[id]); if (generation !== revision) continue; cache.set(id, episode); }
      // Keep memory bounded: the 100 scenarios are generated on demand, not all resident.
      if (cache.size > 6) cache.delete(cache.keys().next().value!);
      self.postMessage({ type: 'episode', id, episode });
    }
  } catch (error) { self.postMessage({ type: 'error', error: (error as Error).message }); }
  finally { working = false; }
}
self.onmessage = async event => {
  const { type, id, plan } = event.data;
  if (type === 'collection') { try { collection = createCollection(plan); revision++; cache.clear(); } catch (error) { self.postMessage({ type: 'error', error: (error as Error).message }); } }
  if (type === 'select' && Number.isInteger(id) && id >= 0 && id < collection.length) { pending = id; void drain(); }
  if (type === 'init') {
    try { engine = await WasmEngine.create(); self.postMessage({ type: 'ready' }); void drain(); }
    catch (error) { self.postMessage({ type: 'error', error: (error as Error).message }); }
  }
};
