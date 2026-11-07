"""Download only LEAP's required assets, retaining its license and source revision."""
import json
from pathlib import Path
from urllib.request import urlopen, Request
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1] / 'models' / 'leap_hand'

def fetch(url):
    with urlopen(Request(url, headers={'User-Agent': 'hand-studio'}), timeout=60) as r:
        return r.read()

def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    source = ROOT / 'source.json'
    if source.exists():
        revision = json.loads(source.read_text())['revision']
    else:
        # Pin the tested model rather than relying on GitHub's rate-limited API.
        revision = '98a70c569c4c1b6da467a20012f766ee1f8dc521'
    base = f'https://raw.githubusercontent.com/google-deepmind/mujoco_menagerie/{revision}/leap_hand'
    xml = fetch(base + '/right_hand.xml')
    for name in ['right_hand.xml', 'LICENSE']:
        (ROOT / name).write_bytes(xml if name.endswith('.xml') else fetch(base + '/' + name))
    (ROOT / 'assets').mkdir(exist_ok=True)
    for mesh in ET.fromstring(xml).findall('./asset/mesh'):
        name = mesh.attrib['file']
        dest = ROOT / 'assets' / name
        if not dest.exists():
            dest.write_bytes(fetch(base + '/assets/' + name))
    source.write_text(json.dumps({'repository': 'google-deepmind/mujoco_menagerie', 'revision': revision, 'model': 'leap_hand/right_hand.xml'}, indent=2))
    print(f'LEAP model ready ({revision[:12]})')

if __name__ == '__main__':
    main()
