import assert from 'node:assert/strict';
import { createServer as createHTTPServer } from 'node:http';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['scripts/dev_recording_proxy.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { publicRecordingProxy } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const inventory = JSON.parse(readFileSync('config/tabletop-recordings.json'));
const path = `/api/tabletop/recordings/${inventory.revision}/${inventory.episodes[0].file}`;
const received = [];
const upstream = createHTTPServer((request, response) => {
  received.push({ method: request.method, url: request.url, headers: request.headers });
  response.setHeader('Content-Type', 'application/gzip');
  response.setHeader('Set-Cookie', 'upstream-secret=value');
  response.end('public recording');
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const cacheDir = mkdtempSync(join(tmpdir(), 'opencode/labbit-proxy-test-'));
const vite = await createServer({ configFile: false, cacheDir, optimizeDeps: { noDiscovery: true, include: [], entries: [] }, plugins: [publicRecordingProxy(`http://127.0.0.1:${upstream.address().port}`)], server: { host: '127.0.0.1', port: 0 } });
try {
  await vite.listen();
  const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const response = await fetch(base + path, { headers: { Cookie: 'local-secret=value', Authorization: 'Bearer local-secret', Origin: 'http://localhost:5173', 'X-Admin-Token': 'local-secret', 'X-Custom-Secret': 'local-secret' } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'public recording');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(received.length, 1);
  assert.equal(received[0].method, 'GET');
  assert.equal(received[0].url, path);
  assert.equal(received[0].headers.accept, 'application/octet-stream');
  for (const header of ['cookie', 'authorization', 'origin', 'x-admin-token', 'x-custom-secret']) assert.equal(received[0].headers[header], undefined);
  for (const [url, method, status] of [[path, 'POST', 405], [path, 'HEAD', 405], [path + '?token=secret', 'GET', 400], [path.replace(inventory.revision, 'b'.repeat(40)), 'GET', 404], ['/api/tabletop/recordings/not-allowed', 'GET', 404], [path + '/extra', 'GET', 404]]) {
    assert.equal((await fetch(base + url, { method })).status, status);
  }
  assert.equal(received.length, 1, 'Invalid requests must never leave localhost');
  console.log('Actual Vite-to-upstream public read: credential stripping, response filtering, method/path/revision/query restrictions passed.');
} finally {
  await vite.close();
  await new Promise(resolve => upstream.close(resolve));
}
