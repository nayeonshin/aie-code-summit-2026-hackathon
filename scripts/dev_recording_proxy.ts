import type { Plugin } from 'vite';
import inventory from '../config/tabletop-recordings.json';

// Never copy localhost headers to the deployed Worker (including custom tokens).
export function publicRecordingProxy(target = 'https://labbit.science'): Plugin {
  const prefix = `/api/tabletop/recordings/${inventory.revision}/`;
  const paths = new Set([...inventory.episodes, ...Object.values(inventory.meshes)].map(entry => prefix + entry.file));
  return { name: 'public-recording-read', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (!request.url?.startsWith('/api/tabletop/recordings')) return next();
      const reject = (status: number) => { response.statusCode = status; response.end(); };
      if (request.method !== 'GET') return reject(405);
      if (request.url.includes('?')) return reject(400);
      if (!paths.has(request.url)) return reject(404);
      const controller = new AbortController();
      response.on('close', () => controller.abort());
      void (async () => {
        try {
          const upstream = await fetch(target + request.url, { redirect: 'error', headers: { Accept: 'application/octet-stream' }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]) });
          const bytes = new Uint8Array(await upstream.arrayBuffer());
          response.statusCode = upstream.status;
          // Only public response metadata, never cookies or authentication.
          for (const header of ['content-type', 'cache-control', 'etag', 'x-content-type-options']) {
            const value = upstream.headers.get(header); if (value) response.setHeader(header, value);
          }
          response.end(bytes);
        } catch { if (!response.destroyed) reject(502); }
      })();
    });
  } };
}
