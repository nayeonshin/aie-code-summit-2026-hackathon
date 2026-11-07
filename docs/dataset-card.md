---
language:
- en
license: cc-by-4.0
task_categories:
- robotics
tags:
- mujoco
- robotic-hand
- assisted-manipulation
- synthetic
- muse-wonder
- subq
pretty_name: Labbit robotic manipulation studies
configs:
- config_name: tabletop_overview
  default: true
  data_files:
  - split: train
    path: tabletop/summary.jsonl
- config_name: tabletop_trajectories
  data_files:
  - split: train
    path: tabletop/episode-*.json.gz
- config_name: muse_scenarios
  data_files:
  - split: train
    path: muse/scenarios.json
- config_name: native_hand_20s
  data_files:
  - split: train
    path: hand-native/objectives100-20s/*.parquet
- config_name: native_hand_5s
  data_files:
  - split: train
    path: hand-native/objectives100/*.parquet
- config_name: native_hand_legacy90
  data_files:
  - split: train
    path: hand-native/pilot90/*.parquet
- config_name: browser_hand_20s
  data_files:
  - split: train
    path: hand-browser/shard-*.json.gz
- config_name: subq_reviews
  data_files:
  - split: train
    path: subq/*.json
---

# Labbit: trajectories, Muse proposals, and SubQ visual reviews

Live explorer: https://hand-studio.hidden-pond-5e6a.workers.dev

Source: https://github.com/nayeonshin/aie-code-summit-2026-hackathon

## Separate data roles

- **MuJoCo produces the physics trajectories**: geometry transforms, object motion, contacts, and measured numerical outcomes.
- **Muse Wonder proposes physical parameters and diversity rationale**: task, shape, size, mass, friction, start/goal positions, speed, lift height and curved transport paths. Its proposals are not successful trajectories or labels.
- **SubQ Snap reviews images**: advisory movement and coordination classifications, stored separately with input hashes. The existing saved reviews are hand-only samples; their source-run association was not recorded. They are **not falsely attached to tabletop episodes**.

## Files and counts

`catalog.json` is the authoritative published inventory. `tabletop/index.json` lists completed tabletop episodes and measurements. `muse/scenarios.json` lists **1,000 planned scenarios** derived from real Muse anchors with deterministic seeded jitter. **100 tabletop trajectories** have been computed and exported; do not confuse planned and recorded counts. The raw plan records the exact accepted anchor count.

Use the Hugging Face Dataset Viewer's **configuration selector** to switch between the compact tabletop overview, full trajectories, Muse scenarios, separate native/browser pilots, and SubQ reviews. The default overview contains one row per completed tabletop study with physical parameters, Muse attribution and measured outcomes. `subq_reviewed=false` means no tabletop visual review exists; it is not an inferred classification.

- `tabletop/episode-*.json.gz`: 12-second tabletop episodes, 361 frames at 30 Hz including the initial state, plus geometry, parameters and provenance.
- `muse/tabletop-plan.json`: raw structured Muse plan, model, plan ID, time and usage; `muse/scenarios.json`: applied scenario parameters.
- `hand-browser/`: 100 archived 20-second hand-only production episodes and their immutable manifest/checksums. These use a four-finger LEAP model and 28 Muse parameter anchors.
- `hand-native/`: 290 archived hand-only native episodes across three pilots. Native/browser controllers and MuJoCo versions differ; do not pool them without checking provenance.
- `subq/`: separately saved advisory visual reviews; no fabricated tabletop reviews.

## Grip correction and validation

The tabletop wrist is oriented with the palmar side facing the object. Fingertip targets are calibrated using MuJoCo articulated kinematics. The object-local wrist offset rotates consistently during pouring; cups are held from the side rather than with the back of the hand. Exports include palm position, palmar normal, grasp center and holding state for checking alignment.

## Important limitations

This dataset is **assisted manipulation, not an autonomous grasping benchmark**. A mocap wrist and temporary weld constraint transport grasped objects; hand collisions are disabled. Released bodies and contact-driven pushes use actual MuJoCo rigid-body dynamics. No learned manipulation policy is claimed.

Scenario fields preserve the Muse proposal inputs; **not every field applies to every task**. Pouring uses fixed source-cup geometry (49 mm wall-center radius, 115 g cup mass) and 180 mm lift clearance; its proposed solid `shape`, `size`, `mass`, `lift` and `lateral` do not override that calibrated cup. Pouring still varies source/receiver placement, speed and table friction. Pushing uses a straight contact sweep, so proposed lift/transport curvature do not apply. The overview separates actual object mass/solid extent from `muse_proposed_*` fields; do not treat ignored proposals as physical measurements.

The five-finger / 20-actuator tabletop hand is a custom geometry extension of the licensed four-finger LEAP model, not a calibrated five-finger robot. Pouring uses **36 discrete rigid particles**, not a continuum fluid solver, water volume measurement, or real-world pouring guarantee. Source/receiver cup geometry and pouring clearance remain calibrated rather than AI-generated.

SubQ reviews and tracking scores are advisory/proxy measurements, not safety or grasp-success ground truth. Inspect failures, model/controller revisions, durations and units before using the data for training or evaluation.

## Read a tabletop episode

```python
import gzip
import json
from huggingface_hub import hf_hub_download

path = hf_hub_download('MedSalim/labbit-robotic-manipulation', 'tabletop/episode-0001.json.gz', repo_type='dataset')
with gzip.open(path, 'rt', encoding='utf-8') as file:
    episode = json.load(file)
print(episode['scenario']['proposal'])  # Muse input attribution
print(episode['provenance'])            # actual physics/controller
print(episode['metrics'])               # measured simulation output
```

## Privacy and license

Exports include only allowlisted trajectories, structured model proposals, saved review outputs and public manifests. Credentials, admin tokens, `.env` files, worker logs and private configuration are excluded. The original robot geometry license is retained in `ROBOT_MODEL_LICENSE`; refer to it for geometry reuse. Dataset documentation and newly generated trajectory exports are CC BY 4.0.
