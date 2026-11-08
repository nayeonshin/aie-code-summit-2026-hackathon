# Compact recording pilot

## Completed without paid inference

- Reused the 100 already-published tabletop recordings; did not inflate scenario/episode counts by converting them.
- Four local conversion workers produced lossless compact copies. Ten meshes are shared by content hash.
- Compact payloads: 132.7 MB versus 1,077.1 MB for standalone copies (~88% reduction). Original standalone trajectories remain available; total Hugging Face storage grows because this release is additive.
- Every decoded frame, contact/grip value, parameter, metric and provenance field round-tripped exactly in Python and the browser loader. No 30 Hz frames were dropped or quantized in the dataset.
- Published compact files and manifest to Hugging Face; frontend snapshot pinned to commit `c8d71416e9d4a798950e11a3b3a94a9b8264f3a6`.
- Single/Grid playback loads matching recorded scenarios without MuJoCo initialization. Unrecorded/different-plan scenarios compute on demand. Integrity failures show Retry rather than silently substituting newly computed data.
- Archived four-finger data and hand-only SubQ reviews remain separate. No tabletop visual reviews were invented.
- Confirmed PRs #1/#2 are merged; follow-up branch is based on current `main`.
- Fixed real-browser Hugging Face resolver CORS failures with a same-origin, read-only, pinned-file allowlist. The edge verifies bytes before immutable caching and never forwards browser credentials. Chrome/WebKit published Single + four-view Grid smoke checks passed with zero model downloads.
- Rendered four task GIFs from exact published frames. Documentation now explains motion/perception/debugging uses, missing low-level action telemetry, honest failed-push outcomes and the absence of curated evaluation splits. Visual hashes/revisions/frame indices are saved in `docs/media/previews.json`.
- Published and byte-verified the four GIFs and visual dataset card at Hugging Face commit `29bce2f0ed4b243dcd314e74b4a9295737ea7aac`. Replay remains pinned to the original compact-data commit; a documentation-only update does not change recorded data identity.
- Replaced native task/view-count/speed selects with styled, keyboard-accessible dropdowns.

## Validation

- `python -m pytest -q`: 35 tests passed.
- `PLAYWRIGHT_CHROME=1 npm run test:e2e -- --workers=3`: **14 tests passed**, including recorded-playback/recovery checks, a 25-view on-demand grid and styled-dropdown keyboard/mobile coverage. Three workers bound concurrent real-MuJoCo/GPU resource use; a five-worker stress run encountered a Chrome context-startup timeout before test execution.
- WebKit recorded replay/dropdown suite: **5 tests passed**, including pointer focus and Escape dismissal.
- `npm run test:recordings`: all 100 exact browser-loader round trips; 10 shared mesh downloads; mismatched-scenario exclusion and corrupt-download recovery passed.
- `npm run test:recording-proxy`: fixed revision/file allowlist, credential stripping, checksum rejection and immutable cache passed without external requests.

## Reproduce the visuals

```sh
node scripts/render_tabletop_previews.mjs
# Use the capture.json path printed above. Pillow is needed by the encoder.
python -m pip install Pillow
python scripts/encode_tabletop_previews.py /path/to/capture.json
```

The capture step blocks model downloads and checks published playback attribution; it scrubs actual 30 Hz recorded frames at every third frame. GIFs are 640×480, 10 Hz documentation previews. Their display color quantization does not change the underlying dataset. Captured PNGs remain outside Git; only the four small GIFs and public provenance metadata are committed/published.

## Next campaign gate

Choose a tabletop SubQ review count and an explicit spending cap before any paid requests. Define task-success thresholds separately from numerical validity, especially for the existing large pushing errors. Sample successes and failures; link every future review to the exact dataset revision, trajectory hash, scenario ID and frame timestamps. Do not label advisory image review as physical safety or autonomous grasp success.

Then agree on additional episode IDs/counts, task balance and split strategy. Parallel physics workers must own distinct output directories or immutable shards, with a single validated consolidation step. The existing 1,000-scenario Muse plan needs no new paid proposal calls.
