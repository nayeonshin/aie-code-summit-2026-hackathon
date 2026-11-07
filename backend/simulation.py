"""One physics model, independent states. Rendering never drives the controller."""
import hashlib
import json
from pathlib import Path
import mujoco
import numpy as np
from backend.objectives import PLAN, OBJECTIVES, plan_hash

ROOT = Path(__file__).resolve().parents[1]
MODEL_PATH = ROOT / 'models/leap_hand/right_hand.xml'
RECIPES = [o['id'] for o in OBJECTIVES]
RECIPE_VERSION = PLAN['version']
PHYSICS_DT = 0.002
SAMPLE_HZ = 30

def load_model():
    if not MODEL_PATH.exists():
        raise RuntimeError('Hand model missing. Run python scripts/fetch_model.py first.')
    model = mujoco.MjModel.from_xml_path(str(MODEL_PATH))
    model.opt.timestep = PHYSICS_DT
    return model

def provenance():
    source = json.loads((MODEL_PATH.parent / 'source.json').read_text())
    return {'source': source, 'model_sha256': hashlib.sha256(MODEL_PATH.read_bytes()).hexdigest(),
            'mujoco_version': mujoco.__version__, 'numpy_version': np.__version__, 'recipe_version': RECIPE_VERSION,
            'physics_dt': PHYSICS_DT, 'sample_hz': SAMPLE_HZ, 'objective_plan_sha256': plan_hash()}

class Simulation:
    def __init__(self, model, recipe, seed):
        self.model = model
        self.recipe = recipe
        self.seed = seed
        self.data = mujoco.MjData(model)
        rng = np.random.default_rng(seed)
        self.speed = float(rng.uniform(.7, 1.3))
        self.amplitude = float(rng.uniform(.65, 1.0))
        self.phase = float(rng.uniform(0, np.pi * 2))
        self.initial = rng.uniform(-.03, .03, model.nq)
        self.data.qpos[:] = self.initial
        self.data.ctrl[:] = self.initial
        mujoco.mj_forward(model, self.data)
        self.sample_index = 0

    def targets(self, time):
        t = time * self.speed
        pulse = (1 - np.cos(t * 1.7 + self.phase)) / 2
        curls = np.zeros(4)
        spread = np.zeros(3)
        if self.recipe == 'flex': curls[:] = pulse
        elif self.recipe == 'point': curls[:] = [0, pulse, pulse, pulse * .7]
        elif self.recipe == 'pinch': curls[:] = [pulse * .7, .12, .12, pulse * .8]
        elif self.recipe == 'wave': curls[:] = (1 - np.cos(t * 2.2 - np.arange(4) * .8 + self.phase)) / 2
        elif self.recipe == 'tripod': curls[:] = [pulse * .7, pulse * .7, .1, pulse * .8]
        elif self.recipe == 'spread': spread[:] = [-pulse * .5, 0, pulse * .5]; curls[:] = .08
        elif self.recipe == 'sequence': curls[:] = np.exp(-((np.sin(t * 1.1 + self.phase) * 1.5 + 1.5 - np.arange(4)) ** 2) / .35)
        elif self.recipe == 'opposition': curls[:] = [.25 * pulse, .2, .2, pulse]; spread[0] = pulse * .25
        elif self.recipe == 'roll': curls[:] = [.35 + .25 * np.sin(t * 1.8 + i * 1.4 + self.phase) for i in range(4)]
        elif self.recipe == 'hold': curls[:] = .45
        elif self.recipe == 'precision': curls[:] = .08 + .08 * pulse
        elif self.recipe == 'reversal': curls[:] = (1 - np.cos(t * .9)) / 2
        elif self.recipe == 'independent': curls[self.seed % 4] = pulse
        elif self.recipe == 'recovery': curls[:] = .45
        target = np.zeros(16)
        for finger in range(3):
            target[finger * 4: finger * 4 + 4] = [curls[finger] * 1.45, spread[finger], curls[finger] * 1.3, curls[finger] * 1.1]
        target[12:] = [curls[3] * .8, curls[3] * .5, curls[3] * 1.2, curls[3] * .75]
        # Smooth startup avoids injecting a large instantaneous target error.
        blend = min(time / .6, 1)
        blend = blend * blend * (3 - 2 * blend)
        target = self.initial * (1 - blend) + target * self.amplitude * blend
        return np.clip(target, self.model.actuator_ctrlrange[:, 0], self.model.actuator_ctrlrange[:, 1])

    def advance(self):
        self.sample_index += 1
        end = self.sample_index / SAMPLE_HZ
        while self.data.time + 1e-10 < end:
            self.data.ctrl[:] = self.targets(self.data.time)
            self.data.qfrc_applied[:] = 0
            if self.recipe == 'recovery' and any(start <= self.data.time < start + .2 for start in (6, 12)):
                self.data.qfrc_applied[self.seed % 16] = .015
            mujoco.mj_step(self.model, self.data)
        # MuJoCo's derived geometry must correspond to the recorded post-step qpos.
        mujoco.mj_forward(self.model, self.data)

    def state(self):
        d = self.data
        return {'time': d.time, 'positions': d.geom_xpos.tolist(), 'rotations': d.geom_xmat.tolist(),
                'qpos': d.qpos.tolist(), 'qvel': d.qvel.tolist(), 'ctrl': d.ctrl.tolist(),
                'contacts': int(d.ncon)}

def scene_description(model):
    meshes = []
    for i in range(model.nmesh):
        va, vn = int(model.mesh_vertadr[i]), int(model.mesh_vertnum[i])
        fa, fn = int(model.mesh_faceadr[i]), int(model.mesh_facenum[i])
        meshes.append({'vertices': model.mesh_vert[va:va+vn].ravel().tolist(),
                       'faces': model.mesh_face[fa:fa+fn].ravel().tolist()})
    geoms = []
    for i in range(model.ngeom):
        # Only original visual meshes and fingertip meshes; no collision boxes.
        if model.geom_type[i] != mujoco.mjtGeom.mjGEOM_MESH:
            continue
        geoms.append({'id': i, 'mesh': int(model.geom_dataid[i]),
                      'name': mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, i),
                      'tip': 'tip' in (mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, i) or '')})
    return {'meshes': meshes, 'geoms': geoms, 'recipes': RECIPES, 'provenance': provenance()}

def episode(model, index, seed, seconds, recipe=None):
    recipe = recipe or RECIPES[index % len(RECIPES)]
    sim = Simulation(model, recipe, seed)
    samples = []
    warning_before = sim.data.warning.number.copy()
    for _ in range(round(seconds * SAMPLE_HZ)):
        sim.advance()
        d = sim.data
        samples.append((d.time, d.qpos.copy(), d.qvel.copy(), d.ctrl.copy(), d.actuator_force.copy(), d.ncon, d.qfrc_applied.copy()))
    times, qpos, qvel, ctrl, forces, contacts, external = zip(*samples)
    qpos, qvel, ctrl, forces = map(np.asarray, (qpos, qvel, ctrl, forces))
    finite = bool(all(np.isfinite(a).all() for a in (qpos, qvel, ctrl, forces)))
    limit_error = float(np.maximum(np.maximum(model.jnt_range[:, 0] - qpos, qpos - model.jnt_range[:, 1]), 0).max())
    warnings = int((sim.data.warning.number - warning_before).sum())
    settled = np.asarray(times) >= PLAN['validation']['settling_seconds']
    tracking = float(np.sqrt(np.mean((qpos[settled] - ctrl[settled]) ** 2))) if settled.any() else float(np.sqrt(np.mean((qpos - ctrl) ** 2)))
    return {'episode_id': index, 'seed': seed, 'recipe': recipe, 'seconds': seconds,
            'parameters': json.dumps({'speed': sim.speed, 'amplitude': sim.amplitude, 'phase': sim.phase}),
            'time': list(times), 'qpos': qpos.astype('float32').tolist(), 'qvel': qvel.astype('float32').tolist(),
            'ctrl': ctrl.astype('float32').tolist(), 'actuator_force': forces.astype('float32').tolist(),
            'external_force': np.asarray(external).astype('float32').tolist(),
            'contacts': list(map(int, contacts)), 'finite': finite, 'warnings': warnings,
            'joint_limit_error': limit_error, 'tracking_rmse': float(np.sqrt(np.mean((qpos - ctrl) ** 2))),
            'settled_tracking_rmse': tracking, 'peak_velocity': float(np.abs(qvel).max()),
            'mean_abs_acceleration': float(np.abs(np.diff(qvel, axis=0) * SAMPLE_HZ).mean()) if len(qvel) > 1 else 0.,
            'objective_pass': finite and warnings == 0 and limit_error < .1 and tracking <= PLAN['validation']['tracking_rmse_max_rad'],
            'valid': finite and warnings == 0 and limit_error < .1}
