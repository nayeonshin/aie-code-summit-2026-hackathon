import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import loadMujoco from '@mujoco/mujoco';
import { build } from 'esbuild';

await build({ entryPoints: ['src/tabletop-physics.ts', 'src/tabletop-scenarios.ts'], bundle: true, platform: 'node', format: 'esm', outdir: 'test-results/tabletop', write: true });
const { simulateTabletop } = await import('../test-results/tabletop/tabletop-physics.js');
const { scenarios, createCollection } = await import('../test-results/tabletop/tabletop-scenarios.js');
const planArg = process.argv.find(arg => arg.startsWith('--plan='));
const collection = planArg ? createCollection(JSON.parse(readFileSync(planArg.slice(7), 'utf8'))) : scenarios;
const exporting = process.argv.includes('--export');
const tasksArg = process.argv.find(arg => arg.startsWith('--tasks='));
const tasks = tasksArg?.slice(8).split(',');
const summaries = exporting && tasks && existsSync('data/publish/tabletop/index.json') ? JSON.parse(readFileSync('data/publish/tabletop/index.json', 'utf8')).studies.filter(s => !tasks.includes(s.task)) : [];
if (exporting) mkdirSync('data/publish/tabletop', { recursive: true });
const originalFetch = globalThis.fetch;
globalThis.fetch = async url => new Response(readFileSync('public' + url));
const mj = await loadMujoco();
try {
  assert.equal(scenarios.length, 100);
  const selectedIds = process.argv.includes('--all') ? collection.map(s => s.id) : exporting ? collection.slice(0, 100).map(s => s.id) : [0, 1, 2, 25, 26, 27, 50, 51, 52, 75];
  const ids = selectedIds.filter(id => !tasks || tasks.includes(collection[id].task));
  for (const id of ids) {
    const started = performance.now();
    const episode = await simulateTabletop(mj, collection[id]);
    assert.equal(episode.frames.length, 361);
    assert.equal(episode.metrics.finite, true, `Episode ${id} has non-finite positions`);
    assert.equal(episode.provenance.handActuators, 20);
    assert.ok(episode.metrics.contacts > 0);
    assert.ok(episode.frames.every(f => f.positions.length === episode.geoms.length));
    assert.ok(episode.frames.every(f => f.positions.flat().every(n => Math.abs(n) < 10)), `Episode ${id} unstable`);
    const first = episode.frames[0].object, last = episode.frames.at(-1).object;
    assert.ok(Math.hypot(...last.map((n, i) => n - first[i])) > .03 || collection[id].task === 'pour', `Episode ${id} object did not move`);
    if (collection[id].task === 'pour') assert.ok(episode.metrics.retainedParticles > 0, `Episode ${id} did not transfer particles`);
    if (collection[id].task !== 'push') for (const frame of episode.frames.filter(f => f.holding && f.time > 2 && f.time < 7)) {
      const towardObject = frame.objectCenter.map((p, i) => p - frame.palm[i]);
      assert.ok(towardObject.reduce((sum, p, i) => sum + p * frame.palmNormal[i], 0) > .08, `Episode ${id}: back of hand faces the object`);
      // The weld is compliant: allow up to 1 cm transient lag for heavy,
      // high-acceleration Muse variants, while rejecting the old ~10 cm offset.
      assert.ok(Math.hypot(...frame.objectCenter.map((p, i) => p - frame.graspCenter[i])) < .01, `Episode ${id}: object-local grip offset drifted`);
    }
    if (exporting) { const file = `episode-${String(id + 1).padStart(4, '0')}.json.gz`; writeFileSync('data/publish/tabletop/' + file, gzipSync(JSON.stringify(episode))); summaries.push({ ...episode.scenario, metrics: episode.metrics, provenance: episode.provenance, frames: episode.frames.length, file }); }
    console.log(id + 1, collection[id].task, collection[id].shape, JSON.stringify(episode.metrics), Math.round(performance.now() - started) + 'ms');
  }
  if (exporting) { summaries.sort((a, b) => a.id - b.id); writeFileSync('data/publish/tabletop/index.json', JSON.stringify({ planned: collection.length, recorded: summaries.length, studies: summaries }, null, 2)); writeFileSync('data/publish/muse/scenarios.json', JSON.stringify(collection, null, 2)); }
} finally { globalThis.fetch = originalFetch; }
