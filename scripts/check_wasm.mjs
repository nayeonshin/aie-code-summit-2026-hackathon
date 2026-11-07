// Regression check for model loading, repeated MjData ownership, and warning views.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import loadMujoco from '@mujoco/mujoco';
import { build } from 'esbuild';
await build({ entryPoints: ['src/wasm-engine.ts'], bundle: true, platform: 'node', format: 'esm', outfile: 'test-results/wasm-engine.mjs', external: ['@mujoco/mujoco'], plugins: [{ name: 'node-wasm-url', setup(b) {
  b.onResolve({ filter: /mujoco\.wasm\?url$/ }, () => ({ path: 'wasm-url', namespace: 'test-stub' }));
  b.onLoad({ filter: /.*/, namespace: 'test-stub' }, () => ({ contents: 'export default ""', loader: 'js' }));
} }] });
const { WasmEngine } = await import('../test-results/wasm-engine.mjs');
const mj = await loadMujoco();
const vfs = new mj.MjVFS();
const manifest = JSON.parse(readFileSync('public/model/manifest.json', 'utf8'));
for (const file of manifest.files.filter(f => f.endsWith('.xml') || f.endsWith('.obj'))) vfs.addBuffer(file, new Uint8Array(readFileSync('public/model/' + file)));
const model = mj.MjModel.from_xml_path('right_hand.xml', vfs);
try {
  assert.equal(model.nq, 16);
  for (let episode = 0; episode < 20; episode++) {
    const data = new mj.MjData(model);
    try {
      for (let i = 0; i < 100; i++) mj.mj_step(model, data);
      const warnings = data.warning; // Borrowed: do not delete before data.
      assert.equal(warnings.get(0).number, 0);
      assert.ok([...data.qpos].every(Number.isFinite));
    } finally { data.delete(); }
  }
  const engine = new WasmEngine(mj, model, {});
  for (const recipe of ['flex', 'point', 'pinch', 'wave', 'tripod', 'spread', 'sequence', 'opposition', 'roll', 'hold', 'precision', 'reversal', 'independent', 'recovery']) {
    const sim = engine.simulation(recipe, 42);
    try {
      const row = sim.record(20, 0);
      assert.equal(row.time.length, 600);
      assert.ok(row.valid, recipe);
       assert.ok(row.objective_pass, recipe);
       const replay = engine.replayRecorded(row, 15);
       for (const field of ['time', 'qpos', 'qvel', 'ctrl', 'contacts', 'actuator_force', 'external_force']) assert.deepEqual(replay[field], row[field][15]);
       const measured = engine.replayRecorded({ ...row, contacts: row.contacts.map(() => 7) }, 15);
        assert.equal(measured.contacts, 7); // Forward kinematics must not replace saved contact measurements.
        const { external_force, ...legacy } = row;
        const legacyReplay = engine.replayRecorded(legacy, 15);
        assert.equal(legacyReplay.external_force, null);
        for (const field of ['qvel', 'ctrl', 'contacts', 'actuator_force']) assert.deepEqual(legacyReplay[field], row[field][15]);
      if (recipe === 'recovery') assert.ok(row.external_force.some(f => f.some(v => v !== 0)));
    } finally { sim.dispose(); }
  }
  const anchor = { objective: 'flex', speed: 1, amplitude: .8, phase: 1 };
  const a = engine.simulation('flex', 42, anchor), b = engine.simulation('flex', 42, anchor), c = engine.simulation('flex', 43, anchor);
  try {
    assert.equal(a.speed, b.speed);
    assert.notEqual(a.speed, c.speed);
    assert.ok(a.speed >= .85 && a.speed <= 1.15);
    assert.ok(a.amplitude >= .72 && a.amplitude <= .88);
  } finally { a.dispose(); b.dispose(); c.dispose(); }
  console.log('WASM model + repeated episode disposal passed:', mj.mj_versionString());
} finally { model.delete(); vfs.delete(); }
