import loadMujoco, { type MainModule, type MjModel, type MjData } from '@mujoco/mujoco';
import wasmUrl from '@mujoco/mujoco/mujoco.wasm?url';
import { recipes, plan, randomGenerator, type Variant } from './objectives';
import type { Description, State } from './renderer';

export type Episode = { episode_id: number; seed: number; recipe: string; seconds: number; parameters: object; time: number[]; qpos: number[][]; qvel: number[][]; ctrl: number[][]; actuator_force: number[][]; external_force: number[][]; contacts: number[]; valid: boolean; objective_pass: boolean; warnings: number; tracking_rmse: number; settled_tracking_rmse: number; joint_limit_error: number; peak_velocity: number; mean_abs_acceleration: number };
const matrix = (array: ArrayLike<number>, width: number) => Array.from({ length: array.length / width }, (_, i) => Array.from({ length: width }, (_, j) => array[i * width + j]));

export class WasmEngine {
  constructor(public mj: MainModule, public model: MjModel, public provenance: Record<string, unknown>) {}
  static async create() {
    const binaryResponse = await fetch(wasmUrl + '.gz', { signal: AbortSignal.timeout(90000) });
    if (!binaryResponse.ok || !binaryResponse.body) throw new Error('Physics module failed to download.');
    const wasmBinary = new Uint8Array(await new Response(binaryResponse.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    const mj = await loadMujoco({ wasmBinary, locateFile: (path: string) => path.endsWith('.wasm') ? wasmUrl : path });
    const manifest = await (await fetch('/model/manifest.json')).json();
    const vfs = new mj.MjVFS();
    try {
      await Promise.all(manifest.files.filter((file: string) => file.endsWith('.xml') || file.endsWith('.obj')).map(async (file: string) => {
        const response = await fetch('/model/' + file);
        if (!response.ok) throw new Error('Robot asset failed to load: ' + file);
        vfs.addBuffer(file, new Uint8Array(await response.arrayBuffer()));
      }));
      const model = mj.MjModel.from_xml_path('right_hand.xml', vfs);
      model.opt.timestep = .002;
      return new WasmEngine(mj, model, { ...manifest.provenance, mujoco_version: mj.mj_versionString(), runtime: 'browser-wasm', rng: 'mulberry32-v1', recipe_version: plan.version, controller_version: 'browser-controller-2.1', sample_hz: 30, physics_dt: .002 });
    } finally { vfs.delete(); }
  }
  description(): Description {
    const m = this.model;
    const meshes = Array.from({ length: m.nmesh }, (_, i) => ({
      vertices: Array.from(m.mesh_vert.slice(m.mesh_vertadr[i] * 3, (m.mesh_vertadr[i] + m.mesh_vertnum[i]) * 3)) as number[],
      faces: Array.from(m.mesh_face.slice(m.mesh_faceadr[i] * 3, (m.mesh_faceadr[i] + m.mesh_facenum[i]) * 3)) as number[],
    }));
    const geoms = Array.from({ length: m.ngeom }, (_, id) => {
      const name = this.mj.mj_id2name(m, this.mj.mjtObj.mjOBJ_GEOM.value, id);
      return { id, mesh: m.geom_dataid[id], name, tip: name.includes('tip') };
    }).filter(g => m.geom_type[g.id] === this.mj.mjtGeom.mjGEOM_MESH.value);
    return { meshes, geoms, recipes };
  }
  simulation(recipe: string, seed: number, variant?: Variant) { return new BrowserSimulation(this, recipe, seed, variant); }
  replay(qpos: number[]) {
    const data = new this.mj.MjData(this.model);
    try { data.qpos.set(qpos); this.mj.mj_forward(this.model, data); return this.state(data); }
    finally { data.delete(); }
  }
  state(data: MjData): State {
    return { time: data.time, positions: matrix(data.geom_xpos, 3), rotations: matrix(data.geom_xmat, 9), qpos: Array.from(data.qpos), qvel: Array.from(data.qvel), ctrl: Array.from(data.ctrl), contacts: data.ncon };
  }
  dispose() { this.model.delete(); }
}

export class BrowserSimulation {
  data: MjData;
  initial: number[];
  speed: number; amplitude: number; phase: number;
  sample = 0;
  constructor(public engine: WasmEngine, public recipe: string, public seed: number, variant?: Variant) {
    this.data = new engine.mj.MjData(engine.model);
    const random = randomGenerator(seed);
    const speedRandom = random(), amplitudeRandom = random(), phaseRandom = random();
    // AI proposals are diverse anchors, not a tiny set of repeated trajectories.
    // Seeded bounded jitter preserves continuous variation within each anchor.
    this.speed = variant ? Math.max(.3, Math.min(1.5, variant.speed * (.85 + speedRandom * .3))) : .7 + speedRandom * .6;
    this.amplitude = variant ? Math.max(.4, Math.min(1, variant.amplitude * (.9 + amplitudeRandom * .2))) : .65 + amplitudeRandom * .35;
    this.phase = variant ? (variant.phase + (phaseRandom - .5) * .5 + Math.PI * 2) % (Math.PI * 2) : phaseRandom * Math.PI * 2;
    this.initial = Array.from({ length: 16 }, () => -.03 + random() * .06);
    this.data.qpos.set(this.initial); this.data.ctrl.set(this.initial);
    engine.mj.mj_forward(engine.model, this.data);
  }
  targets(time: number) {
    const t = time * this.speed, pulse = (1 - Math.cos(t * 1.7 + this.phase)) / 2;
    let curls = [0, 0, 0, 0]; let spread = [0, 0, 0];
    switch (this.recipe) {
      case 'flex': curls.fill(pulse); break;
      case 'point': curls = [0, pulse, pulse, pulse * .7]; break;
      case 'pinch': curls = [pulse * .7, .12, .12, pulse * .8]; break;
      case 'wave': curls = curls.map((_, i) => (1 - Math.cos(t * 2.2 - i * .8 + this.phase)) / 2); break;
      case 'tripod': curls = [pulse * .7, pulse * .7, .1, pulse * .8]; break;
      case 'spread': spread = [-pulse * .5, 0, pulse * .5]; curls.fill(.08); break;
      case 'sequence': curls = curls.map((_, i) => Math.exp(-((Math.sin(t * 1.1 + this.phase) * 1.5 + 1.5 - i) ** 2) / .35)); break;
      case 'opposition': curls = [.25 * pulse, .2, .2, pulse]; spread[0] = pulse * .25; break;
      case 'roll': curls = curls.map((_, i) => .35 + .25 * Math.sin(t * 1.8 + i * 1.4 + this.phase)); break;
      case 'hold': case 'recovery': curls.fill(.45); break;
      case 'precision': curls.fill(.08 + .08 * pulse); break;
      case 'reversal': curls.fill((1 - Math.cos(t * .9)) / 2); break;
      case 'independent': curls[this.seed % 4] = pulse; break;
    }
    const target = curls.slice(0, 3).flatMap((c, i) => [c * 1.45, spread[i], c * 1.3, c * 1.1]);
    target.push(curls[3] * .8, curls[3] * .5, curls[3] * 1.2, curls[3] * .75);
    let blend = Math.min(time / .6, 1); blend = blend * blend * (3 - 2 * blend);
    return target.map((v, i) => Math.max(this.engine.model.actuator_ctrlrange[i * 2], Math.min(this.engine.model.actuator_ctrlrange[i * 2 + 1], this.initial[i] * (1 - blend) + v * this.amplitude * blend)));
  }
  advance() {
    const { mj, model } = this.engine;
    const end = ++this.sample / 30;
    while (this.data.time + 1e-10 < end) {
      this.data.ctrl.set(this.targets(this.data.time)); this.data.qfrc_applied.fill(0);
      if (this.recipe === 'recovery' && [6, 12].some(t => t <= this.data.time && this.data.time < t + .2)) this.data.qfrc_applied[this.seed % 16] = .015;
      mj.mj_step(model, this.data);
    }
    mj.mj_forward(model, this.data);
  }
  state() { return this.engine.state(this.data); }
  dispose() { this.data.delete(); }
  record(seconds: number, episodeId: number): Episode {
    const time: number[] = [], qpos: number[][] = [], qvel: number[][] = [], ctrl: number[][] = [], actuator_force: number[][] = [], external_force: number[][] = [], contacts: number[] = [];
    let limit = 0, error = 0, settledError = 0, settledCount = 0, peak = 0, acceleration = 0, finite = true;
    for (let frame = 0; frame < Math.round(seconds * 30); frame++) {
      this.advance(); const d = this.data;
      const p = Array.from(d.qpos, Math.fround), v = Array.from(d.qvel, Math.fround), c = Array.from(d.ctrl, Math.fround), f = Array.from(d.actuator_force, Math.fround);
      time.push(d.time); qpos.push(p); qvel.push(v); ctrl.push(c); actuator_force.push(f); external_force.push(Array.from(d.qfrc_applied, Math.fround)); contacts.push(d.ncon);
      for (let j = 0; j < 16; j++) {
        finite &&= [p[j], v[j], c[j], f[j]].every(Number.isFinite);
        const e = (p[j] - c[j]) ** 2; error += e;
        if (d.time >= 1) { settledError += e; settledCount++; }
        peak = Math.max(peak, Math.abs(v[j]));
        limit = Math.max(limit, this.engine.model.jnt_range[j * 2] - p[j], p[j] - this.engine.model.jnt_range[j * 2 + 1]);
        if (frame > 0) acceleration += Math.abs(v[j] - qvel[frame - 1][j]) * 30;
      }
    }
    const warningsVector = this.data.warning;
    let warnings = 0;
    // Borrowed member of MjData, not an owned copy. Deleting this vector corrupts
    // MjData's allocation and double-frees it when the episode is disposed.
    for (let i = 0; i < warningsVector.size(); i++) warnings += warningsVector.get(i)!.number;
    const valid = finite && warnings === 0 && limit < .1;
    const settled = Math.sqrt(settledError / Math.max(settledCount, 1));
    return { episode_id: episodeId, seed: this.seed, recipe: this.recipe, seconds, parameters: { speed: this.speed, amplitude: this.amplitude, phase: this.phase, initial: this.initial }, time, qpos, qvel, ctrl, actuator_force, external_force, contacts,
      valid, objective_pass: valid && settled <= .08, warnings, tracking_rmse: Math.sqrt(error / (time.length * 16)), settled_tracking_rmse: settled,
      joint_limit_error: limit, peak_velocity: peak, mean_abs_acceleration: acceleration / Math.max((time.length - 1) * 16, 1) };
  }
}
