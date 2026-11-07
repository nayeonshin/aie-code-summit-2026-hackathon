import json
import pyarrow.parquet as pq
import pytest
from backend.generate import generate

def test_shards_resume_and_config_check(tmp_path):
    result = generate(tmp_path, count=5, workers=1, seconds=.2, shard_size=2)
    assert result['status'] == 'complete'
    assert result['attempted'] == 5
    assert sum(result['coverage'].values()) == 5
    assert len(result['shards']) == 3
    rows = []
    for shard in result['shards']:
        rows.extend(pq.read_table(tmp_path / shard['file']).to_pylist())
    assert [r['episode_id'] for r in rows] == list(range(5))
    assert len(rows[0]['qpos'][0]) == 16
    again = generate(tmp_path, count=5, workers=1, seconds=.2, shard_size=2)
    assert again['shards'] == result['shards']
    with pytest.raises(ValueError): generate(tmp_path, count=6, workers=1, seconds=.2, shard_size=2)

def test_cancellation_checkpoint(tmp_path):
    (tmp_path / 'cancel').touch()
    result = generate(tmp_path, count=5, workers=1, seconds=.2)
    assert result['status'] == 'cancelled'
    assert result['attempted'] == 0
    assert json.loads((tmp_path / 'manifest.json').read_text())['status'] == 'cancelled'
    (tmp_path / 'cancel').unlink()
    resumed = generate(tmp_path, count=5, workers=1, seconds=.2)
    assert resumed['status'] == 'complete'
    assert resumed['attempted'] == 5

def test_corrupt_shard_is_not_silently_resumed(tmp_path):
    generate(tmp_path, count=1, workers=1, seconds=.1)
    (tmp_path / 'shard-000000.parquet').write_bytes(b'corrupted')
    with pytest.raises(ValueError, match='corrupted'):
        generate(tmp_path, count=1, workers=1, seconds=.1)
