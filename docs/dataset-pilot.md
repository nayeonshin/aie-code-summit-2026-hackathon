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

## PR #4 review fixes

- Development replay now uses an exact pinned-file GET allowlist and constructs fresh public headers before the localhost-to-Worker hop. Cookies, authorization, custom tokens and upstream cookies are not forwarded; queries and other methods are rejected locally.
- Conversion verifies indexed standalone compressed sizes/checksums when present. New compact trajectories use immutable SHA-256 filenames, so interrupted rebuilds leave the previous index and all its payloads usable. The loader retains compatibility with the already-published episode filenames; the pinned dataset is unchanged.
- Inventory outages (including HTML 503 responses) surface errors rather than silently computing published studies. Only 404, or successful HTML in Vite development, means an absent inventory.
- New selections cancel obsolete trajectory downloads/retry waits. Cancelled consumers detach from shared mesh promises without cancelling reusable geometry; stale results/errors are discarded.
- Re-review: cancelled on-demand studies also detach from the shared engine initialization and pending tabletop robot assets. Published replay does not wait for abandoned model downloads, and cancelled studies never start simulation when those assets later arrive. Engine initialization remains reusable and resets on failure.
- The Vite proxy regression creates its temp parent when absent and removes its unique cache directory in teardown, including setup/assertion failures. It was also checked with an initially empty `TMPDIR`.
- Preview capture checks the app's displayed dataset revision and trajectory checksum against the local inventory before taking any frames. Mismatched attribution aborts capture.

## Validation

- `python -m pytest -q`: **41 tests passed**, including indexed source corruption and interrupted rebuild regressions.
- `PLAYWRIGHT_CHROME=1 npm run test:e2e -- tests/browser/{tabletop,grid,recovery,studio,recordings}.spec.ts --workers=1`: **19 tests passed**, including stalled-selection cancellation at both engine and tabletop manifest/asset downloads, inventory outages, a 25-view on-demand grid and keyboard/mobile coverage. A two-worker run passed 18 tests but timed out creating one Chrome context before test execution; the complete serial rerun passed.
- WebKit recorded replay/dropdown suite: **10 tests passed**, including all four stalled physics-download transitions and recorded-to-recorded cancellation.
- `npm run test:recordings`: all 100 exact browser-loader round trips; 10 shared mesh downloads; mismatched-scenario exclusion and corrupt-download recovery passed.
- `npm run test:recording-proxy`: fixed revision/file allowlist, credential stripping, checksum rejection and immutable cache passed without external requests.
- `npm run test:dev-recording-proxy`: actual Vite-to-upstream credential/header filtering and method/path/revision/query restrictions passed against a local HTTP server, including an empty-temp-parent run with cache cleanup verified.
- `npm run test:recording-review`: production/development inventory fallback policy, immutable filenames and preview identity mismatch rejection passed.
- `npm run test:assets`, `npm run test:cloud`, and `npm run build:cloud`: passed.

## Reproduce the visuals

```sh
node scripts/render_tabletop_previews.mjs
# Use the capture.json path printed above. Pillow is needed by the encoder.
python -m pip install Pillow
python scripts/encode_tabletop_previews.py /path/to/capture.json
```

The capture step blocks model downloads and verifies the displayed revision and trajectory SHA-256 against the local inventory; it scrubs actual 30 Hz recorded frames at every third frame. GIFs are 640×480, 10 Hz documentation previews. Their display color quantization does not change the underlying dataset. Captured PNGs remain outside Git; only the four small GIFs and public provenance metadata are committed/published.

## Next campaign gate

Choose a tabletop SubQ review count and an explicit spending cap before any paid requests. Define task-success thresholds separately from numerical validity, especially for the existing large pushing errors. Sample successes and failures; link every future review to the exact dataset revision, trajectory hash, scenario ID and frame timestamps. Do not label advisory image review as physical safety or autonomous grasp success.

Then agree on additional episode IDs/counts, task balance and split strategy. Parallel physics workers must own distinct output directories or immutable shards, with a single validated consolidation step. The existing 1,000-scenario Muse plan needs no new paid proposal calls.
