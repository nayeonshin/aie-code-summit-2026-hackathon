import gzip
import hashlib
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
        data = gzip.compress(json.dumps(episode).encode())
        (root / 'tabletop' / filename).write_bytes(data)
        scenarios.append(scenario)
        studies.append({**scenario, 'metrics': episode['metrics'], 'provenance': episode['provenance'], 'frames': 361, 'file': filename, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
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


@pytest.mark.parametrize('field', ['sha256', 'bytes'])
@pytest.mark.parametrize('workers', [1, 2])
def test_compact_checks_indexed_source_before_writing(tmp_path, field, workers):
    root, originals = source(tmp_path)
    path = root / 'tabletop/episode-0001.json.gz'
    originals[0]['frames'][0]['positions'][0][0] += .1
    changed = gzip.compress(json.dumps(originals[0]).encode())
    path.write_bytes(changed)
    index_path = root / 'tabletop/index.json'
    index = json.loads(index_path.read_text())
    # Exercise each optional descriptor independently, including size-only data.
    other = 'bytes' if field == 'sha256' else 'sha256'
    index['studies'][0].pop(other)
    if field == 'bytes':
        index['studies'][0]['bytes'] = len(changed) + 1
    index_path.write_text(json.dumps(index))
    output = tmp_path / 'compact'
    with pytest.raises(ValueError, match='Standalone source checksum or size'):
        build_compact(root, output, workers)
    assert not (output / 'tabletop/compact/index.json').exists()


def test_failed_rebuild_preserves_previous_bundle(tmp_path, monkeypatch):
    import scripts.compact_tabletop as converter
    root, originals = source(tmp_path)
    output = tmp_path / 'compact'
    previous = build_compact(root, output, 1)
    previous_index = (output / 'tabletop/compact/index.json').read_bytes()
    changed = json.loads(json.dumps(originals[0]))
    changed['frames'][0]['positions'][0][0] += .1
    data = gzip.compress(json.dumps(changed).encode())
    (root / 'tabletop/episode-0001.json.gz').write_bytes(data)
    index_path = root / 'tabletop/index.json'
    index = json.loads(index_path.read_text())
    index['studies'][0].update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
    index_path.write_text(json.dumps(index))
    convert = converter.compact_episode

    def interrupted(job):
        if job[2]['id'] == 1:
            raise OSError('interrupted second episode')
        return convert(job)

    with monkeypatch.context() as patch:
        patch.setattr(converter, 'compact_episode', interrupted)
        with pytest.raises(OSError, match='interrupted'):
            build_compact(root, output, 1)
    assert (output / 'tabletop/compact/index.json').read_bytes() == previous_index
    for entry, original in zip(previous['episodes'], originals):
        assert restore_episode(output, entry, previous['meshes']) == original
    updated = build_compact(root, output, 1)
    assert updated['episodes'][0]['file'] != previous['episodes'][0]['file']
    assert restore_episode(output, updated['episodes'][0], updated['meshes']) == changed
    assert restore_episode(output, previous['episodes'][0], previous['meshes']) == originals[0]


def test_compact_accepts_unindexed_legacy_sources(tmp_path):
    root, _ = source(tmp_path)
    path = root / 'tabletop/index.json'
    index = json.loads(path.read_text())
    for study in index['studies']:
        study.pop('bytes')
        study.pop('sha256')
    path.write_text(json.dumps(index))
    assert build_compact(root, tmp_path / 'compact', 1)['recorded'] == 2
