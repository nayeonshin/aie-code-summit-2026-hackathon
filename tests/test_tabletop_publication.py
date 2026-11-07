import gzip
import json
import pytest
from scripts.prepare_data import validate_tabletop


def fixture(tmp_path):
    (tmp_path / 'tabletop').mkdir()
    (tmp_path / 'muse').mkdir()
    scenario = {'id': 0, 'task': 'pour', 'seed': 12}
    episode = {'scenario': scenario, 'frames': [{}] * 361, 'metrics': {'finite': True}, 'provenance': {'runtime': 'fixture'}}
    filename = 'episode-0001.json.gz'
    (tmp_path / 'tabletop' / filename).write_bytes(gzip.compress(json.dumps(episode).encode()))
    study = {**scenario, 'frames': 361, 'metrics': episode['metrics'], 'provenance': episode['provenance'], 'file': filename}
    index = {'planned': 1, 'recorded': 1, 'studies': [study]}
    (tmp_path / 'muse/scenarios.json').write_text(json.dumps([scenario]))
    (tmp_path / 'tabletop/index.json').write_text(json.dumps(index))
    return index, episode


def test_publication_checks_trajectory_identity(tmp_path):
    index, episode = fixture(tmp_path)
    assert validate_tabletop(tmp_path)['recorded'] == 1
    episode['scenario']['task'] = 'push'
    (tmp_path / 'tabletop/episode-0001.json.gz').write_bytes(gzip.compress(json.dumps(episode).encode()))
    with pytest.raises(ValueError, match='scenario mismatch'):
        validate_tabletop(tmp_path)


def test_publication_rejects_duplicates(tmp_path):
    index, _ = fixture(tmp_path)
    index['studies'] *= 2
    index['recorded'] = 2
    (tmp_path / 'tabletop/index.json').write_text(json.dumps(index))
    with pytest.raises(ValueError, match='Duplicate'):
        validate_tabletop(tmp_path)


def test_publication_rejects_wrong_fingerprint(tmp_path):
    index, _ = fixture(tmp_path)
    index['plan_fingerprint'] = 'wrong-plan'
    (tmp_path / 'tabletop/index.json').write_text(json.dumps(index))
    with pytest.raises(ValueError, match='fingerprint'):
        validate_tabletop(tmp_path)
