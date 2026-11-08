"""Package only allowlisted public trajectories, model proposals and reviews.

No keys, logs, .env files, private configuration or arbitrary data directories.
"""
import hashlib
import gzip
import json
import re
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'data/publish'
PRODUCTION = '7c850e6a-ff7f-4a42-9c12-375c2e28549b'
BASE = f'https://hand-studio.hidden-pond-5e6a.workers.dev/datasets/{PRODUCTION}/'
HF = 'https://huggingface.co/datasets/MedSalim/labbit-robotic-manipulation'


def download(url):
    # curl uses the same HTTP transport as the documented dataset-download
    # commands; Python's default urllib transport is rejected by this deployment.
    return subprocess.check_output(['curl', '--fail', '--location', '--retry', '3', '--max-time', '180', '-sS', url])


FRAMES = {'so101': 508}


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2), encoding='utf-8')


def validate_tabletop(output):
    index = json.loads((output / 'tabletop/index.json').read_text(encoding='utf-8'))
    raw = (output / 'muse/scenarios.json').read_bytes()
    scenarios = json.loads(raw)
    plan_path = output / 'muse/tabletop-plan.json'
    plan = json.loads(plan_path.read_text(encoding='utf-8')) if plan_path.exists() else None
    if index.get('plan_fingerprint') and index['plan_fingerprint'] != hashlib.sha256(raw).hexdigest():
        raise ValueError('Export plan fingerprint mismatch')
    # Seeded SO-101 studies follow the plan's ids with their own fingerprint (append-only).
    arm_path = output / 'tabletop/arm-scenarios.json'
    arm_raw = arm_path.read_bytes() if arm_path.exists() else b'[]'
    arm = json.loads(arm_raw)
    if index.get('arm_fingerprint') and index['arm_fingerprint'] != hashlib.sha256(arm_raw).hexdigest():
        raise ValueError('Export arm study fingerprint mismatch')
    if index['recorded'] != len(index['studies']) or index['planned'] != len(scenarios) or index.get('arm_planned', len(arm)) != len(arm):
        raise ValueError('Export inventory count mismatch')
    planned = scenarios + arm
    ids, files = set(), set()
    for study in index['studies']:
        ident, filename = study['id'], study['file']
        if ident in ids or filename in files:
            raise ValueError('Duplicate export ID or filename')
        ids.add(ident)
        files.add(filename)
        if not isinstance(ident, int) or not 0 <= ident < len(planned) or filename != f'episode-{ident + 1:04d}.json.gz':
            raise ValueError('Invalid export ID or filename')
        scenario = {k: v for k, v in study.items() if k not in ('metrics', 'provenance', 'frames', 'file', 'bytes', 'sha256')}
        if scenario.get('proposal') and (not plan or scenario['proposal']['planId'] != plan['id'] or scenario['proposal']['model'] != plan['model']):
            raise ValueError('Trajectory proposal differs from published plan')
        with gzip.open(output / 'tabletop' / filename, 'rt', encoding='utf-8') as stream:
            episode = json.load(stream)
        if scenario != planned[ident] or episode['scenario'] != scenario:
            raise ValueError('Trajectory/index/plan scenario mismatch')
        if episode['metrics'] != study['metrics'] or episode['provenance'] != study['provenance'] or len(episode['frames']) != study['frames']:
            raise ValueError('Trajectory/index measurements mismatch')
    return index


def package_tabletop(output, tabletop, collections):
    """Checksum the tabletop exports, write their overview, and add their collections.
    Returns the catalog's tabletop counts and the hand/arm study lists."""
    if tabletop['recorded'] != len(tabletop['studies']):
        raise ValueError('Recorded tabletop count does not match the exported inventory')
    for study in tabletop['studies']:
        # 12 s hand studies; the SO-101 pour runs a 16.9 s timeline (src/tabletop-scenarios.ts)
        frames = FRAMES.get(study['task'], 361)
        if not re.fullmatch(r'episode-\d+\.json\.gz', study['file']) or study['frames'] != frames or not study['metrics']['finite']:
            raise ValueError('Invalid tabletop export inventory')
        file = output / 'tabletop' / study['file']
        study['bytes'] = file.stat().st_size
        study['sha256'] = hashlib.sha256(file.read_bytes()).hexdigest()
    write(output / 'tabletop/index.json', tabletop)
    # Hand studies (12 s, five-finger hand, Muse-planned) and seeded SO-101 arm studies are
    # separate inventories: separate counts, descriptions and licenses.
    hand = [s for s in tabletop['studies'] if s['task'] != 'so101']
    arm = [s for s in tabletop['studies'] if s['task'] == 'so101']
    overview = []
    for study in tabletop['studies']:
        pouring = study['task'] in ('pour', 'so101')
        proposal = study.get('proposal')
        overview.append({'study_id': study['id'] + 1, 'task': study['task'], 'robot': 'so101-arm' if study['task'] == 'so101' else 'five-finger-hand', 'shape': 'cup' if pouring else study['shape'], 'seed': study['seed'], 'frames': study['frames'], 'solid_half_extent_m': None if pouring else study['size'], 'cup_radius_m': study['size'] if study['task'] == 'so101' else None, 'object_mass_kg': .115 if study['task'] == 'pour' else study['mass'],
                         # proposal-only fields stay empty for studies no Muse plan proposed
                         'muse_proposed_size_m': study['size'] if proposal else None, 'muse_proposed_mass_kg': study['mass'] if proposal else None, 'fixed_cup_geometry': study['task'] == 'pour', 'surface_friction': study['friction'], 'muse_model': study.get('proposal', {}).get('model'), 'muse_plan_id': study.get('proposal', {}).get('planId'), 'muse_variant': study.get('proposal', {}).get('variant'), 'muse_rationale': study.get('proposal', {}).get('rationale'), 'physics_runtime': study['provenance']['runtime'], 'controller': study['provenance']['controller'], 'finite': study['metrics']['finite'], 'goal_error_m': study['metrics']['goalDistance'], 'retained_particles': study['metrics'].get('retainedParticles'), 'subq_reviewed': False, 'trajectory_file': study['file'], 'sha256': study['sha256']})
    (output / 'tabletop/summary.jsonl').write_text('\n'.join(json.dumps(row) for row in overview) + '\n', encoding='utf-8')
    if arm:
        collections.insert(0, {'id': 'tabletop-so101-pour', 'label': 'SO-101 arm cup pour', 'episodes': len(arm), 'source': 'MuJoCo 4 WASM, seeded (no Muse proposals)', 'description': "16.9s, SO-101 arm (TheRobotStudio SO-ARM100 MJCF, Apache-2.0; see SO101_MODEL_LICENSE) following RAX's pour: side grasp, wrist-roll pour, put back. IK joint plan on the servo actuators; weld-assisted hold; arm geometry non-colliding. Water is 36 rigid particles.", 'path': 'tabletop'})
    collections.insert(0, {'id': 'tabletop-grip-v2', 'label': 'Palm-aligned tabletop manipulation', 'episodes': len(hand), 'source': 'MuJoCo 4 WASM + Muse proposals', 'description': '12s, custom five-finger hand, geometry-calibrated assisted grips. Cups use rigid particles, not continuum water.', 'path': 'tabletop'})
    return hand, arm


def main():
    # Validate all tabletop attribution before modifying any publication files.
    tabletop = validate_tabletop(OUTPUT)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    collections = []
    for name in ('objectives100-20s', 'objectives100', 'pilot90'):
        source = ROOT / 'data/runs' / name
        manifest = json.loads((source / 'manifest.json').read_text(encoding='utf-8'))
        manifest.pop('process_pid', None)
        target = OUTPUT / 'hand-native' / name
        write(target / 'manifest.json', manifest)
        for shard in manifest['shards']:
            file = source / shard['file']
            if file.suffix != '.parquet' or file.parent != source:
                raise ValueError('Unexpected native shard path')
            if hashlib.sha256(file.read_bytes()).hexdigest() != shard['sha256']:
                raise ValueError(f'Native checksum mismatch: {file.name}')
            shutil.copyfile(file, target / file.name)
        collections.append({'id': name, 'label': name, 'episodes': manifest['attempted'], 'source': 'native MuJoCo / hand-only', 'description': f"{manifest['config']['seconds']}s episodes. No tabletop objects or Muse proposals. Preserve original controller provenance.", 'path': f'hand-native/{name}'})
    production = json.loads(download(BASE + 'manifest.json'))
    write(OUTPUT / 'hand-browser/manifest.json', production)
    for shard in production['shards']:
        if not re.fullmatch(r'shard-\d+\.json\.gz', shard['file']):
            raise ValueError('Unexpected production shard path')
        target = OUTPUT / 'hand-browser' / shard['file']
        if not target.exists():
            target.write_bytes(download(BASE + shard['file']))
        if hashlib.sha256(target.read_bytes()).hexdigest() != shard['sha256']:
            raise ValueError(f"Production checksum mismatch: {shard['file']}")
    write(OUTPUT / 'muse/hand-pilot-variants.json', {'source_run': PRODUCTION, 'model': 'muse-wonder-1.0', 'scope': 'hand-only parameter anchors copied from the production manifest', 'variants': production['config'].get('variants', [])})
    collections.append({'id': PRODUCTION, 'label': 'Browser production hand pilot', 'episodes': production['attempted'], 'source': 'browser MuJoCo + Muse hand-only anchors', 'description': 'Archived 20s four-finger hand trajectories, not object manipulation. Original browser controller is preserved.', 'path': 'hand-browser'})
    reviews = []
    for file in sorted((ROOT / 'data/annotations').glob('*.json')):
        value = json.loads(file.read_text(encoding='utf-8'))
        # Allowlist structured provider output, never provider configuration.
        review = {key: value[key] for key in ('model', 'answers', 'usage', 'input_sha256', 'image_count', 'advisory') if key in value}
        review['scope'] = 'hand-only visual sample; source episode/run association not recorded'
        write(OUTPUT / 'subq' / file.name, review)
        reviews.append(review)
    plan = json.loads((OUTPUT / 'muse/tabletop-plan.json').read_text(encoding='utf-8'))
    hand, arm = package_tabletop(OUTPUT, tabletop, collections)
    catalog = {'dataset_url': HF, 'collections': collections, 'tabletop': {'planned': tabletop['planned'], 'recorded': len(hand), 'arm_planned': tabletop.get('arm_planned', 0), 'arm_recorded': len(arm)}, 'muse': {'model': plan['model'], 'variants': len(plan['variants']), 'planId': plan['id'], 'rationale': [v['rationale'] for v in plan['variants']]}, 'subq': reviews}
    write(OUTPUT / 'catalog.json', catalog)
    # Small public snapshots travel with the source release. Raw trajectories
    # remain in the dataset repository, not Git or the Worker asset bundle.
    write(ROOT / 'config/data-catalog.json', catalog)
    write(ROOT / 'config/tabletop-plan.json', plan)
    public = ROOT / 'public/data'
    public.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(OUTPUT / 'catalog.json', public / 'catalog.json')
    shutil.copyfile(OUTPUT / 'muse/tabletop-plan.json', public / 'tabletop-plan.json')
    shutil.copyfile(ROOT / 'docs/dataset-card.md', OUTPUT / 'README.md')
    shutil.copyfile(ROOT / 'models/leap_hand/LICENSE', OUTPUT / 'ROBOT_MODEL_LICENSE')
    for name in ('SO101_MODEL_LICENSE', 'SO101_MODEL_SOURCE.json'):
        (OUTPUT / name).unlink(missing_ok=True)
    if arm:
        # Arm episodes carry SO-101 mesh geometry: ship its Apache-2.0 license and pinned source.
        shutil.copyfile(ROOT / 'models/so101/LICENSE', OUTPUT / 'SO101_MODEL_LICENSE')
        shutil.copyfile(ROOT / 'models/so101/source.json', OUTPUT / 'SO101_MODEL_SOURCE.json')
    print(f"Prepared public dataset: {len(hand)} hand and {len(arm)} SO-101 tabletop trajectories, {tabletop['planned']} planned hand scenarios, {len(reviews)} separate SubQ reviews. No credentials/logs included.")


if __name__ == '__main__':
    main()
