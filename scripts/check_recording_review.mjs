import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { verifyPreviewIdentity } from './tabletop_preview_identity.mjs';

const originalFetch = globalThis.fetch;
try {
  for (const dev of [false, true]) {
    const bundle = await build({ entryPoints: ['src/tabletop-recordings.ts'], bundle: true, platform: 'node', format: 'esm', write: false, define: { 'import.meta.env.DEV': String(dev) } });
    const { TabletopRecordings, validateRecordingManifest } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
    globalThis.fetch = async () => new Response('', { status: 404 });
    assert.equal(await TabletopRecordings.open(), null);
    for (const status of [401, 502, 503]) {
      globalThis.fetch = async () => new Response('<h1>Unavailable</h1>', { status, headers: { 'Content-Type': 'text/html' } });
      await assert.rejects(TabletopRecordings.open(), new RegExp(`HTTP ${status}`));
    }
    globalThis.fetch = async () => new Response('<html>Vite SPA</html>', { headers: { 'Content-Type': 'text/html' } });
    if (dev) assert.equal(await TabletopRecordings.open(), null);
    else await assert.rejects(TabletopRecordings.open());
    // Load the pinned inventory without making external requests.
    const inventory = JSON.parse(readFileSync('config/tabletop-recordings.json'));
    const entry = inventory.episodes[0];
    const immutable = structuredClone(inventory);
    immutable.episodes[0].file = `compact/${entry.sha256}.json.gz`;
    validateRecordingManifest(immutable);
    immutable.episodes[0].file = `compact/${'f'.repeat(64)}.json.gz`;
    assert.throws(() => validateRecordingManifest(immutable), /descriptor/);
  }
  const inventory = { revision: 'a'.repeat(40) }, entry = { sha256: 'b'.repeat(64) };
  const identity = `Published recording; no physics recomputation.\nDataset revision: ${inventory.revision}\nTrajectory SHA-256: ${entry.sha256}`;
  verifyPreviewIdentity(identity, inventory, entry);
  assert.throws(() => verifyPreviewIdentity(identity.replace(inventory.revision, 'c'.repeat(40)), inventory, entry), /revision differs/);
  assert.throws(() => verifyPreviewIdentity(identity.replace(entry.sha256, 'd'.repeat(64)), inventory, entry), /checksum differs/);
  assert.throws(() => verifyPreviewIdentity('Computed on demand in this browser.', inventory, entry));
  console.log('Production/development inventory failure policy, immutable trajectory validation, and preview revision/checksum mismatch checks passed.');
} finally { globalThis.fetch = originalFetch; }
