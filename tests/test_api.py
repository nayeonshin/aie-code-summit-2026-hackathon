import base64
import asyncio
import httpx
import pytest
from fastapi.testclient import TestClient
from backend.app import app
from backend.subq import SubQ, SubQError

def test_live_and_scene():
    with TestClient(app) as client:
        assert client.get('/api/health').json()['physics'] == 'mujoco'
        scene = client.get('/api/scene').json()
        assert len(scene['recipes']) == 14
        with client.websocket_connect('/api/live') as ws:
            first = ws.receive_json()
            assert len(first['states']) == 9
            ws.send_json({'count': 4, 'paused': True})
            for _ in range(10):
                data = ws.receive_json()
                if data['paused'] and len(data['states']) == 4: break
            assert data['paused']
            times = [s['time'] for s in data['states']]
            second = ws.receive_json()
            assert times == [s['time'] for s in second['states']]

def test_annotation_validation(monkeypatch):
    monkeypatch.setenv('SUBQ_API_KEY', 'test-key')
    with pytest.raises(SubQError, match='PNG'):
        asyncio.run(SubQ().annotate([base64.b64encode(b'not-an-image').decode()], {}))

def test_invalid_job_is_rejected():
    with TestClient(app) as client:
        assert client.post('/api/runs', json={'count': 100001}).status_code == 422
        assert client.get('/api/runs/../../etc/episodes/0').status_code in (400, 404)

def test_subq_multimodal_contract(monkeypatch, tmp_path):
    monkeypatch.setenv('SUBQ_API_KEY', 'test-key')
    calls = []
    async def fake_post(self, url, **kwargs):
        payload = kwargs['json']
        calls.append(payload)
        assert url.endswith('/v1/systemone')
        assert len(payload['images']) == 4
        assert payload['images'][0]['mediaType'] == 'image/png'
        assert payload['state']['telemetry'] == {'samples': []}
        assert isinstance(payload['questions']['coordination']['criteria'], list)
        return httpx.Response(200, json={'answers': {'movement': {'choice': 'flex', 'confidence': .9}}, 'usage': {'input_tokens': 100}})
    monkeypatch.setattr(httpx.AsyncClient, 'post', fake_post)
    provider = SubQ()
    provider.cache = tmp_path
    image = base64.b64encode(b'\x89PNG\r\n\x1a\n' + b'fixture').decode()
    result = asyncio.run(provider.annotate([image] * 4, {'samples': []}))
    assert result['advisory']
    assert result['image_count'] == 4
    cached = asyncio.run(provider.annotate([image] * 4, {'samples': []}))
    assert cached['cached']
    assert len(calls) == 1

def test_saved_episode_replay(monkeypatch, tmp_path):
    import importlib
    from backend.generate import generate
    module = importlib.import_module('backend.app')
    generate(tmp_path / 'fixture', count=2, workers=1, seconds=.2)
    monkeypatch.setattr(module, 'RUNS', tmp_path)
    with TestClient(app) as client:
        result = client.get('/api/runs/fixture/episodes/0')
        assert result.status_code == 200
        data = result.json()
        assert data['recipe'] in client.get('/api/scene').json()['recipes']
        assert len(data['frames']) == 6
        assert len(data['frames'][0]['qpos']) == 16
        assert len(data['frames'][0]['positions']) > 16
        import pyarrow.parquet as pq
        row = pq.read_table(tmp_path / 'fixture/shard-000000.parquet').to_pylist()[0]
        for index, frame in enumerate(data['frames']):
            for field in ('qpos', 'qvel', 'ctrl', 'contacts', 'actuator_force', 'external_force'):
                assert frame[field] == row[field][index]
        assert client.get('/api/runs/fixture/episodes/2').status_code == 404
