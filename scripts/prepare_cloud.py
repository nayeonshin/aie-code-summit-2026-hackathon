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
    print(f'Prepared {len(files)} licensed model files for deployment.')

if __name__ == '__main__': main()
