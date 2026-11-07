import { WasmEngine, type BrowserSimulation } from './wasm-engine';
import { recipes, schedule, type Variant } from './objectives';

let engine: WasmEngine;
let live: BrowserSimulation[] = [];
let paused = false;
let seed = 42;
let count = 9;
const reset = () => { live.forEach(s => s.dispose()); live = Array.from({ length: count }, (_, i) => engine.simulation(recipes[i % recipes.length], seed + i * 17)); };

self.onmessage = async event => {
  const { type, id, ...data } = event.data;
  try {
    if (type === 'init') {
      engine = await WasmEngine.create(); reset();
      self.postMessage({ type: 'ready', description: engine.description(), provenance: engine.provenance });
      setInterval(() => { if (!paused) live.forEach(s => s.advance()); self.postMessage({ type: 'live', states: live.map(s => s.state()) }); }, 1000 / 30);
    } else if (type === 'command') {
      if (typeof data.paused === 'boolean') paused = data.paused;
      if (data.count) count = Math.max(1, Math.min(16, data.count));
      if (data.reset || data.count) { seed = data.seed ?? seed + 101; reset(); }
    } else if (type === 'batch') {
      const objectives = schedule(data.count, data.seed);
      const rows = [];
      for (let index = data.first; index < Math.min(data.first + data.size, data.count); index++) {
        const recipe = objectives[index];
        const variants: Variant[] = (data.variants ?? []).filter((v: Variant) => v.objective === recipe);
        const simulation = engine.simulation(recipe, data.seed + index, variants.length ? variants[index % variants.length] : undefined);
        try { rows.push(simulation.record(data.seconds, index)); } finally { simulation.dispose(); }
      }
      self.postMessage({ type: 'result', id, rows });
    } else if (type === 'replay') {
      self.postMessage({ type: 'result', id, frames: data.row.qpos.map((qpos: number[], index: number) => ({ ...engine.replay(qpos), time: data.row.time[index] })) });
    }
  } catch (err) { self.postMessage({ type: 'error', id, error: (err as Error).message }); }
};
