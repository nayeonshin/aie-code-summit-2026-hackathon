"""Public domain changes must not rename persistent infrastructure."""
import json
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class PageHead(HTMLParser):
    def __init__(self):
        super().__init__()
        self.meta = {}
        self.links = {}

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'meta':
            self.meta[attrs.get('property', attrs.get('name'))] = attrs.get('content')
        if tag == 'link':
            self.links[attrs.get('rel')] = attrs.get('href')


def test_public_branding_metadata():
    head = PageHead()
    head.feed((ROOT / 'index.html').read_text())
    assert head.links['canonical'] == 'https://labbit.science/'
    assert head.links['icon'] == '/labbit.svg'
    assert head.meta['og:url'] == head.links['canonical']
    assert head.meta['og:site_name'] == 'Labbit'
    assert 'labbit.science' in head.meta['description']


def test_custom_domain_preserves_infrastructure():
    config = json.loads((ROOT / 'wrangler.jsonc').read_text())
    assert {'pattern': 'labbit.science', 'custom_domain': True} in config['routes']
    assert config['workers_dev'] is True
    assert config['name'] == 'hand-studio'
    assert config['r2_buckets'] == [{'binding': 'DATA', 'bucket_name': 'hand-studio-trajectories'}]
    assert config['durable_objects']['bindings'] == [{'name': 'COORDINATOR', 'class_name': 'Coordinator'}]


def test_public_docs_and_script_defaults_use_canonical_domain():
    paths = [
        'README.md', 'docs/dataset-card.md', 'docs/deployment.md',
        'scripts/dev_recording_proxy.ts', 'scripts/render_tabletop_previews.mjs',
        'scripts/prepare_data.py', 'scripts/generate_muse.mjs',
    ]
    for path in paths:
        text = (ROOT / path).read_text()
        assert 'https://labbit.science' in text, path
        assert 'https://hand-studio.hidden-pond-5e6a.workers.dev' not in text, path
