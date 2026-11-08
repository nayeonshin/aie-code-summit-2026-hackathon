import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import loadMujoco from '@mujoco/mujoco';
import { build } from 'esbuild';
import { fingerprint, validateIndex, validatePartial } from './tabletop-export.mjs';

await build({ entryPoints: ['src/tabletop-physics.ts', 'src/tabletop-scenarios.ts'], bundle: true, platform: 'node', format: 'esm', outdir: 'test-results/tabletop', write: true });
const { simulateTabletop } = await import('../test-results/tabletop/tabletop-physics.js');
const { scenarios, createCollection, armStudies, durationOf, sampleHz } = await import('../test-results/tabletop/tabletop-scenarios.js');
const planArg = process.argv.find(arg => arg.startsWith('--plan='));
const plan = planArg ? JSON.parse(readFileSync(planArg.slice(7), 'utf8')) : null;
// The hand/Muse plan keeps its identity; the SO-101 studies follow it with their own fingerprint.
const base = plan ? createCollection(plan) : scenarios;
const arm = armStudies(base.length);
const collection = [...base, ...arm];
const exporting = process.argv.includes('--export');
const tasksArg = process.argv.find(arg => arg.startsWith('--tasks='));
const tasks = tasksArg?.slice(8).split(',');
const exportArg = process.argv.find(arg => arg.startsWith('--output='));
const output = exportArg?.slice(9) ?? 'data/publish';
let summaries = [];
if (exporting && tasks && existsSync(`${output}/tabletop/index.json`)) {
  const index = JSON.parse(readFileSync(`${output}/tabletop/index.json`, 'utf8'));
  const saved = JSON.parse(readFileSync(`${output}/muse/scenarios.json`, 'utf8'));
  validatePartial(index, saved, base, arm); // Must precede every trajectory write.
  summaries = index.studies.filter(s => !tasks.includes(s.task));
}
if (exporting) { mkdirSync(`${output}/tabletop`, { recursive: true }); mkdirSync(`${output}/muse`, { recursive: true }); }
const originalFetch = globalThis.fetch;
globalThis.fetch = async url => new Response(readFileSync('public' + url));
const mj = await loadMujoco();
try {
  assert.equal(scenarios.length, 100);
  assert.equal(arm.length, 25);
  assert.ok(base.every(s => s.task !== 'so101'));
  // The default export keeps the hand pilot's scope: the plan's first 100 studies, then the
  // task filter. Arm studies are added only with --all or when --tasks names so101.
  const armIds = arm.map(s => s.id);
  const selectedIds = process.argv.includes('--all') ? collection.map(s => s.id) : exporting ? [...base.slice(0, 100).map(s => s.id), ...(tasks?.includes('so101') ? armIds : [])] : [0, 1, 2, 25, 26, 27, 50, 51, 52, 75, base.length, base.length + 12];
  const ids = selectedIds.filter(id => !tasks || tasks.includes(collection[id].task));
  for (const id of ids) {
    const started = performance.now();
    const episode = await simulateTabletop(mj, collection[id]);
    const task = collection[id].task;
    assert.equal(episode.frames.length, Math.round(durationOf(task) * sampleHz) + 1);
    assert.equal(episode.metrics.finite, true, `Episode ${id} has non-finite positions`);
    assert.equal(episode.provenance.handActuators, task === 'so101' ? 6 : 20);
    assert.ok(episode.metrics.contacts > 0);
    assert.ok(episode.frames.every(f => f.positions.length === episode.geoms.length));
    assert.ok(episode.frames.every(f => f.positions.flat().every(n => Math.abs(n) < 10)), `Episode ${id} unstable`);
    const first = episode.frames[0].object, last = episode.frames.at(-1).object;
    assert.ok(Math.hypot(...last.map((n, i) => n - first[i])) > .03 || task === 'pour' || task === 'so101', `Episode ${id} object did not move`);
    if (task === 'pour') assert.ok(episode.metrics.retainedParticles > 0, `Episode ${id} did not transfer particles`);
    if (task === 'so101') {
      assert.ok(episode.metrics.retainedParticles >= 30, `Episode ${id}: SO-101 poured only ${episode.metrics.retainedParticles}/36`);
      assert.ok(episode.metrics.cupsUpright, `Episode ${id}: a cup fell over`);
      assert.ok(episode.metrics.goalDistance < .01, `Episode ${id}: cup not put back`);
      for (const frame of episode.frames.filter(f => f.holding)) assert.ok(Math.hypot(...frame.objectCenter.map((p, i) => p - frame.graspCenter[i])) < .01, `Episode ${id}: cup slipped in the jaws`);
    }
    // Palm checks apply to the five-finger hand only.
    if (task !== 'push' && task !== 'so101') for (const frame of episode.frames.filter(f => f.holding && f.time > 2 && f.time < 7)) {
      const towardObject = frame.objectCenter.map((p, i) => p - frame.palm[i]);
      assert.ok(towardObject.reduce((sum, p, i) => sum + p * frame.palmNormal[i], 0) > .08, `Episode ${id}: back of hand faces the object`);
      // The weld is compliant: allow up to 1 cm transient lag for heavy,
      // high-acceleration Muse variants, while rejecting the old ~10 cm offset.
      assert.ok(Math.hypot(...frame.objectCenter.map((p, i) => p - frame.graspCenter[i])) < .01, `Episode ${id}: object-local grip offset drifted`);
    }
    if (exporting) { const file = `episode-${String(id + 1).padStart(4, '0')}.json.gz`; writeFileSync(`${output}/tabletop/` + file, gzipSync(JSON.stringify(episode))); summaries.push({ ...episode.scenario, metrics: episode.metrics, provenance: episode.provenance, frames: episode.frames.length, file }); }
    console.log(id + 1, collection[id].task, collection[id].shape, JSON.stringify(episode.metrics), Math.round(performance.now() - started) + 'ms');
  }
  if (exporting) { summaries.sort((a, b) => a.id - b.id); const index = { plan_fingerprint: fingerprint(base), planned: base.length, arm_fingerprint: fingerprint(arm), arm_planned: arm.length, recorded: summaries.length, studies: summaries }; validateIndex(index, base, arm); writeFileSync(`${output}/tabletop/index.json`, JSON.stringify(index, null, 2)); writeFileSync(`${output}/muse/scenarios.json`, JSON.stringify(base, null, 2)); writeFileSync(`${output}/tabletop/arm-scenarios.json`, JSON.stringify(arm, null, 2)); if (plan) writeFileSync(`${output}/muse/tabletop-plan.json`, JSON.stringify(plan, null, 2)); }
} finally { globalThis.fetch = originalFetch; }
