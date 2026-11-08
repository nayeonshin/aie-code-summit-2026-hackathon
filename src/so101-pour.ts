// The SO-101 arm picks the cup on its right from the side, pours it into the cup on its
// left by rolling the wrist, and puts it back: the sequence of RAX's rax_subq.pour, run on
// the arm's published MJCF (TheRobotStudio/SO-ARM100) in MuJoCo.
//
// What is physical and what is assisted:
// - The arm is driven by its own position actuators (the MJCF's STS3215 servo model) along
//   a joint trajectory planned here by inverse kinematics; it carries the cup's real load.
// - Like RAX's own MuJoCo sim, the arm's shape does not collide. The jaws close to the cup's
//   width, and a weld between the gripper and the cup stands in for the friction grasp.
// - The cups are free rigid bodies; the water is 36 rigid beads, not a fluid.
import type { MainModule, MjModel, MjData } from '@mujoco/mujoco';
import { fetchAsset } from './asset-fetch';
import { sampleHz, so101Base, so101Pan, so101PhaseAt, so101Seconds, so101Timeline, type Scenario, type So101Phase } from './tabletop-scenarios';
import type { TableEpisode, TableFrame, TableGeom } from './tabletop-physics';

type V3 = [number, number, number];
const top = so101Base[2], beads = 36, wall = .0025, floor = .003, bead = .006;
const PAN = 0, ROLL = 4, GRIP = 5, ARM = [0, 1, 2, 3];
/** Grasp roll: the jaws open sideways (moving jaw on the robot's left), as RAX's SIDE grasp. */
const ROLL0 = Math.PI / 2;
const OPEN = 1.4;

let files: Promise<{ xml: string; files: { name: string; bytes: Uint8Array }[] }> | undefined;
async function so101Assets() {
  return files ??= (async () => {
    const manifest = JSON.parse(new TextDecoder().decode(await fetchAsset('/so101/manifest.json', 'SO-101 manifest')));
    const names: string[] = manifest.files.filter((n: string) => n.endsWith('.xml') || n.endsWith('.stl'));
    const out: { name: string; bytes: Uint8Array }[] = [];
    for (let i = 0; i < names.length; i += 6) out.push(...await Promise.all(names.slice(i, i + 6).map(async name => ({ name, bytes: await fetchAsset('/so101/' + name, 'SO-101 asset ' + name) }))));
    return { xml: new TextDecoder().decode(out.find(f => f.name === 'so101_new_calib.xml')!.bytes), files: out };
  })().catch(error => { files = undefined; throw error; });
}

const smooth = (t: number) => { const a = Math.max(0, Math.min(1, t)); return a * a * (3 - 2 * a); };
const add = (a: number[], b: number[]): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: number[], k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const norm = (a: number[]) => Math.hypot(a[0], a[1], a[2]);
/** World vector of site-frame vector ``o`` (MuJoCo's xmat is row-major). */
const rot = (R: ArrayLike<number>, o: number[]): V3 => [R[0] * o[0] + R[1] * o[1] + R[2] * o[2], R[3] * o[0] + R[4] * o[1] + R[5] * o[2], R[6] * o[0] + R[7] * o[1] + R[8] * o[2]];
const unrot = (R: ArrayLike<number>, w: number[]): V3 => [R[0] * w[0] + R[3] * w[1] + R[6] * w[2], R[1] * w[0] + R[4] * w[1] + R[7] * w[2], R[2] * w[0] + R[5] * w[1] + R[8] * w[2]];

function cupXml(name: string, pos: number[], radius: number, height: number, mass: number, friction: number) {
  const n = 16, half = Math.PI * radius / n + .0004;
  return `<body name="${name}" pos="${pos.join(' ')}"><freejoint name="${name}_free"/>
  <geom name="table_${name}_base" type="cylinder" pos="0 0 ${floor}" size="${radius} ${floor}" mass="${mass * .4}" friction="${friction} .01 .001"/>
  ${Array.from({ length: n }, (_, i) => { const a = i * 2 * Math.PI / n; return `<geom name="table_${name}_wall_${i}" type="box" pos="${(radius - wall) * Math.cos(a)} ${(radius - wall) * Math.sin(a)} ${height / 2}" quat="${Math.cos(a / 2)} 0 0 ${Math.sin(a / 2)}" size="${wall} ${half} ${height / 2}" mass="${mass * .6 / n}"/>`; }).join('')}
</body>`;
}

/** Joint-space planner for the SO-101 on a scratch MjData: damped least squares on the
 *  four arm joints for a point fixed in the fingertip frame plus the hand's pitch, with the
 *  wrist roll held, the way RAX's ``solve(arm, p, pitch, roll)`` asks. */
export class Planner {
  readonly d: MjData;
  constructor(private mj: MainModule, private m: MjModel, private site: number, private panAxis?: number[]) { this.d = new mj.MjData(m); }
  dispose() { this.d.delete(); }
  pose(q: number[]) {
    for (let i = 0; i < 6; i++) this.d.qpos[i] = q[i];
    this.mj.mj_kinematics(this.m, this.d);
    return { p: Array.from(this.d.site_xpos.slice(this.site * 3, this.site * 3 + 3)) as V3, R: Array.from(this.d.site_xmat.slice(this.site * 9, this.site * 9 + 9)) as number[] };
  }
  point(q: number[], o: number[]) { const { p, R } = this.pose(q); return add(p, rot(R, o)); }
  private error(q: number[], target: number[], o: number[], pitch: number) {
    const { p, R } = this.pose(q), w = add(p, rot(R, o));
    return [target[0] - w[0], target[1] - w[1], target[2] - w[2], .08 * (Math.sin(pitch) - R[6])];
  }
  /** Joints that put hand point ``o`` at ``target`` with the hand at ``pitch`` (radians,
   *  + up) and the wrist at ``roll``, nearest ``seed``; null if out of reach. With
   *  ``maxJump`` only a solution that close to the seed counts (no elbow flips mid-line). */
  solve(target: number[], o: number[], pitch: number, roll: number, seed: number[], maxJump = Infinity): number[] | null {
    const lo = (j: number) => this.m.jnt_range[2 * j] + .01, hi = (j: number) => this.m.jnt_range[2 * j + 1] - .01;
    const pan = Math.atan2(-(target[1] - (this.panAxis?.[1] ?? 0)), target[0] - (this.panAxis?.[0] ?? 0));
    const seeds = [seed];
    if (maxJump === Infinity) for (const a of [-1.2, -.5, .2, .9]) for (const b of [1.4, .6, -.2]) for (const c of [1.2, .4, -.4]) seeds.push([pan, a, b, c, roll, seed[5]]);
    for (const start of seeds) {
      const q = start.slice(); q[ROLL] = roll;
      for (let it = 0; it < 120; it++) {
        const e = this.error(q, target, o, pitch);
        if (Math.hypot(e[0], e[1], e[2]) < 6e-4 && Math.abs(e[3]) < .08 * .006) { if (Math.max(...ARM.map(j => Math.abs(q[j] - seed[j]))) <= maxJump) return q; break; }
        const J = e.map(() => [0, 0, 0, 0]);
        for (const j of ARM) { const keep = q[j]; q[j] += 1e-4; const f = this.error(q, target, o, pitch); q[j] = keep; for (let r = 0; r < 4; r++) J[r][j] = (e[r] - f[r]) / 1e-4; }
        // (JᵀJ + λI) dq = Jᵀe, on 4 joints
        const A = ARM.map(a => ARM.map(b => J.reduce((s, row) => s + row[a] * row[b], 0) + (a === b ? 1e-6 : 0)));
        const g = ARM.map(a => J.reduce((s, row, r) => s + row[a] * e[r], 0));
        const dq = solve4(A, g);
        const big = Math.max(...dq.map(Math.abs));
        for (const j of ARM) q[j] = Math.max(lo(j), Math.min(hi(j), q[j] + dq[j] * (big > .25 ? .25 / big : 1)));
      }
    }
    return null;
  }
}
function solve4(A: number[][], b: number[]) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export async function simulateSo101Pour(mj: MainModule, s: Scenario): Promise<TableEpisode> {
  const arm = s.arm;
  if (!arm) throw new Error('This study has no SO-101 pour parameters.');
  const assets = await so101Assets();
  const r = s.size, h = arm.cupHeight, rr = arm.receiverRadius;
  const world = `<geom name="table_surface" type="box" pos="0 0 ${top - .025}" size=".48 .32 .025" rgba=".76 .72 .63 1" friction="${s.friction} .01 .003"/>
    ${cupXml('source', [s.start[0], s.start[1], top], r, h, s.mass, s.friction)}
    ${cupXml('receiver', [s.goal[0], s.goal[1], top], rr, h, s.mass * 2, s.friction)}
    ${Array.from({ length: beads }, (_, i) => { const gx = (i % 3) - 1, gy = Math.floor(i / 3) % 3 - 1, layer = Math.floor(i / 9), step = .013;
      return `<body name="drop_${i}" pos="${s.start[0] + gx * step} ${s.start[1] + gy * step} ${top + 2 * floor + bead + .0005 + layer * .0125}"><freejoint/><geom name="table_drop_${i}" type="sphere" size="${bead}" mass=".0009" friction=".03 .001 .0001" solref=".008 1" solimp=".9 .95 .001"/></body>`; }).join('')}`;
  const xml = assets.xml
    .replace(/<mujoco model="[^"]*">/, m => `${m}<option timestep=".002" integrator="implicitfast" iterations="40"/><visual><global offwidth="64" offheight="64"/></visual>`)
    // The arm's shape does not collide (as in RAX's sim): drop its collision copies, which
    // also spares compiling convex hulls for every mesh.
    .replace(/<geom[^>]*class="collision"[^>]*\/>/g, '')
    .replace('<body name="base" pos="0 0 0"', `<body name="base" pos="${so101Base.join(' ')}"`)
    .replace('</worldbody>', world + '</worldbody>')
    .replace('<equality/>', '<equality><weld name="grasp" body1="gripper" body2="source" active="false" solref=".004 1"/></equality>');
  const vfs = new mj.MjVFS(); let model: MjModel | undefined, data: MjData | undefined, planner: Planner | undefined;
  try {
    for (const f of assets.files) if (f.name.endsWith('.stl')) vfs.addBuffer(f.name, f.bytes);
    vfs.addBuffer('so101_scene.xml', new TextEncoder().encode(xml));
    model = mj.MjModel.from_xml_path('so101_scene.xml', vfs); data = new mj.MjData(model);
    const m = model, d = data;
    const id = (type: { value: number }, name: string) => mj.mj_name2id(m, type.value, name);
    const site = id(mj.mjtObj.mjOBJ_SITE, 'gripperframe'), gripperBody = id(mj.mjtObj.mjOBJ_BODY, 'gripper');
    const sourceBody = id(mj.mjtObj.mjOBJ_BODY, 'source'), receiverBody = id(mj.mjtObj.mjOBJ_BODY, 'receiver');
    const movingJaw = Array.from({ length: m.ngeom }, (_, i) => i).find(i => m.geom_bodyid[i] === id(mj.mjtObj.mjOBJ_BODY, 'moving_jaw_so101_v1') && m.geom_group[i] === 2)!;
    planner = new Planner(mj, m, site, so101Pan);
    const P = planner;

    // ---- where the cup sits in the hand ------------------------------------------------
    // In the fingertip frame x points out of the jaws and, at the grasp roll, z points to
    // the robot's left. The fixed jaw's inner face is at z = -4 mm; the cup is held 3.5 cm
    // in from the tip, its side 3 mm off that face, and the moving jaw closes onto it.
    const cupInHand: V3 = [-.035, 0, -.004 + .003 + r];
    const jawFace = (g: number) => {
      const q = [0, 0, 0, 0, ROLL0, g]; const { p, R } = P.pose(q);
      const mp = m.geom_dataid[movingJaw], a = m.mesh_vertadr[mp], n = m.mesh_vertnum[mp];
      const gp = P.d.geom_xpos.slice(movingJaw * 3, movingJaw * 3 + 3), gR = P.d.geom_xmat.slice(movingJaw * 9, movingJaw * 9 + 9);
      let face = Infinity;
      for (let k = 0; k < n; k++) {
        const v = m.mesh_vert.slice((a + k) * 3, (a + k) * 3 + 3), w = add(gp, rot(gR, v)), o = unrot(R, [w[0] - p[0], w[1] - p[1], w[2] - p[2]]);
        if (Math.abs(o[0] - cupInHand[0]) < .006 && Math.abs(o[1]) < .012) face = Math.min(face, o[2]);
      }
      return face;
    };
    let gLo = 0, gHi = OPEN;
    for (let i = 0; i < 20; i++) { const g = (gLo + gHi) / 2; if (jawFace(g) < cupInHand[2] + r) gLo = g; else gHi = g; }
    const CLOSED = gHi;

    // ---- the plan: rax_subq.pour.pour, as joint waypoints -------------------------------
    const bearingOf = (xy: number[]) => Math.atan2(xy[1] - so101Pan[1], xy[0] - so101Pan[0]);
    const radial = (xy: number[], dr: number): [number, number] => { const b = bearingOf(xy); return [xy[0] + dr * Math.cos(b), xy[1] + dr * Math.sin(b)]; };
    const graspZ = top + arm.graspAt * h;
    const home0 = [0, -1.2, 1.1, 1.0, ROLL0, .6];
    const need = (q: number[] | null, what: string) => { if (!q) throw new Error(`The SO-101 cannot reach ${what} in study ${s.id + 1}.`); return q; };
    const home = need(P.solve([so101Pan[0] + .2, 0, top + .2], [0, 0, 0], -40 * Math.PI / 180, ROLL0, home0), 'its home pose');
    // Level if the arm can, tipped down a little if not: rax.pick's side grasp tries
    // 0..30 deg and keeps the first that reaches both the stand-off and the cup. (On the
    // SO-101 a level hand only reaches low far out; tipping the jaws down brings it in.)
    const standXY = radial(s.start, -.07);
    let pitch = 0, grasp: number[] | null = null, standHigh: number[] | null = null, standLow: number[] | null = null;
    for (const p of [0, 5, 10, 15, 20, 25, 30].map(v => -v * Math.PI / 180)) {
      grasp = P.solve([...s.start, graspZ], cupInHand, p, ROLL0, home);
      standLow = grasp && P.solve([...standXY, graspZ], cupInHand, p, ROLL0, grasp);
      standHigh = standLow && P.solve([...standXY, top + h + .05], cupInHand, p, ROLL0, standLow);
      if (grasp && standLow && standHigh) { pitch = p; break; }
    }
    grasp = need(grasp, 'the right cup from the side'); standLow = need(standLow, 'its stand-off pose'); standHigh = need(standHigh, 'its stand-off pose');
    // The pour: the hand keeps the grasp's pitch and only the wrist rolls (pour.py holds
    // every other joint, and re-reads none, so the arm's sag under the cup is not chased).
    // Aim the lowest point of the tipped cup's rim over the left cup, ``gap`` above its rim
    // and ``lead`` past its centre: the geometric form of pour.py's height/offset/back.
    // Beads start to run out once the cup is about level (``flow``); from there they roll
    // down its wall and leave the lip fast, so the lip is aimed then, ``lead`` short of the
    // left cup's centre (towards the hand) and ``gap`` over its rim, and the wrist keeps
    // rolling to ``tilt`` to empty it.
    const rollFlow = ROLL0 - arm.flow, rollT = ROLL0 - arm.tilt;
    const axisInHand = unrot(P.pose(grasp).R, [0, 0, 1]);              // the cup's axis, in the hand
    const centreInHand = cupInHand;
    const mouthInHand = add(centreInHand, scale(axisInHand, h - arm.graspAt * h));
    let lipInHand: V3 = mouthInHand;
    const sideOf = (xy: number[]) => { const b = bearingOf(xy); return [-Math.sin(b), Math.cos(b)]; };   // robot's left
    let flowPose: number[] | null = null;
    for (let pass = 0; pass < 3; pass++) {
      // ``lead`` is measured towards whichever side the hand ends up on
      const left = sideOf(s.goal), hand = flowPose ? P.pose(flowPose).p : null;
      const handSide = hand ? Math.sign((hand[0] - s.goal[0]) * left[0] + (hand[1] - s.goal[1]) * left[1]) || 1 : 1;
      const aim = [s.goal[0] + handSide * arm.lead * left[0], s.goal[1] + handSide * arm.lead * left[1], top + h + arm.gap];
      flowPose = need(P.solve(aim, lipInHand, pitch, rollFlow, flowPose ?? standHigh), 'the pour spot over the left cup');
      // the lowest point of the mouth's rim at that roll, in the hand frame
      const down = unrot(P.pose(flowPose).R, [0, 0, -1]);
      const along = down[0] * axisInHand[0] + down[1] * axisInHand[1] + down[2] * axisInHand[2];
      const across = add(down, scale(axisInHand, -along)), k = norm(across);
      lipInHand = add(mouthInHand, scale(across, r / k));
    }
    let over: number[] = need(flowPose, 'the pour spot');
    const overLevel = over.slice(); overLevel[ROLL] = ROLL0;
    const overTip = over.slice(); overTip[ROLL] = rollT;
    // carry high enough that the held cup clears the left one
    const bottomOverZ = P.point(overLevel, add(centreInHand, scale(axisInHand, -arm.graspAt * h)))[2];
    const carryZ = Math.max(bottomOverZ, top + h) + .03;
    const centreOver = P.point(overLevel, centreInHand);
    const lift = need(P.solve([...s.start, carryZ + arm.graspAt * h], cupInHand, pitch, ROLL0, grasp), 'the lift pose');
    const overHigh = need(P.solve([centreOver[0], centreOver[1], P.point(lift, centreInHand)[2]], centreInHand, pitch, ROLL0, overLevel), 'the carry pose');
    const place = need(P.solve([...s.start, graspZ + .004], cupInHand, pitch, ROLL0, grasp), 'the put-back pose');
    const placeHigh = lift;

    // A straight line of the held point, solved every sample (RAX's straight_down / reach).
    type Seg = { name: So101Phase; q: (u: number, prev: number[]) => number[]; grip: (u: number) => number };
    const joint = (a: number[], b: number[]) => (u: number) => a.map((v, i) => v + (b[i] - v) * smooth(u));
    const line = (a: number[], b: number[], o: number[], p: number, roll: number) => {
      const pa = P.point(a, o), pb = P.point(b, o);
      return (u: number, prev: number[]) => { const k = smooth(u); return P.solve(pa.map((v, i) => v + (pb[i] - v) * k), o, p, roll, prev, .3) ?? joint(a, b)(u); };
    };
    const hold = (q: number[]) => () => q.slice();
    const lerp = (a: number, b: number) => (u: number) => a + (b - a) * smooth(u);
    const plan: Record<So101Phase, Seg> = {
      home: { name: 'home', q: hold(home), grip: lerp(.6, OPEN) },
      stand: { name: 'stand', q: joint(home, standHigh), grip: () => OPEN },
      down: { name: 'down', q: line(standHigh, standLow, cupInHand, pitch, ROLL0), grip: () => OPEN },
      reach: { name: 'reach', q: line(standLow, grasp, cupInHand, pitch, ROLL0), grip: () => OPEN },
      close: { name: 'close', q: hold(grasp), grip: lerp(OPEN, CLOSED) },
      lift: { name: 'lift', q: line(grasp, lift, cupInHand, pitch, ROLL0), grip: () => CLOSED },
      carry: { name: 'carry', q: joint(lift, overHigh), grip: () => CLOSED },
      settle: { name: 'settle', q: line(overHigh, overLevel, centreInHand, pitch, ROLL0), grip: () => CLOSED },
      tip: { name: 'tip', q: (u: number) => { const q = overLevel.slice(); q[ROLL] = u < .6 ? ROLL0 + (rollFlow - ROLL0) * smooth(u / .6) : rollFlow + (rollT - rollFlow) * smooth((u - .6) / .4); return q; }, grip: () => CLOSED },
      hold: { name: 'hold', q: hold(overTip), grip: () => CLOSED },
      untip: { name: 'untip', q: joint(overTip, overLevel), grip: () => CLOSED },
      raise: { name: 'raise', q: line(overLevel, overHigh, centreInHand, pitch, ROLL0), grip: () => CLOSED },
      back: { name: 'back', q: joint(overHigh, placeHigh), grip: () => CLOSED },
      lower: { name: 'lower', q: line(placeHigh, place, cupInHand, pitch, ROLL0), grip: () => CLOSED },
      release: { name: 'release', q: hold(place), grip: lerp(CLOSED, OPEN) },
      retreat: { name: 'retreat', q: line(place, standLow, cupInHand, pitch, ROLL0), grip: () => OPEN },
      rest: { name: 'rest', q: joint(standLow, home), grip: lerp(OPEN, .6) },
    };
    const samples = Math.round(so101Seconds * sampleHz);
    const qs: number[][] = [];
    let prev = home.slice();
    for (let k = 0; k <= samples; k++) {
      const t = Math.min(k / sampleHz, so101Seconds - 1e-6), ph = so101PhaseAt(t), seg = plan[ph.name], u = (t - ph.start) / (ph.end - ph.start);
      const q = seg.q(u, prev); q[GRIP] = seg.grip(u); qs.push(q); prev = q;
    }
    const startOf = (phase: So101Phase) => { let t = 0; for (const [name, seconds] of so101Timeline) { if (name === phase) return t; t += seconds; } return t; };
    const holdFrom = startOf('close') + .55, holdTo = startOf('release') + .05;   // jaws shut .. jaws start to open

    // ---- what the page draws --------------------------------------------------------------
    const meshCache = new Map<number, { vertices: number[]; faces: number[] }>();
    const hex = (c: ArrayLike<number>) => '#' + [0, 1, 2].map(i => Math.round(Math.max(0, Math.min(1, c[i])) * 255).toString(16).padStart(2, '0')).join('');
    const geoms: TableGeom[] = [];
    for (let i = 0; i < m.ngeom; i++) {
      const name = mj.mj_id2name(m, mj.mjtObj.mjOBJ_GEOM.value, i) ?? '';
      if (m.geom_type[i] === mj.mjtGeom.mjGEOM_MESH.value && m.geom_group[i] === 2) {
        const mid = m.geom_dataid[i];
        if (!meshCache.has(mid)) meshCache.set(mid, { vertices: Array.from(m.mesh_vert.slice(m.mesh_vertadr[mid] * 3, (m.mesh_vertadr[mid] + m.mesh_vertnum[mid]) * 3)), faces: Array.from(m.mesh_face.slice(m.mesh_faceadr[mid] * 3, (m.mesh_faceadr[mid] + m.mesh_facenum[mid]) * 3)) });
        const mat = m.geom_matid[i], rgba = mat >= 0 ? m.mat_rgba.slice(mat * 4, mat * 4 + 4) : m.geom_rgba.slice(i * 4, i * 4 + 4);
        geoms.push({ id: i, type: 'mesh', size: [], color: rgba[0] > .5 ? '#e2b33c' : '#2f3231', mesh: meshCache.get(mid) });
      } else if (name.startsWith('table_')) {
        const type = m.geom_type[i] === mj.mjtGeom.mjGEOM_BOX.value ? 'box' : m.geom_type[i] === mj.mjtGeom.mjGEOM_SPHERE.value ? 'sphere' : 'cylinder';
        geoms.push({ id: i, type, size: Array.from(m.geom_size.slice(i * 3, i * 3 + 3)), color: name.includes('drop') ? '#69aeca' : name.includes('receiver') ? '#a0b6a6' : name.includes('surface') ? '#c7bfae' : s.color });
      }
    }

    // ---- run it ---------------------------------------------------------------------------
    for (let i = 0; i < 6; i++) { d.qpos[i] = home[i]; d.ctrl[i] = home[i]; }
    d.qpos[GRIP] = d.ctrl[GRIP] = .6;
    mj.mj_forward(m, d);
    const frames: TableFrame[] = []; let contacts = 0, tracking = 0, welded = false;
    const relPose = () => {
      // the cup's pose in the gripper's frame: the weld then holds it where the jaws are
      const R1: number[] = d.xmat.slice(gripperBody * 9, gripperBody * 9 + 9), p1 = d.xpos.slice(gripperBody * 3, gripperBody * 3 + 3), p2 = d.xpos.slice(sourceBody * 3, sourceBody * 3 + 3);
      const rel = unrot(R1, [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]]);
      const [a0, a1, a2, a3] = d.xquat.slice(gripperBody * 4, gripperBody * 4 + 4), [b0, b1, b2, b3] = d.xquat.slice(sourceBody * 4, sourceBody * 4 + 4);
      // conj(q1) * q2
      const qr = [a0 * b0 + a1 * b1 + a2 * b2 + a3 * b3, a0 * b1 - a1 * b0 - a2 * b3 + a3 * b2, a0 * b2 + a1 * b3 - a2 * b0 - a3 * b1, a0 * b3 - a1 * b2 + a2 * b1 - a3 * b0];
      m.eq_data.set([0, 0, 0, ...rel, ...qr, 1], 0);
    };
    for (let k = 0; k <= samples; k++) {
      const end = k / sampleHz;
      while (d.time + 1e-8 < end) {
        const f = d.time * sampleHz, i0 = Math.min(Math.floor(f), samples), i1 = Math.min(i0 + 1, samples), w = f - i0;
        for (let j = 0; j < 6; j++) d.ctrl[j] = qs[i0][j] + (qs[i1][j] - qs[i0][j]) * w;
        const holding = d.time >= holdFrom && d.time < holdTo;
        if (holding && !welded) { mj.mj_kinematics(m, d); relPose(); }
        welded = holding; d.eq_active[0] = holding ? 1 : 0;
        mj.mj_step(m, d); contacts = Math.max(contacts, d.ncon);
      }
      mj.mj_forward(m, d);
      tracking = Math.max(tracking, ...ARM.map(j => Math.abs(d.qpos[j] - qs[k][j])));
      const R = d.xmat.slice(gripperBody * 9, gripperBody * 9 + 9), palm = Array.from(d.xpos.slice(gripperBody * 3, gripperBody * 3 + 3)) as number[];
      const S = d.site_xmat.slice(site * 9, site * 9 + 9), tip = d.site_xpos.slice(site * 3, site * 3 + 3);
      const object = Array.from(d.xpos.slice(sourceBody * 3, sourceBody * 3 + 3)) as number[], oR = d.xmat.slice(sourceBody * 9, sourceBody * 9 + 9);
      frames.push({ time: end, positions: geoms.map(g => Array.from(d.geom_xpos.slice(g.id * 3, g.id * 3 + 3))), rotations: geoms.map(g => Array.from(d.geom_xmat.slice(g.id * 9, g.id * 9 + 9))), contacts: d.ncon,
        object, objectCenter: add(object, rot(oR, [0, 0, arm.graspAt * h])), palm, palmNormal: [R[2], R[5], R[8]], graspCenter: add(Array.from(tip) as number[], rot(S, cupInHand)), holding: !!d.eq_active[0] });
    }

    // ---- where the water went ---------------------------------------------------------------
    const inCup = (body: number, radius: number, p: ArrayLike<number>) => {
      const c = d.xpos.slice(body * 3, body * 3 + 3), Rb = d.xmat.slice(body * 9, body * 9 + 9), o = unrot(Rb, [p[0] - c[0], p[1] - c[1], p[2] - c[2]]);
      return Math.hypot(o[0], o[1]) < radius - wall && o[2] > 0 && o[2] < h + .01;
    };
    let retained = 0, source = 0;
    for (let i = 0; i < beads; i++) { const p = d.xpos.slice(id(mj.mjtObj.mjOBJ_BODY, 'drop_' + i) * 3, id(mj.mjtObj.mjOBJ_BODY, 'drop_' + i) * 3 + 3); if (inCup(receiverBody, rr, p)) retained++; else if (inCup(sourceBody, r, p)) source++; }
    const last = frames[frames.length - 1], finite = frames.every(f => f.positions.flat().every(Number.isFinite));
    const sourceUp = d.xmat[sourceBody * 9 + 8], receiverUp = d.xmat[receiverBody * 9 + 8];
    return { scenario: s, geoms, frames,
      metrics: { finite, contacts, goalDistance: Math.hypot(last.object[0] - s.start[0], last.object[1] - s.start[1]), retainedParticles: retained, totalParticles: beads, sourceParticles: source, spilledParticles: beads - retained - source,
        cupsUpright: sourceUp > .95 && receiverUp > .95, trackingError: tracking, tilt: arm.tilt * 180 / Math.PI, graspPitch: pitch * 180 / Math.PI },
      provenance: { runtime: 'MuJoCo 4 / browser WASM', controller: 'RAX rax_subq.pour sequence (side grasp, carry, wrist-roll pour, put back); DLS inverse kinematics on the SO-101 MJCF; STS3215 position actuators; weld-assisted hold', fluid: '36 discrete rigid particles; not continuum water', timestep: .002,
        hand: 'SO-101 arm, TheRobotStudio/SO-ARM100 so101_new_calib.xml (Apache-2.0); arm geometry non-colliding, as in RAX\'s MuJoCo sim', handActuators: m.nu } };
  } finally { planner?.dispose(); data?.delete(); model?.delete(); vfs.delete(); }
}
