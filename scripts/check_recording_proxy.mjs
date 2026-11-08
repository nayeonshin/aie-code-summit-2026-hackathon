import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
const result = await build({ entryPoints: ['cloudflare/tabletop-recordings.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { recordingResponse } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
const inventory = JSON.parse(readFileSync('config/tabletop-recordings.json'));
const entry = inventory.episodes[0], bytes = readFileSync('data/publish/tabletop/' + entry.file);
const original = globalThis.fetch; let calls = 0, corrupt = false;
const storage = new Map(), cache = { match: async request => storage.get(request.url)?.clone(), put: async (request, response) => storage.set(request.url, response) };
globalThis.fetch = async (url, options) => {
  calls++; assert.equal(url, inventory.base_url + entry.file);
  assert.deepEqual(options.headers, { Accept: 'application/octet-stream' });
  return new Response(corrupt ? Buffer.alloc(bytes.length) : bytes);
};
try {
  const path = `https://lab.test/api/tabletop/recordings/${inventory.revision}/${entry.file}`;
  assert.equal((await recordingResponse(new Request(path.replace(inventory.revision, 'b'.repeat(40))))).status, 404);
  assert.equal((await recordingResponse(new Request(path.replace(entry.file, 'private.json')))).status, 404);
  assert.equal((await recordingResponse(new Request(path + '?url=https://example.com'))).status, 400);
  assert.equal((await recordingResponse(new Request(path, { method: 'POST' }))).status, 405);
  assert.equal(calls, 0);
  corrupt = true; assert.equal((await recordingResponse(new Request(path), cache)).status, 502); assert.equal(storage.size, 0);
  corrupt = false;
  const response = await recordingResponse(new Request(path, { headers: { Authorization: 'private-test-token', Origin: 'https://lab.test' } }), cache);
  assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.match(response.headers.get('cache-control'), /immutable/);
  const before = calls; assert.equal((await recordingResponse(new Request(path), cache)).status, 200); assert.equal(calls, before);
  const unavailable = { match: async () => { throw new Error('cache unavailable'); }, put: async () => { throw new Error('cache unavailable'); } };
  assert.equal((await recordingResponse(new Request(path), unavailable)).status, 200);
  console.log('Read-only recording proxy: fixed revision/file allowlist, stripped request credentials, checksum validation and immutable cache passed.');
} finally { globalThis.fetch = original; }
