import numpy as np
import pytest
from backend.simulation import RECIPES, Simulation, episode, load_model, scene_description

@pytest.fixture(scope='module')
def model(): return load_model()

def test_scene_has_real_meshes(model):
    scene = scene_description(model)
    assert len(scene['geoms']) >= 17
    assert len(scene['meshes']) == model.nmesh
    for mesh in scene['meshes']:
        assert len(mesh['vertices']) % 3 == 0
        assert max(mesh['faces']) < len(mesh['vertices']) // 3

@pytest.mark.parametrize('recipe', RECIPES)
def test_bounded_finite_movement(model, recipe):
    sim = Simulation(model, recipe, 42)
    initial = sim.data.qpos.copy()
    for _ in range(90):
        sim.advance()
        assert np.isfinite(sim.data.qpos).all()
        assert np.all(sim.data.ctrl >= model.actuator_ctrlrange[:, 0])
        assert np.all(sim.data.ctrl <= model.actuator_ctrlrange[:, 1])
    assert np.linalg.norm(sim.data.qpos - initial) > .01

def test_seeded_reproduction(model):
    a, b = episode(model, 1, 123, .2), episode(model, 1, 123, .2)
    np.testing.assert_allclose(a['qpos'], b['qpos'], atol=1e-7)
    assert a['parameters'] == b['parameters']
    assert len(a['time']) == 6
    assert a['valid']

def test_different_seed_changes_episode(model):
    a, b = episode(model, 0, 123, .2), episode(model, 0, 124, .2)
    assert a['parameters'] != b['parameters']
    assert a['qpos'] != b['qpos']
