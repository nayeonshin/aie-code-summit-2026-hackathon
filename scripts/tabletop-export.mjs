import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export const fingerprint = collection => createHash('sha256').update(JSON.stringify(collection, null, 2)).digest('hex');
// ``collection`` is the hand/Muse plan, whose identity a saved export keeps; ``arm`` is the
// seeded SO-101 studies, appended after it (ids collection.length ..) with their own fingerprint.
export function validateIndex(index, collection, arm = []) {
  assert.equal(index.planned, collection.length, 'Export collection size changed');
  if (index.arm_planned !== undefined) assert.equal(index.arm_planned, arm.length, 'Export arm study count changed');
  assert.equal(index.recorded, index.studies.length, 'Recorded count mismatch');
  const ids = new Set(), files = new Set();
  for (const study of index.studies) {
    assert.ok(!ids.has(study.id) && !files.has(study.file), 'Duplicate export ID or filename');
    ids.add(study.id); files.add(study.file);
    assert.equal(study.file, `episode-${String(study.id + 1).padStart(4, '0')}.json.gz`);
    const { metrics, provenance, frames, file, bytes, sha256, ...scenario } = study;
    const planned = study.id < collection.length ? collection[study.id] : arm[study.id - collection.length];
    assert.ok(planned, 'Export ID outside the plan');
    assert.deepEqual(scenario, planned, 'Index scenario differs from export plan');
  }
}
export function validatePartial(index, savedCollection, collection, arm = []) {
  const hash = fingerprint(collection);
  assert.equal(fingerprint(savedCollection), hash, 'Partial export plan fingerprint mismatch; use a new export directory');
  if (index.plan_fingerprint) assert.equal(index.plan_fingerprint, hash, 'Saved index plan fingerprint mismatch');
  if (index.arm_fingerprint) assert.equal(index.arm_fingerprint, fingerprint(arm), 'Saved index arm study fingerprint mismatch');
  validateIndex(index, collection, arm);
}
