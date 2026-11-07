from collections import Counter
from backend.objectives import OBJECTIVES, allocation, schedule
from backend.simulation import load_model, episode

def test_exact_quota_allocation():
    assert sum(o['quota'] for o in OBJECTIVES) == 100
    assert allocation(100) == {o['id']: o['quota'] for o in OBJECTIVES}
    assert Counter(schedule(100, 42)) == allocation(100)
    for count in (1, 17, 101, 100000): assert sum(allocation(count).values()) == count
    assert schedule(100, 42) == schedule(100, 42)
    assert schedule(100, 42) != schedule(100, 43)

def test_20_second_recovery_records_disturbances():
    data = episode(load_model(), 0, 42, 20, 'recovery')
    assert len(data['time']) == 600
    assert any(any(force != 0 for force in row) for row in data['external_force'])
    assert data['valid']
    assert data['objective_pass']
