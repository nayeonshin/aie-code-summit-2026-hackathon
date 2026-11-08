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


def meshes(xml: bytes) -> list[str]:
    """Mesh files the model references, relative to its directory."""
    return ['assets/' + m.attrib['file'] for m in ET.fromstring(xml).findall('./asset/mesh')]


def missing() -> list[str]:
    """What a complete download still lacks: the model, its license, or any referenced mesh."""
    model = ROOT / 'so101_new_calib.xml'
    gaps = [name for name in ('so101_new_calib.xml', 'LICENSE', 'source.json') if not (ROOT / name).exists()]
    if model.exists():
        gaps += [name for name in meshes(model.read_bytes()) if not (ROOT / name).is_file() or (ROOT / name).stat().st_size == 0]
    return gaps


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    base = f'https://raw.githubusercontent.com/{REPOSITORY}/{REVISION}'
    xml = fetch(f'{base}/{MODEL}')
    (ROOT / 'assets').mkdir(exist_ok=True)
    # Meshes first, each written whole, and the model last: an interrupted download leaves
    # no model file, so the next prepare fetches again instead of publishing a partial set.
    for name in meshes(xml):
        dest = ROOT / name
        if not dest.is_file() or dest.stat().st_size == 0:
            part = dest.with_suffix('.part')
            part.write_bytes(fetch(f'{base}/Simulation/SO101/{name}'))
            part.replace(dest)
    (ROOT / 'LICENSE').write_bytes(fetch(f'{base}/LICENSE'))
    (ROOT / 'source.json').write_text(json.dumps(
        {'repository': REPOSITORY, 'revision': REVISION, 'model': MODEL, 'license': 'Apache-2.0'}, indent=2))
    (ROOT / 'so101_new_calib.xml').write_bytes(xml)
    if missing():
        raise RuntimeError(f'SO-101 download incomplete: {missing()}')
    print(f'SO-101 model ready ({REVISION[:12]})')


if __name__ == '__main__':
    main()
