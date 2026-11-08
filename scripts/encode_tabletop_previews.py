"""Encode captured recorded frames as small looping documentation GIFs."""
import argparse
import json
from pathlib import Path
from PIL import Image, ImageOps


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('capture', type=Path)
    parser.add_argument('--output', type=Path, default=Path('docs/media'))
    args = parser.parse_args()
    capture = json.loads(args.capture.read_text())
    args.output.mkdir(parents=True, exist_ok=True)
    metadata = []
    for preview in capture['previews']:
        frames = [ImageOps.pad(Image.open(path).convert('RGB'), (640, 480), color='#f5f5f2') for path in preview['frames']]
        palette = frames[0].quantize(colors=128)
        indexed = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in frames]
        destination = args.output / preview['gif']
        indexed[0].save(destination, save_all=True, append_images=indexed[1:], duration=capture['frame_duration_ms'], loop=0, optimize=True)
        metadata.append({k: v for k, v in preview.items() if k != 'frames'} | {'bytes': destination.stat().st_size, 'width': 640, 'height': 480, 'frame_duration_ms': capture['frame_duration_ms']})
        print(destination, destination.stat().st_size, 'bytes')
    (args.output / 'previews.json').write_text(json.dumps(metadata, indent=2) + '\n')


if __name__ == '__main__':
    main()
