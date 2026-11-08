import inventory from '../config/tabletop-recordings.json';

// Fixed public dataset/revision/file allowlist, never an arbitrary URL proxy.
export async function recordingResponse(request: Request, cache?: Cache): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== 'GET') return Response.json({ detail: 'Recordings are read-only.' }, { status: 405 });
  if (url.search) return Response.json({ detail: 'Unexpected recording query.' }, { status: 400 });
  const prefix = `/api/tabletop/recordings/${inventory.revision}/`;
  const file = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '';
  const descriptor = inventory.episodes.find(entry => entry.file === file) ?? Object.values(inventory.meshes).find(entry => entry.file === file);
  if (!descriptor) return Response.json({ detail: 'Unknown recording revision or file.' }, { status: 404 });
  const cacheKey = new Request(url.origin + url.pathname);
  try { const cached = await cache?.match(cacheKey); if (cached) return cached; } catch { /* Serve verified bytes if edge cache is unavailable. */ }
  // Do not forward browser Origin, cookies, admin tokens or authorization.
  const upstream = await fetch(inventory.base_url + file, { redirect: 'follow', headers: { Accept: 'application/octet-stream' }, signal: AbortSignal.timeout(90000) });
  if (!upstream.ok || !upstream.body) return Response.json({ detail: `Published recording upstream returned HTTP ${upstream.status}.` }, { status: 502 });
  const reader = upstream.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.length;
    if (size > descriptor.bytes || size > 16 * 1024 * 1024) { await reader.cancel(); return Response.json({ detail: 'Published recording size mismatch.' }, { status: 502 }); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
  if (size !== descriptor.bytes || hash !== descriptor.sha256) return Response.json({ detail: 'Published recording checksum mismatch.' }, { status: 502 });
  const response = new Response(bytes, { headers: { 'Content-Type': 'application/gzip', 'Content-Length': String(size), 'Cache-Control': 'public, max-age=31536000, immutable', ETag: `"${hash}"`, 'X-Content-Type-Options': 'nosniff' } });
  try { await cache?.put(cacheKey, response.clone()); } catch { /* Cache failures must not prevent verified replay. */ }
  return response;
}
