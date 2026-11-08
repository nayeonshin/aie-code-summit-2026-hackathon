import gzip
import json
import pytest
from scripts.compact_tabletop import build_compact, restore_episode


def source(tmp_path):
    root = tmp_path / 'source'
    (root / 'tabletop').mkdir(parents=True)
    (root / 'muse').mkdir()
    scenarios, studies, originals = [], [], []
    for ident in range(2):
        scenario = {'id': ident, 'task': 'transfer', 'seed': ident}
        episode = {'scenario': scenario, 'geoms': [{'id': 0, 'type': 'mesh', 'size': [], 'color': '#fff', 'mesh': {'vertices': [0., 0., 0., 1., 0., 0., 0., 1., 0.], 'faces': [0, 1, 2]}}],
                   'frames': [{'time': i / 30, 'positions': [[ident + .1234567890123456, 0., 0.]], 'rotations': [[1., 0., 0., 0., 1., 0., 0., 0., 1.]], 'contacts': i, 'holding': False} for i in range(361)],
                   'metrics': {'finite': True}, 'provenance': {'runtime': 'fixture'}}
        filename = f'episode-{ident + 1:04d}.json.gz'
        (root / 'tabletop' / filename).write_bytes(gzip.compress(json.dumps(episode).encode()))
        scenarios.append(scenario)
        studies.append({**scenario, 'metrics': episode['metrics'], 'provenance': episode['provenance'], 'frames': 361, 'file': filename})
        originals.append(episode)
    (root / 'muse/scenarios.json').write_text(json.dumps(scenarios))
    (root / 'tabletop/index.json').write_text(json.dumps({'planned': 2, 'recorded': 2, 'studies': studies}))
    return root, originals


@pytest.mark.parametrize('workers', [1, 2])
def test_compact_lossless_shared_geometry(tmp_path, workers):
    root, originals = source(tmp_path)
    output = tmp_path / 'compact'
    manifest = build_compact(root, output, workers)
    assert manifest['recorded'] == 2
    assert len(manifest['meshes']) == 1
    for entry, original in zip(manifest['episodes'], originals):
        assert restore_episode(output, entry, manifest['meshes']) == original
    first_bytes = (output / 'tabletop/compact/index.json').read_bytes()
    build_compact(root, output, workers)
    assert (output / 'tabletop/compact/index.json').read_bytes() == first_bytes


def test_compact_rejects_tampered_payload(tmp_path):
    root, _ = source(tmp_path)
    output = tmp_path / 'compact'
    manifest = build_compact(root, output, 1)
    entry = manifest['episodes'][0]
    (output / 'tabletop' / entry['file']).write_bytes(b'corrupt')
    with pytest.raises(ValueError, match='checksum'):
        restore_episode(output, entry, manifest['meshes'])
