"""Download the SO-101 arm (TheRobotStudio/SO-ARM100, Apache-2.0) at a pinned revision.

Only the MJCF, its meshes and the license are fetched. The model is used unchanged;
the tabletop scene adds the table, cups and particles around it at load time.
"""
import json
from pathlib import Path
from urllib.request import urlopen, Request
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1] / 'models' / 'so101'
REPOSITORY = 'TheRobotStudio/SO-ARM100'
REVISION = 'a758567c3978dfeefe282ede0500085a48fe8f78'
MODEL = 'Simulation/SO101/so101_new_calib.xml'


def fetch(url):
    with urlopen(Request(url, headers={'User-Agent': 'labbit'}), timeout=60) as r:
        return r.read()


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    base = f'https://raw.githubusercontent.com/{REPOSITORY}/{REVISION}'
    xml = fetch(f'{base}/{MODEL}')
    (ROOT / 'so101_new_calib.xml').write_bytes(xml)
    (ROOT / 'LICENSE').write_bytes(fetch(f'{base}/LICENSE'))
    (ROOT / 'assets').mkdir(exist_ok=True)
    for mesh in ET.fromstring(xml).findall('./asset/mesh'):
        name = mesh.attrib['file']
        dest = ROOT / 'assets' / name
        if not dest.exists():
            dest.write_bytes(fetch(f'{base}/Simulation/SO101/assets/{name}'))
    (ROOT / 'source.json').write_text(json.dumps(
        {'repository': REPOSITORY, 'revision': REVISION, 'model': MODEL, 'license': 'Apache-2.0'}, indent=2))
    print(f'SO-101 model ready ({REVISION[:12]})')


if __name__ == '__main__':
    main()
