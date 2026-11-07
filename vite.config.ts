import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { gzipSync } from 'node:zlib';
export default defineConfig({ plugins: [react(), { name: 'precompress-physics', generateBundle(_, bundle) {
  for (const output of Object.values(bundle)) if (output.type === 'asset' && output.fileName.endsWith('.wasm')) {
    this.emitFile({ type: 'asset', fileName: output.fileName + '.gz', source: gzipSync(output.source) });
  }
} }], server: { proxy: { '/api': { target: 'http://127.0.0.1:8000', ws: true }, '/datasets': 'http://127.0.0.1:8000' } } });
