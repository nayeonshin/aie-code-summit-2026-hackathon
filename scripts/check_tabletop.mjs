import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import loadMujoco from '@mujoco/mujoco';
import { build } from 'esbuild';

await build({ entryPoints: ['src/tabletop-physics.ts', 'src/tabletop-scenarios.ts'], bundle: true, platform: 'node', format: 'esm', outdir: 'test-results/tabletop', write: true });
const { simulateTabletop } = await import('../test-results/tabletop/tabletop-physics.js');
const { scenarios } = await import('../test-results/tabletop/tabletop-scenarios.js');
const originalFetch = globalThis.fetch;
globalThis.fetch = async url => new Response(readFileSync('public' + url));
const mj = await loadMujoco();
try {
  assert.equal(scenarios.length, 100);
  const ids = process.argv.includes('--all') ? scenarios.map(s => s.id) : [0, 1, 2, 25, 26, 27, 50, 51, 52, 75];
  for (const id of ids) {
    const started = performance.now();
    const episode = await simulateTabletop(mj, scenarios[id]);
    assert.equal(episode.frames.length, 361);
    assert.equal(episode.metrics.finite, true, `Episode ${id} has non-finite positions`);
    assert.equal(episode.provenance.handActuators, 20);
    assert.ok(episode.metrics.contacts > 0);
    assert.ok(episode.frames.every(f => f.positions.length === episode.geoms.length));
    assert.ok(episode.frames.every(f => f.positions.flat().every(n => Math.abs(n) < 10)), `Episode ${id} unstable`);
    const first = episode.frames[0].object, last = episode.frames.at(-1).object;
    assert.ok(Math.hypot(...last.map((n, i) => n - first[i])) > .03 || scenarios[id].task === 'pour', `Episode ${id} object did not move`);
    if (scenarios[id].task === 'pour') assert.ok(episode.metrics.retainedParticles > 0, `Episode ${id} did not transfer particles`);
    console.log(id + 1, scenarios[id].task, scenarios[id].shape, JSON.stringify(episode.metrics), Math.round(performance.now() - started) + 'ms');
  }
} finally { globalThis.fetch = originalFetch; }
