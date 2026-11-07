import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export const fingerprint = collection => createHash('sha256').update(JSON.stringify(collection, null, 2)).digest('hex');
export function validateIndex(index, collection) {
  assert.equal(index.planned, collection.length, 'Export collection size changed');
  assert.equal(index.recorded, index.studies.length, 'Recorded count mismatch');
  const ids = new Set(), files = new Set();
  for (const study of index.studies) {
    assert.ok(!ids.has(study.id) && !files.has(study.file), 'Duplicate export ID or filename');
    ids.add(study.id); files.add(study.file);
    assert.equal(study.file, `episode-${String(study.id + 1).padStart(4, '0')}.json.gz`);
    const { metrics, provenance, frames, file, bytes, sha256, ...scenario } = study;
    assert.deepEqual(scenario, collection[study.id], 'Index scenario differs from export plan');
  }
}
export function validatePartial(index, savedCollection, collection) {
  const hash = fingerprint(collection);
  assert.equal(fingerprint(savedCollection), hash, 'Partial export plan fingerprint mismatch; use a new export directory');
  if (index.plan_fingerprint) assert.equal(index.plan_fingerprint, hash, 'Saved index plan fingerprint mismatch');
  validateIndex(index, collection);
}
