import type { MainModule, MjModel } from '@mujoco/mujoco';

export const graspController = 'palm-facing-object / object-local wrist + fingertip IK v2';
type V3 = [number, number, number];
export const rotateY = ([x, y, z]: V3, angle: number): V3 => [Math.cos(angle) * x + Math.sin(angle) * z, y, -Math.sin(angle) * x + Math.cos(angle) * z];

// Calibrate against MuJoCo's actual articulated geometry, not rendered offsets.
export function calibrateGrasp(mj: MainModule, model: MjModel, palmMocap: number, radius: number, cup: boolean) {
  const data = new mj.MjData(model);
  const center: V3 = cup ? [.005, -.025, -.105] : [.025, .018, -.105];
  const controls: number[] = Array.from({ length: model.nu }, (_, j) => j % 4 === 1 ? .1 : .65);
  const names = ['if', 'mf', 'rf', 'th', 'lf'];
  const angles = [30, -10, -45, 145, -75].map(a => a * Math.PI / 180);
  const addresses = Array.from({ length: model.nu }, (_, j) => model.jnt_qposadr[model.actuator_trnid[j * 2]]);
  const solve3 = (a: number[][], b: number[]) => {
    const rows = a.map((row, i) => [...row, b[i]]);
    for (let i = 0; i < 3; i++) { const k = rows[i][i]; for (let j = i; j < 4; j++) rows[i][j] /= k; for (let r = 0; r < 3; r++) if (r !== i) { const s = rows[r][i]; for (let j = i; j < 4; j++) rows[r][j] -= s * rows[i][j]; } }
    return rows.map(r => r[3]);
  };
  try {
    data.mocap_pos.set([0, 0, 0], palmMocap * 3); data.mocap_quat.set([1, 0, 0, 0], palmMocap * 4);
    const forward = () => { for (let j = 0; j < model.nu; j++) data.qpos[addresses[j]] = controls[j]; mj.mj_kinematics(model, data); };
    for (let finger = 0; finger < names.length; finger++) {
      // Small objects use an index/thumb precision grip; the other fingers tuck clear.
      if ((cup && finger !== 0 && finger !== 1 && finger !== 3) || (!cup && finger !== 0 && finger !== 3)) { for (let j = finger * 4; j < finger * 4 + 4; j++) controls[j] = j % 4 === 1 ? .1 : 1.2; continue; }
      const geom = mj.mj_name2id(model, mj.mjtObj.mjOBJ_GEOM.value, names[finger] + '_tip');
      const surface = radius + .010;
      // Cups are held from the side: their axis is local Y, so the thumb
      // opposes index/middle across the XZ cross-section (not the cup opening).
      const target = cup ? [center[0] + (finger === 3 ? -1 : 1) * surface, center[1] + (finger === 0 ? .025 : finger === 1 ? -.015 : .015), center[2]] : [center[0] + Math.cos(angles[finger]) * surface, center[1] + Math.sin(angles[finger]) * surface, center[2]];
      for (let iteration = 0; iteration < 70; iteration++) {
        forward(); const p = Array.from(data.geom_xpos.slice(geom * 3, geom * 3 + 3)) as number[]; const error = target.map((n, i) => n - p[i]);
        if (Math.hypot(...error) < .0015) break;
        const jacobian: number[][] = [[], [], []];
        for (let j = 0; j < 4; j++) { const index = finger * 4 + j, value = controls[index]; controls[index] += .001; forward(); for (let axis = 0; axis < 3; axis++) jacobian[axis][j] = (data.geom_xpos[geom * 3 + axis] - p[axis]) / .001; controls[index] = value; }
        const a = Array.from({ length: 3 }, (_, r) => Array.from({ length: 3 }, (_, c) => jacobian[r].reduce((sum, v, j) => sum + v * jacobian[c][j], 0) + (r === c ? .00002 : 0)));
        const step = solve3(a, error);
        for (let j = 0; j < 4; j++) { const index = finger * 4 + j, change = jacobian.reduce((sum, row, axis) => sum + row[j] * step[axis], 0); controls[index] = Math.max(model.actuator_ctrlrange[index * 2], Math.min(model.actuator_ctrlrange[index * 2 + 1], controls[index] + Math.max(-.15, Math.min(.15, change)))); }
      }
    }
    forward();
    const gaps = [0, 3].map(finger => { const geom = mj.mj_name2id(model, mj.mjtObj.mjOBJ_GEOM.value, names[finger] + '_tip'); const p = Array.from(data.geom_xpos.slice(geom * 3, geom * 3 + 3)) as number[]; return Math.abs(Math.hypot(...p.map((n, i) => n - center[i])) - radius - .010); });
    return { center, controls, fingertipFitError: Math.max(...gaps) };
  } finally { data.delete(); }
}
