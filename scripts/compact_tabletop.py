"""Losslessly deduplicate published tabletop meshes; no physics or AI calls.

Workers own distinct episode files. Shared meshes are immutable, content-addressed
objects; only the parent validates and commits the consolidated manifest.
"""
import argparse
from concurrent.futures import ProcessPoolExecutor
import gzip
import hashlib
import json
import os
from pathlib import Path
import tempfile

from scripts.prepare_data import OUTPUT, ROOT, download, validate_tabletop


def encode(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode('utf-8')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.compact-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def compact_episode(job):
    source, output, study = job
    source, output = Path(source), Path(output)
    data = (source / 'tabletop' / study['file']).read_bytes()
    if ('bytes' in study and len(data) != study['bytes'] or
            'sha256' in study and digest(data) != study['sha256']):
        raise ValueError('Standalone source checksum or size mismatch')
    episode = json.loads(gzip.decompress(data))
    geometry = {}
    for geom in episode['geoms']:
        if 'mesh' not in geom:
            continue
        raw = encode(geom['mesh'])
        compressed = gzip.compress(raw, mtime=0)
        sha = digest(compressed)
        file = f'meshes/{sha}.json.gz'
        # Identical concurrent writes are safe: the content hash is the filename.
        atomic_write(output / 'tabletop' / file, compressed)
        geometry[sha] = {'file': file, 'sha256': sha, 'bytes': len(compressed)}
        geom['mesh'] = sha
    compact = {'schema_version': 1, **episode}
    data = gzip.compress(encode(compact), mtime=0)
    # Immutable payloads keep both the old and new indexes restorable, even if
    # conversion or validation fails before the final atomic index replacement.
    filename = f'compact/{digest(data)}.json.gz'
    atomic_write(output / 'tabletop' / filename, data)
    return {
        'id': study['id'], 'scenario': episode['scenario'], 'frames': len(episode['frames']),
        'file': filename, 'sha256': digest(data), 'bytes': len(data),
        'standalone_file': study['file'],
    }, geometry


def restore_episode(output, entry, meshes):
    output = Path(output)
    data = (output / 'tabletop' / entry['file']).read_bytes()
    if digest(data) != entry['sha256'] or len(data) != entry['bytes']:
        raise ValueError('Compact trajectory checksum mismatch')
    episode = json.loads(gzip.decompress(data))
    if episode.pop('schema_version') != 1:
        raise ValueError('Unsupported compact schema')
    for geom in episode['geoms']:
        if 'mesh' not in geom:
            continue
        mesh = meshes[geom['mesh']]
        data = (output / 'tabletop' / mesh['file']).read_bytes()
        if digest(data) != mesh['sha256'] or len(data) != mesh['bytes']:
            raise ValueError('Shared mesh checksum mismatch')
        geom['mesh'] = json.loads(gzip.decompress(data))
    if episode['scenario'] != entry['scenario'] or len(episode['frames']) != entry['frames']:
        raise ValueError('Compact manifest/episode disagreement')
    return episode


def build_compact(source=OUTPUT, output=OUTPUT, workers=4):
    source, output = Path(source), Path(output)
    index = validate_tabletop(source)
    entries, meshes = [], {}
    jobs = [(str(source), str(output), study) for study in index['studies']]
    if workers == 1:
        results = map(compact_episode, jobs)
        for entry, geometry in results:
            entries.append(entry)
            meshes.update(geometry)
    else:
        with ProcessPoolExecutor(max_workers=workers) as pool:
            for entry, geometry in pool.map(compact_episode, jobs):
                entries.append(entry)
                meshes.update(geometry)
    entries.sort(key=lambda e: e['id'])
    if len({e['id'] for e in entries}) != len(entries) or len({e['file'] for e in entries}) != len(entries):
        raise ValueError('Duplicate compact episode ID or filename')
    # Verify lossless round trips before publishing the consolidated index.
    for entry in entries:
        restored = restore_episode(output, entry, meshes)
        with gzip.open(source / 'tabletop' / entry['standalone_file'], 'rt', encoding='utf-8') as stream:
            if restored != json.load(stream):
                raise ValueError('Compact export changed recorded data')
    raw_scenarios = (source / 'muse/scenarios.json').read_bytes()
    manifest = {
        'schema_version': 1, 'plan_fingerprint': digest(raw_scenarios),
        'planned': index['planned'], 'recorded': len(entries), 'sample_hz': 30,
        'episodes': entries, 'meshes': meshes,
        'bytes': sum(e['bytes'] for e in entries) + sum(m['bytes'] for m in meshes.values()),
        'standalone_bytes': sum((source / 'tabletop' / e['standalone_file']).stat().st_size for e in entries),
    }
    atomic_write(output / 'tabletop/compact/index.json', encode(manifest))
    return manifest


def pin_snapshot(output, revision):
    import re
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('Use an immutable Hugging Face commit SHA, not main')
    local = (Path(output) / 'tabletop/compact/index.json').read_bytes()
    base = f'https://huggingface.co/datasets/MedSalim/labbit-robotic-manipulation/resolve/{revision}/'
    remote = download(base + 'tabletop/compact/index.json')
    if local != remote:
        raise ValueError('Uploaded compact manifest differs from local verified inventory')
    manifest = json.loads(local)
    manifest['base_url'] = f'https://huggingface.co/datasets/MedSalim/labbit-robotic-manipulation/resolve/{revision}/tabletop/'
    manifest['revision'] = revision
    catalog = json.loads(download(base + 'catalog.json'))
    if catalog['tabletop']['recorded'] != manifest['recorded']:
        raise ValueError('Published catalog and replay inventory disagree')
    snapshot = json.dumps(manifest, indent=2, allow_nan=False).encode('utf-8')
    catalog_snapshot = json.dumps(catalog, indent=2, allow_nan=False).encode('utf-8')
    atomic_write(ROOT / 'config/tabletop-recordings.json', snapshot)
    atomic_write(ROOT / 'public/data/tabletop-recordings.json', snapshot)
    atomic_write(ROOT / 'config/data-catalog.json', catalog_snapshot)
    atomic_write(ROOT / 'public/data/catalog.json', catalog_snapshot)


def stage_metadata(output, manifest):
    output = Path(output)
    catalog_path = output / 'catalog.json'
    if catalog_path.exists():
        catalog = json.loads(catalog_path.read_text())
        catalog['tabletop']['compact'] = {key: manifest[key] for key in ('schema_version', 'recorded', 'bytes', 'standalone_bytes')}
        catalog['tabletop']['compact']['meshes'] = len(manifest['meshes'])
        atomic_write(catalog_path, encode(catalog))
    atomic_write(output / 'README.md', (ROOT / 'docs/dataset-card.md').read_bytes())
    for name in ('transfer.gif', 'push.gif', 'stack.gif', 'pour.gif', 'previews.json'):
        visual = ROOT / 'docs/media' / name
        if visual.exists():
            atomic_write(output / 'media' / name, visual.read_bytes())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=OUTPUT)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--pin', help='Pin an already-uploaded compact manifest to a Hugging Face commit SHA')
    args = parser.parse_args()
    if args.pin:
        pin_snapshot(args.output, args.pin)
        return
    if not 1 <= args.workers <= 8:
        parser.error('Use 1–8 workers')
    manifest = build_compact(args.source, args.output, args.workers)
    stage_metadata(args.output, manifest)
    print(f"Verified {manifest['recorded']} lossless compact episodes; {len(manifest['meshes'])} shared meshes; "
          f"{manifest['bytes'] / 1e6:.1f} MB vs {manifest['standalone_bytes'] / 1e6:.1f} MB standalone.")


if __name__ == '__main__':
    main()
