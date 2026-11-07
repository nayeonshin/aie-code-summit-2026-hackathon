// No network, R2 writes, or AI spend: exercise coordinator and client regressions.
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
async function bundled(path) { const result = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false }); return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')); }
const { Coordinator } = await bundled('cloudflare/worker.ts');
const { schedule } = await bundled('src/objectives.ts');
const NativeRequest = globalThis.Request;
globalThis.Request = class extends NativeRequest { constructor(url, options = {}) { super(url, { ...options, ...(options.body instanceof ReadableStream ? { duplex: 'half' } : {}) }); } };
const store = new Map();
const env = { DATA: { get: async key => store.has(key) ? { json: async () => JSON.parse(store.get(key)) } : null, put: async (key, value) => { store.set(key, typeof value === 'string' ? value : value); } } };
const coordinator = new Coordinator({ storage: { get: async () => 0, put: async () => {} } }, env);
const request = (path, method, body) => coordinator.fetch(new Request('https://lab.test' + path, { method, body: body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) }));
const run = await (await request('/api/runs', 'POST', { count: 20, seconds: 20, seed: 42 })).json();
function row(index) { return { episode_id: index, recipe: schedule(20, 42)[index], seconds: 20, time: Array.from({ length: 600 }, (_, i) => (i + 1) / 30), contacts: Array(600).fill(0), valid: true, objective_pass: true, ...Object.fromEntries(['qpos', 'qvel', 'ctrl', 'actuator_force', 'external_force'].map(key => [key, Array.from({ length: 600 }, () => Array(16).fill(0))])) }; }
const upload = rows => request(`/api/runs/${run.id}/shards/${rows[0].episode_id}`, 'PUT', new Uint8Array(gzipSync(JSON.stringify(rows))));
const initial = await upload([row(0)]);
assert.equal(initial.status, 200, await initial.text());
await request(`/api/runs/${run.id}/cancel`, 'POST'); // Tab B cancels while tab A holds its next batch.
assert.equal((await upload([row(0)])).status, 200); // Already-committed immutable shard remains idempotent.
assert.equal((await upload([row(1)])).status, 409);
await request(`/api/runs/${run.id}/pause`, 'POST');
let saved = JSON.parse(store.get(`runs/${run.id}/manifest.json`));
assert.equal(saved.status, 'cancelled'); assert.equal(saved.attempted, 1);
await request(`/api/runs/${run.id}/resume`, 'POST');
const mutations = [r => { r.time = 'x'.repeat(600); }, r => { r.time[1] = r.time[0]; }, r => { r.time[1] = null; }, r => { r.contacts = []; }, r => { r.contacts[0] = -1; }, r => { r.contacts[0] = .5; }, r => { r.valid = 'true'; }, r => { r.valid = false; r.objective_pass = true; }, r => { r.objective_pass = 1; }];
for (const mutate of mutations) { const next = row(1); mutate(next); assert.equal((await upload([next])).status, 400); assert.equal(JSON.parse(store.get(`runs/${run.id}/manifest.json`)).attempted, 1); }
assert.equal((await upload([row(1)])).status, 200);
console.log('Coordinator: two-client cancellation, idempotency, explicit resume, and invalid-shard rejection passed.');

await build({ entryPoints: ['src/cloud-runtime.ts'], bundle: true, platform: 'node', format: 'esm', outfile: 'test-results/cloud-runtime-test.mjs' });
const { CloudRuntime } = await import('../test-results/cloud-runtime-test.mjs');
globalThis.WebSocket = { OPEN: 1, CLOSED: 3 };
globalThis.sessionStorage = { getItem: () => null };
let crashNext = true, cancelDuringBatch = false, pauses = 0, commits = 0;
const manifest = { id: 'client-test', status: 'running', attempted: 0, config: { count: 1, provenance: {} } };
globalThis.Worker = class {
  postMessage(data) {
    queueMicrotask(() => {
      if (data.type === 'init') this.onmessage?.({ data: { type: 'ready', description: {}, provenance: {} } });
      if (data.type === 'batch') {
        if (crashNext) { crashNext = false; this.onerror?.({ message: 'Injected batch-worker crash' }); }
        else { if (cancelDuringBatch) manifest.status = 'cancelled'; this.onmessage?.({ data: { type: 'result', id: data.id, rows: [row(0)] } }); }
      }
    });
  }
  terminate() {}
};
globalThis.fetch = async (url, options = {}) => {
  if (url.endsWith('/pause')) { pauses++; if (manifest.status === 'running') manifest.status = 'interrupted'; }
  if (url.includes('/shards/')) {
    if (manifest.status !== 'running') return Response.json({ detail: 'Run cancelled' }, { status: 409 });
    commits++; manifest.attempted = 1; manifest.status = 'complete';
  }
  return Response.json(manifest);
};
const runtime = await new CloudRuntime().init();
await runtime.generate(manifest.id);
assert.equal(runtime.active, false); assert.equal(runtime.requests.size, 0); assert.equal(pauses, 1);
manifest.status = 'running';
await runtime.generate(manifest.id);
assert.equal(runtime.active, false); assert.equal(commits, 1); assert.equal(manifest.status, 'complete');
manifest.status = 'running'; manifest.attempted = 0; cancelDuringBatch = true;
await runtime.generate(manifest.id);
assert.equal(runtime.active, false); assert.equal(pauses, 1); assert.equal(manifest.status, 'cancelled'); assert.equal(commits, 1);
runtime.close();
console.log('Client: ready-then-crash rejects pending batch, releases active state, resumes, and honors remote cancellation without pause overwrite.');
