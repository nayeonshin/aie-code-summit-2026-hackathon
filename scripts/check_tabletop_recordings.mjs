import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { build } from 'esbuild';
await build({ entryPoints: ['src/tabletop-recordings.ts'], bundle: true, platform: 'node', format: 'esm', outfile: 'test-results/tabletop-recordings.mjs' });
const { TabletopRecordings, validateRecordingManifest } = await import('../test-results/tabletop-recordings.mjs');
const manifest = JSON.parse(readFileSync('data/publish/tabletop/compact/index.json'));
manifest.base_url = '/recordings/'; manifest.revision = 'a'.repeat(40);
validateRecordingManifest(manifest);
assert.throws(() => validateRecordingManifest({ ...manifest, episodes: [manifest.episodes[0], manifest.episodes[0]], recorded: 2 }), /Duplicate/);
assert.throws(() => validateRecordingManifest({ ...manifest, revision: 'main' }), /immutable/);
const recordings = new TabletopRecordings(manifest), originalFetch = globalThis.fetch;
let requests = 0, meshRequests = 0, corrupt = false;
globalThis.fetch = async url => {
  requests++; if (url.includes('/meshes/')) meshRequests++;
  return new Response(corrupt ? 'corrupt' : readFileSync('data/publish/tabletop/' + url.replace('/recordings/', '')));
};
try {
  for (const entry of manifest.episodes) {
    const replay = await recordings.load(entry.scenario);
    const { recording, ...episode } = replay;
    const original = JSON.parse(gunzipSync(readFileSync('data/publish/tabletop/' + entry.standalone_file)));
    assert.deepEqual(episode, original);
    assert.equal(recording.sha256, entry.sha256);
  }
  assert.equal(meshRequests, Object.keys(manifest.meshes).length);
  const reads = requests;
  assert.equal(await recordings.load({ ...manifest.episodes[0].scenario, seed: -1 }), null);
  assert.equal(requests, reads, 'Different live scenario must not fetch a mismatched recording');
  corrupt = true; await assert.rejects(recordings.load(manifest.episodes[0].scenario), /checksum mismatch/);
  corrupt = false; assert.ok(await recordings.load(manifest.episodes[0].scenario));
  console.log(`Verified exact browser-loader round trips for ${manifest.recorded} recordings; ${meshRequests} shared mesh downloads; mismatched-plan exclusion and corrupt-download recovery passed.`);
} finally { globalThis.fetch = originalFetch; }
