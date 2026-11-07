import type { MainModule, MjModel, MjData } from '@mujoco/mujoco';
import { fetchAsset } from './asset-fetch';
import { duration, sampleHz, type Scenario } from './tabletop-scenarios';
import { calibrateGrasp, rotateY, graspController } from './grasp';

export type TableGeom = { id: number; type: 'mesh' | 'box' | 'sphere' | 'cylinder'; size: number[]; color: string; mesh?: { vertices: number[]; faces: number[] } };
export type TableFrame = { time: number; positions: number[][]; rotations: number[][]; contacts: number; object: number[]; objectCenter: number[]; palm: number[]; palmNormal: number[]; graspCenter: number[]; holding: boolean };
export type TableEpisode = { scenario: Scenario; geoms: TableGeom[]; frames: TableFrame[]; metrics: { finite: boolean; contacts: number; goalDistance: number; retainedParticles?: number; totalParticles?: number }; provenance: { runtime: string; controller: string; fluid: string; timestep: number; hand: string; handActuators: number } };
let robotFiles: Promise<{ xml: string; files: { name: string; bytes: Uint8Array }[] }> | undefined;
async function robotAssets() {
  return robotFiles ??= (async () => {
    const manifest = JSON.parse(new TextDecoder().decode(await fetchAsset('/model/manifest.json', 'Robot manifest')));
    const names: string[] = manifest.files.filter((name: string) => name.endsWith('.xml') || name.endsWith('.obj'));
    const files = [];
    for (let i = 0; i < names.length; i += 6) files.push(...await Promise.all(names.slice(i, i + 6).map(async name => ({ name, bytes: await fetchAsset('/model/' + name, 'Robot asset ' + name) }))));
    return { xml: new TextDecoder().decode(files.find(f => f.name === 'right_hand.xml')!.bytes), files };
  })().catch(error => { robotFiles = undefined; throw error; });
}
const top = .72, beads = 36;
const smooth = (t: number) => { const a = Math.max(0, Math.min(1, t)); return a * a * (3 - 2 * a); };
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const cup = (name: string, pos: number[], free: boolean) => `<body name="${name}" pos="${pos.join(' ')}">${free ? '<freejoint/>' : ''}
  <geom name="table_${name}_base" type="cylinder" size=".049 .004" mass=".035"/>
  ${Array.from({ length: 16 }, (_, i) => { const a = i * Math.PI / 8; return `<geom name="table_${name}_wall_${i}" type="box" pos="${.049 * Math.cos(a)} ${.049 * Math.sin(a)} .046" quat="${Math.cos(a / 2)} 0 0 ${Math.sin(a / 2)}" size=".004 .010 .046" mass=".005"/>`; }).join('')}
</body>`;

export async function simulateTabletop(mj: MainModule, scenario: Scenario): Promise<TableEpisode> {
  const assets = await robotAssets(), s = scenario, pouring = s.task === 'pour';
  const objectZ = top + (pouring ? .004 : s.size);
  const shape = s.shape === 'cube' ? 'box' : s.shape;
  const size = s.shape === 'cube' ? `${s.size} ${s.size} ${s.size}` : s.shape === 'sphere' ? `${s.size}` : `${s.size} ${s.size}`;
  // Mocap wrist + temporary weld are an explicit assisted handling controller.
  // The object becomes a freely simulated rigid body on release; push uses contact only.
  const ring = assets.xml.split('<worldbody>')[1]?.split('<!-- ring -->')[1];
  if (!ring) throw new Error('The source model is missing the ring-finger template.');
  const littleFinger = ring.replace(/rf_/g, 'lf_').replace('pos="-0.00709 -0.0678 -0.0187"', 'pos="-0.00709 -0.1132 -0.0187"');
  const fiveFingerXml = assets.xml.replace('<body name="th_mp"', littleFinger + '<body name="th_mp"').replace('</actuator>', '<position name="lf_mcp_act" joint="lf_mcp" class="mcp"/><position name="lf_rot_act" joint="lf_rot" class="rot"/><position name="lf_pip_act" joint="lf_pip" class="pip"/><position name="lf_dip_act" joint="lf_dip" class="dip"/></actuator>');
  let xml = fiveFingerXml.replace(/<option[^>]*\/>/, '<option timestep=".004" integrator="implicitfast" gravity="0 0 -9.81" iterations="40"/>')
    .replace(/solimp="[^"]*"/, 'solimp=".9 .95 .001"').replace(/solref="[^"]*"/, 'solref=".015 1"')
    .replace('<body name="palm" pos="0 0 0.1" quat="0 1 0 0">', '<body name="palm" mocap="true" pos="-.2 -.18 1" quat="0 1 0 0">')
    .replace(/<geom\b([^>]*)\/>/g, (_, attrs: string) => `<geom${attrs.replace(/\s(contype|conaffinity)="[^"]*"/g, '')} contype="0" conaffinity="0"/>`);
  const world = `<geom name="table_surface" type="box" pos="0 0 .695" size=".48 .32 .025" rgba=".76 .72 .63 1" condim="6" friction="${s.friction} .01 .003" solref=".015 1"/>
    <geom name="table_edge_left" type="box" pos="-.475 0 .735" size=".005 .32 .015"/>
    <geom name="table_edge_right" type="box" pos=".475 0 .735" size=".005 .32 .015"/>
    <geom name="table_edge_back" type="box" pos="0 .315 .735" size=".47 .005 .015"/>
    <geom name="table_edge_front" type="box" pos="0 -.315 .735" size=".47 .005 .015"/>
    <body name="carrier" mocap="true" pos="${s.start[0]} ${s.start[1]} ${objectZ}"><geom name="hidden_carrier" type="sphere" size=".001" contype="0" conaffinity="0"/></body>
    <body name="pusher" mocap="true" pos="-.4 0 .76"><geom name="table_pusher" type="box" size=".012 .045 .025" friction="1 .01 .001" solref=".015 1"/></body>
    ${pouring ? cup('object', [...s.start, objectZ], true) + cup('receiver', [...s.goal, top + .004], false) : `<body name="object" pos="${s.start.join(' ')} ${objectZ}"><freejoint/><geom name="table_object" type="${shape}" size="${size}" mass="${s.mass}" friction="${s.friction} .01 .001" solref=".015 1"/></body>`}
    ${s.task === 'stack' ? `<geom name="table_pedestal" type="cylinder" pos="${s.goal.join(' ')} ${top + .032}" size=".058 .032" friction="1 .01 .001" solref=".015 1"/>` : ''}
    ${pouring ? Array.from({ length: beads }, (_, i) => `<body name="drop_${i}" pos="${s.start[0] + ((i % 4) - 1.5) * .016} ${s.start[1] + ((Math.floor(i / 4) % 3) - 1) * .016} ${top + .019 + Math.floor(i / 12) * .014}"><freejoint/><geom name="table_drop_${i}" type="sphere" size=".006" mass=".0009" friction=".03 .001 .0001" solref=".012 1" solimp=".9 .95 .001"/></body>`).join('') : ''}`;
  const collidableWorld = world.replace(/<geom\b([^>]*)\/>/g, (_, attrs: string) => attrs.includes('hidden_carrier') ? `<geom${attrs}/>` : `<geom${attrs} contype="1" conaffinity="1"/>`);
  xml = xml.replace('</worldbody>', collidableWorld + '</worldbody>').replace('</mujoco>', '<equality><weld name="assist" body1="carrier" body2="object" active="false" solref=".012 1"/></equality></mujoco>');
  const vfs = new mj.MjVFS(); let model: MjModel | undefined, data: MjData | undefined;
  try {
    for (const f of assets.files) if (f.name.endsWith('.obj')) vfs.addBuffer(f.name, f.bytes);
    vfs.addBuffer('tabletop.xml', new TextEncoder().encode(xml));
    model = mj.MjModel.from_xml_path('tabletop.xml', vfs); data = new mj.MjData(model);
    const m = model, d = data;
    const id = (type: any, name: string) => mj.mj_name2id(m, type.value, name);
    const objectBody = id(mj.mjtObj.mjOBJ_BODY, 'object');
    const palm = m.body_mocapid[id(mj.mjtObj.mjOBJ_BODY, 'palm')], carrier = m.body_mocapid[id(mj.mjtObj.mjOBJ_BODY, 'carrier')], pusher = m.body_mocapid[id(mj.mjtObj.mjOBJ_BODY, 'pusher')];
    const palmBody = id(mj.mjtObj.mjOBJ_BODY, 'palm');
    const grip = calibrateGrasp(mj, m, palm, pouring ? .049 : s.size, pouring);
    d.mocap_pos.set([s.start[0] - grip.center[0], s.start[1] + (pouring ? grip.center[2] : -grip.center[1]), objectZ + (pouring ? .046 - grip.center[1] : -grip.center[2]) + .1], palm * 3);
    d.mocap_quat.set(pouring ? [Math.SQRT1_2, Math.SQRT1_2, 0, 0] : [1, 0, 0, 0], palm * 4);
    const geoms: TableGeom[] = [];
    for (let i = 0; i < m.ngeom; i++) {
      const name = mj.mj_id2name(m, mj.mjtObj.mjOBJ_GEOM.value, i);
      if (name === 'table_pusher' && s.task !== 'push') continue;
      const meshId = m.geom_dataid[i];
      if (m.geom_type[i] === mj.mjtGeom.mjGEOM_MESH.value && m.geom_contype[i] === 0) {
        geoms.push({ id: i, type: 'mesh', size: [], color: name.includes('tip') ? '#d6dacd' : '#515854', mesh: { vertices: Array.from(m.mesh_vert.slice(m.mesh_vertadr[meshId] * 3, (m.mesh_vertadr[meshId] + m.mesh_vertnum[meshId]) * 3)), faces: Array.from(m.mesh_face.slice(m.mesh_faceadr[meshId] * 3, (m.mesh_faceadr[meshId] + m.mesh_facenum[meshId]) * 3)) } });
      } else if (name.startsWith('table_')) {
        const type = m.geom_type[i] === mj.mjtGeom.mjGEOM_BOX.value ? 'box' : m.geom_type[i] === mj.mjtGeom.mjGEOM_SPHERE.value ? 'sphere' : 'cylinder';
        geoms.push({ id: i, type, size: Array.from(m.geom_size.slice(i * 3, i * 3 + 3)), color: name.includes('drop') ? '#69aeca' : name.includes('receiver') ? '#a0b6a6' : name.includes('surface') ? '#c7bfae' : name.includes('pusher') ? '#626e61' : name.includes('pedestal') ? '#a5a99d' : s.color });
      }
    }
    mj.mj_forward(m, d);
    const frames: TableFrame[] = []; let contacts = 0;
    const goalZ = top + (pouring ? .16 : s.size + (s.task === 'stack' ? .064 : 0));
    for (let frame = 0; frame <= duration * sampleHz; frame++) {
      const end = frame / sampleHz;
      while (d.time + 1e-8 < end) {
        const t = d.time * (s.motion?.speed ?? 1), travel = smooth((t - 3) / 3.5);
        let x = mix(s.start[0], s.goal[0], travel), y = mix(s.start[1], s.goal[1], travel);
        y += (s.motion?.lateral ?? 0) * Math.sin(Math.PI * travel);
        const lift = s.motion?.lift ?? .15;
        let z = objectZ + lift * smooth((t - 2) / 1) - lift * smooth((t - 6.5) / 1.5);
        if (s.task === 'stack') z += .064 * smooth((t - 3) / 2);
        let tilt = 0;
        if (pouring) {
          x = mix(s.start[0], s.goal[0] - .115, smooth((t - 2.5) / 2));
          y = mix(s.start[1], s.goal[1], smooth((t - 2.5) / 2));
          z = objectZ + .18 * smooth((t - 2) / 1);
          tilt = 1.95 * smooth((t - 4.5) / 2) * (1 - smooth((t - 7.2) / 1));
          // Pouring keeps the calibrated clearance/tilt; Muse varies speed,
          // placement and friction without inventing unsafe fluid geometry.
          // Return the emptied source cup to its own spot before releasing.
          x = mix(x, s.start[0], smooth((t - 8.3) / 1.5));
          y = mix(y, s.start[1], smooth((t - 8.3) / 1.5));
          z -= .18 * smooth((t - 9.5) / 1);
        }
        const holding = s.task !== 'push' && t >= 1.5 && t < (pouring ? 10.6 : 8);
        d.eq_active[0] = holding ? 1 : 0;
        d.mocap_pos.set([x, y, z], carrier * 3); d.mocap_quat.set([Math.cos(tilt / 2), 0, Math.sin(tilt / 2), 0], carrier * 4);
        const pushX = mix(s.start[0] - s.size - .015, s.goal[0] - s.size - .012, smooth((t - 2) / 5));
        const pushY = mix(s.start[1], s.goal[1], smooth((t - 2) / 5));
        d.mocap_pos.set(s.task === 'push' && t >= 1.5 && t < 8 ? [pushX, pushY, top + .026] : [-.44, -.24, top + .15], pusher * 3);
        // LEAP fingers curl into local -Z. The old X-half-turn pointed that
        // palmar side away from the object. Use the object orientation directly,
        // and rotate the calibrated grip offset with it throughout the pour.
        const wristX = s.task === 'push' ? pushX : x;
        const offset = rotateY(pouring ? [-grip.center[0], grip.center[2], .046 - grip.center[1]] : [-grip.center[0], -grip.center[1], -grip.center[2]], tilt);
        const approach = .10 * (1 - smooth(t / 1.5));
        const retreat = .12 * smooth((t - (pouring ? 10.6 : 8)) / 1);
        d.mocap_pos.set([wristX + offset[0], (s.task === 'push' ? pushY : y) + offset[1], (s.task === 'push' ? top + .05 : z) + offset[2] + approach + retreat], palm * 3);
        d.mocap_quat.set(pouring ? [Math.SQRT1_2 * Math.cos(tilt / 2), Math.SQRT1_2 * Math.cos(tilt / 2), Math.SQRT1_2 * Math.sin(tilt / 2), -Math.SQRT1_2 * Math.sin(tilt / 2)] : [Math.cos(tilt / 2), 0, Math.sin(tilt / 2), 0], palm * 4);
        const close = smooth((t - .8) / .7) * (1 - smooth((t - (pouring ? 10.6 : 8)) / .5));
        for (let j = 0; j < m.nu; j++) d.ctrl[j] = mix(.08, grip.controls[j], close);
        mj.mj_step(m, d); contacts = Math.max(contacts, d.ncon);
      }
      mj.mj_forward(m, d);
      const rotation = d.xmat.slice(palmBody * 9, palmBody * 9 + 9), palmPosition = Array.from(d.xpos.slice(palmBody * 3, palmBody * 3 + 3)) as number[];
      const graspCenter = palmPosition.map((p, axis) => p + rotation[axis * 3] * grip.center[0] + rotation[axis * 3 + 1] * grip.center[1] + rotation[axis * 3 + 2] * grip.center[2]);
      const objectPosition = Array.from(d.xpos.slice(objectBody * 3, objectBody * 3 + 3)) as number[];
      const objectCenter = objectPosition.map((p, axis) => p + (pouring ? .046 * d.xmat[objectBody * 9 + axis * 3 + 2] : 0));
      frames.push({ time: end, positions: geoms.map(g => Array.from(d.geom_xpos.slice(g.id * 3, g.id * 3 + 3))), rotations: geoms.map(g => Array.from(d.geom_xmat.slice(g.id * 9, g.id * 9 + 9))), contacts: d.ncon, object: objectPosition, objectCenter, palm: palmPosition, palmNormal: [-rotation[2], -rotation[5], -rotation[8]], graspCenter, holding: !!d.eq_active[0] });
    }
    const last = frames[frames.length - 1], finite = frames.every(f => f.positions.flat().every(Number.isFinite));
    let retainedParticles = 0;
    if (pouring) for (let i = 0; i < beads; i++) { const b = id(mj.mjtObj.mjOBJ_BODY, 'drop_' + i), p = d.xpos.slice(b * 3, b * 3 + 3); if (Math.hypot(p[0] - s.goal[0], p[1] - s.goal[1]) < .044 && p[2] > top && p[2] < top + .1) retainedParticles++; }
    const target = pouring ? [...s.start, objectZ] : [...s.goal, goalZ];
    return { scenario: s, geoms, frames, metrics: { finite, contacts, goalDistance: Math.hypot(...last.object.map((n, i) => n - target[i])), ...(pouring ? { retainedParticles, totalParticles: beads } : {}) }, provenance: { runtime: 'MuJoCo 4 / browser WASM', controller: graspController + '; temporary weld assist; push uses rigid pusher contacts', fluid: pouring ? '36 discrete rigid particles; not continuum water' : 'none', timestep: .004, hand: 'custom five-finger / 20-actuator extension of the licensed four-finger LEAP model; not a calibrated hardware model', handActuators: m.nu } };
  } finally { data?.delete(); model?.delete(); vfs.delete(); }
}
