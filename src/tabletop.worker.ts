import { WasmEngine } from './wasm-engine';
import { simulateTabletop } from './tabletop-physics';
import { scenarios } from './tabletop-scenarios';

let engine: WasmEngine;
let pending: number | null = null;
let working = false;
const cache = new Map<number, Awaited<ReturnType<typeof simulateTabletop>>>();
async function drain() {
  if (working || !engine) return;
  working = true;
  try {
    while (pending !== null) {
      const id: number = pending; pending = null;
      let episode = cache.get(id);
      if (!episode) { episode = await simulateTabletop(engine.mj, scenarios[id]); cache.set(id, episode); }
      // Keep memory bounded: the 100 scenarios are generated on demand, not all resident.
      if (cache.size > 6) cache.delete(cache.keys().next().value!);
      self.postMessage({ type: 'episode', id, episode });
    }
  } catch (error) { self.postMessage({ type: 'error', error: (error as Error).message }); }
  finally { working = false; }
}
self.onmessage = async event => {
  const { type, id } = event.data;
  if (type === 'select' && Number.isInteger(id) && id >= 0 && id < scenarios.length) { pending = id; void drain(); }
  if (type === 'init') {
    try { engine = await WasmEngine.create(); self.postMessage({ type: 'ready' }); void drain(); }
    catch (error) { self.postMessage({ type: 'error', error: (error as Error).message }); }
  }
};
