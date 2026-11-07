import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import loadMujoco from '@mujoco/mujoco';
await build({ entryPoints: ['src/tabletop-physics.ts', 'src/tabletop-scenarios.ts'], bundle: true, platform: 'node', format: 'esm', outdir: 'test-results/tabletop-retry' });
const { simulateTabletop } = await import('../test-results/tabletop-retry/tabletop-physics.js');
const { scenarios } = await import('../test-results/tabletop-retry/tabletop-scenarios.js');
const mj = await loadMujoco();
const original = globalThis.fetch;
let manifestCalls = 0;
globalThis.fetch = async url => {
  if (url === '/model/manifest.json' && ++manifestCalls <= 3) throw new TypeError('Injected network outage');
  return new Response(readFileSync('public' + url));
};
try {
  await assert.rejects(simulateTabletop(mj, scenarios[0]), /Robot manifest failed to download/);
  assert.equal(manifestCalls, 3);
  const episode = await simulateTabletop(mj, scenarios[0]);
  assert.equal(manifestCalls, 4);
  assert.equal(episode.metrics.finite, true); assert.equal(episode.frames.length, 361);
  console.log('Tabletop Retry clears the rejected asset cache, fetches again, and loads a real MuJoCo episode.');
} finally { globalThis.fetch = original; }
