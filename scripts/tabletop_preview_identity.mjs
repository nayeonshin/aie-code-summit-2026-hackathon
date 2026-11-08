import assert from 'node:assert/strict';

export function verifyPreviewIdentity(identity, inventory, entry) {
  assert.match(identity, /Published recording; no physics recomputation/);
  assert.ok(identity.includes(`Dataset revision: ${inventory.revision}`), 'Preview app dataset revision differs from local inventory');
  assert.ok(identity.includes(`Trajectory SHA-256: ${entry.sha256}`), 'Preview app trajectory checksum differs from local inventory');
}
