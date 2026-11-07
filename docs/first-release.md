# First app release gate

## Review/integration order

1. Re-review PR #2 (`feat/tabletop-manipulation-lab` → `feat/labbit-simulation-lab`).
2. After reviewer approval, merge #2 into #1's branch.
3. Re-review and merge PR #1 into `main`.
4. Only then plan a separately authorized, budgeted bulk Meta/SubQ generation campaign.

No review has been dismissed and no merge has been performed automatically. Do not spend the remaining AI credits simply because the app is deployed.

## Review fixes and evidence

| Finding | Fix | Regression coverage |
|---|---|---|
| Cancellation from another tab overwritten by uploads | Only running runs accept new shards; committed identical shards remain idempotent; terminal status stops the client | `npm run test:cloud` |
| Saved replay measurements lost | Recorded qvel, ctrl, contacts and forces preserved separately from forward kinematics | Python replay test + `npm run test:wasm` |
| Invalid immutable shards | Finite increasing times, integer contacts, Boolean/invariant flag checks | `npm run test:cloud` |
| Worker crash hangs generation | Reject pending RPCs for the failed worker; release active state | `npm run test:cloud` |
| Locale-dependent objective hash | Explicit UTF-8 decode | `tests/test_objective_encoding.py` |
| Hard-coded POSIX Python paths | Activated environment's `python -m ...` | Build/startup scripts and activation docs |
| Idle R2 polling | Catalog fetched on panel opening; poll only active progress while visible | `src/main.tsx` progress effects |
| Resume doesn't refresh the panel | Apply returned cloud row / refresh native list before polling | `tests/browser/recovery.spec.ts` |
| Stale status differs by route | Shared summary calculation for list and detail routes | `npm run test:cloud`, two-minute boundary |
| Rejected asset promise survives Retry | Clear cached promise on rejection | `node scripts/check_tabletop_retry.mjs` |
| Fresh checkout missing public assets | `predev` prepares model assets automatically | `npm run test:first-launch`, isolated checkout + real Chrome |
| Hand grabs from its back | Palm-facing wrist, MuJoCo fingertip IK, object-local side grip for cups | Baseline/Muse numerical alignment checks + Chrome/WebKit screenshots |

## Data release scope

- 1,000 Muse-derived scenarios are **planned**, not 1,000 completed recordings.
- 100 new tabletop trajectories and 390 archived hand-only episodes are packaged separately.
- 24 accepted real Muse anchors have explicit plan/model attribution.
- Two archived SubQ reviews remain hand-only, with unknown source-run association. No tabletop reviews are fabricated.
- Numerical validity is not task success. Some pushing demonstrations miss their target substantially; retain their measured errors.
- Grasp transport is assisted by a compliant weld; this is not a learned contact-grasp policy. Water is 36 rigid particles, not a continuum fluid solver.
- Data card, checksums, separate viewer configurations, provenance explorer and Hugging Face link are required for sharing the pilot.
- Exclude credentials, logs and private configuration from both Git and Hugging Face.

## Before large-scale generation

Agree on a budget and episode/review counts, task-success criteria, train/test splits and annotation linkage. Deduplicate common meshes and use compact trajectory storage before generating thousands of complete episodes; the pilot JSON exports include geometry for standalone inspection and are intentionally much larger. Do not pool historical native/browser or four/five-finger data without checking model/controller provenance.
