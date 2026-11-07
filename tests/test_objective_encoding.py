import hashlib
import importlib.util
import json
from pathlib import Path


def test_plan_hash_is_independent_of_locale(monkeypatch):
    original = Path.read_text
    calls = []

    def windows_default(self, encoding=None, **kwargs):
        if self.name == 'objectives.json':
            calls.append(encoding)
        return original(self, encoding=encoding or 'cp1252', **kwargs)

    monkeypatch.setattr(Path, 'read_text', windows_default)
    path = Path(__file__).resolve().parents[1] / 'backend/objectives.py'
    spec = importlib.util.spec_from_file_location('locale_test_objectives', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    expected = json.loads(original(path.parents[1] / 'config/objectives.json', encoding='utf-8'))
    assert calls == ['utf-8']
    assert module.plan_hash() == hashlib.sha256(json.dumps(expected, sort_keys=True).encode()).hexdigest()
