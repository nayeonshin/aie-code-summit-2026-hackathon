"""Publish only the licensed robot assets, never local datasets or credentials."""
import json
from pathlib import Path
import shutil
from backend.simulation import ROOT, MODEL_PATH, provenance

def main():
    output = ROOT / 'public/model'
    output.mkdir(parents=True, exist_ok=True)
    source = MODEL_PATH.parent
    files = ['right_hand.xml', 'LICENSE', 'source.json'] + ['assets/' + p.name for p in sorted((source / 'assets').glob('*.obj'))]
    for name in files:
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / name, target)
    (output / 'manifest.json').write_text(json.dumps({'files': files, 'provenance': provenance()}, indent=2))
    for name in ('data-catalog.json', 'tabletop-plan.json', 'tabletop-recordings.json'):
        snapshot = ROOT / 'config' / name
        if snapshot.exists():
            public_data = ROOT / 'public/data'
            public_data.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(snapshot, public_data / ('catalog.json' if name == 'data-catalog.json' else name))
    # The SO-101 arm (Apache-2.0), for the arm pour studies.
    so101 = ROOT / 'models/so101'
    from scripts import fetch_so101
    # Check every mesh the model references on each prepare, not just the XML: fetch what
    # is missing, and refuse to publish an incomplete arm.
    if fetch_so101.missing():
        fetch_so101.main()
    if fetch_so101.missing():
        raise RuntimeError(f'SO-101 model incomplete: {fetch_so101.missing()}')
    arm_out = ROOT / 'public/so101'
    arm_files = ['so101_new_calib.xml', 'LICENSE', 'source.json'] + fetch_so101.meshes((so101 / 'so101_new_calib.xml').read_bytes())
    for name in arm_files:
        target = arm_out / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(so101 / name, target)
    (arm_out / 'manifest.json').write_text(json.dumps({'files': arm_files, 'source': json.loads((so101 / 'source.json').read_text())}, indent=2))
    print(f'Prepared {len(files)} licensed hand files and {len(arm_files)} SO-101 files for deployment.')

if __name__ == '__main__': main()
