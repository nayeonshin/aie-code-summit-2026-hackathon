import assert from 'node:assert/strict';
import { build } from 'esbuild';

const result = await build({ entryPoints: ['src/asset-fetch.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { fetchAsset, withAbort } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
const originalFetch = globalThis.fetch;
try {
  for (const failure of [() => { throw new TypeError('Load failed'); }, () => new Response(null, { status: 503 }), () => ({ ok: true, arrayBuffer: async () => { throw new TypeError('Load failed'); } })]) {
    let calls = 0;
    globalThis.fetch = async () => ++calls === 1 ? failure() : new Response(new Uint8Array([1, 2, 3]));
    assert.deepEqual(await fetchAsset('/test', 'Physics module'), new Uint8Array([1, 2, 3]));
    assert.equal(calls, 2);
  }
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError('Load failed'); };
  await assert.rejects(fetchAsset('/test', 'Robot manifest'), /Robot manifest failed to download/);
  assert.equal(calls, 3);
  const controller = new AbortController(); calls = 0;
  globalThis.fetch = async (_, { signal }) => {
    calls++;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  const pending = fetchAsset('/test', 'Recording', controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1, 'Cancelled downloads must not retry');
  let release;
  const shared = new Promise(resolve => { release = resolve; });
  const consumer = new AbortController();
  const obsolete = withAbort(shared, consumer.signal);
  const current = withAbort(shared, new AbortController().signal);
  consumer.abort();
  await assert.rejects(obsolete, { name: 'AbortError' });
  release('reusable mesh');
  assert.equal(await current, 'reusable mesh', 'Cancelling one consumer must preserve the shared download');
  console.log('Asset network, HTTP, interrupted body, exhausted retry, and cancellation checks passed.');
} finally { globalThis.fetch = originalFetch; }
