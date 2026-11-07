import type { Description, State } from './renderer';
import type { Episode } from './wasm-engine';

export const getAdminToken = () => sessionStorage.getItem('labbit-admin') ?? sessionStorage.getItem('labit-admin') ?? sessionStorage.getItem('hand-studio-admin') ?? '';
export const setAdminToken = (token: string) => sessionStorage.setItem('labbit-admin', token.trim());

export async function cloudFetch(url: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (getAdminToken()) headers.set('Authorization', `Bearer ${getAdminToken()}`);
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.detail ?? `Cloud request failed (${response.status}).`); }
  return response.json();
}

type Manifest = { id: string; attempted: number; status: string; config: { count: number; seconds: number; seed: number; variants?: unknown[]; provenance?: Record<string, unknown> } };
type RPC = { worker: Worker; resolve: (data: any) => void; reject: (error: Error) => void };
export class CloudRuntime {
  readyState: number = WebSocket.OPEN;
  description!: Description;
  provenance!: Record<string, unknown>;
  onlive?: (states: State[]) => void;
  onerror?: (error: string) => void;
  private liveWorker = new Worker(new URL('./physics.worker.ts', import.meta.url), { type: 'module' });
  private batchWorker?: Worker;
  private requests = new Map<string, RPC>();
  private cancelled = new Set<string>();
  private active = false;
  async init() {
    try {
      const data = await this.initialize(this.liveWorker);
      this.description = data.description; this.provenance = data.provenance;
      return this;
    } catch (error) { this.close(); throw error; }
  }
  private initialize(worker: Worker): Promise<any> {
    return new Promise((resolve, reject) => {
      const fail = (message: string) => { const error = new Error(message); reject(error); this.rejectWorker(worker, error); this.onerror?.(message); };
      worker.onerror = event => fail(event.message || 'Physics worker crashed.');
      worker.onmessageerror = () => fail('Physics worker response could not be decoded.');
      worker.onmessage = event => {
        const data = event.data;
        if (data.type === 'ready') resolve(data);
        else if (data.type === 'live' && worker === this.liveWorker) this.onlive?.(data.states);
        else if (data.id) {
          const request = this.requests.get(data.id); this.requests.delete(data.id);
          if (data.type === 'error') request?.reject(new Error(data.error)); else request?.resolve(data);
        } else if (data.type === 'error') { reject(new Error(data.error)); this.onerror?.(data.error); }
      };
      worker.postMessage({ type: 'init' });
    });
  }
  private rpc(worker: Worker, type: string, data: object): Promise<any> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => { this.requests.set(id, { worker, resolve, reject }); try { worker.postMessage({ type, id, ...data }); } catch (error) { this.requests.delete(id); reject(error as Error); } });
  }
  private rejectWorker(worker: Worker, error: Error) { for (const [id, request] of this.requests) if (request.worker === worker) { this.requests.delete(id); request.reject(error); } }
  send(data: string) { this.liveWorker.postMessage({ type: 'command', ...JSON.parse(data) }); }
  close() { this.readyState = WebSocket.CLOSED; this.rejectWorker(this.liveWorker, new Error('Workspace closed.')); this.liveWorker.terminate(); if (this.batchWorker) { this.rejectWorker(this.batchWorker, new Error('Workspace closed.')); this.batchWorker.terminate(); } }
  async api(url: string, options?: RequestInit): Promise<any> {
    if (url === '/api/runs' && options?.method === 'POST') {
      if (this.active) throw new Error('This tab is already generating a dataset.');
      const input = JSON.parse(options.body as string);
      const run = await cloudFetch(url, { ...options, body: JSON.stringify({ ...input, provenance: this.provenance }) });
      void this.generate(run.id); return run;
    }
    const control = url.match(/^\/api\/runs\/([a-z0-9-]+)\/(cancel|resume)$/);
    if (control) {
      const [, id, command] = control;
      if (command === 'cancel') this.cancelled.add(id);
      if (command === 'resume' && this.active) throw new Error('This tab is already generating a dataset.');
      const result = await cloudFetch(url, options);
      if (command === 'resume') { this.cancelled.delete(id); void this.generate(id); }
      return result;
    }
    const episode = url.match(/^\/api\/runs\/([a-z0-9-]+)\/episodes\/(\d+)$/);
    if (episode) {
      const row = await cloudFetch(url);
      const result = await this.rpc(this.liveWorker, 'replay', { row });
      return { frames: result.frames, recipe: row.recipe, valid: row.valid };
    }
    return cloudFetch(url, options);
  }
  private async generate(id: string) {
    this.active = true;
    try {
      if (!this.batchWorker) {
        this.batchWorker = new Worker(new URL('./physics.worker.ts', import.meta.url), { type: 'module' });
        await this.initialize(this.batchWorker);
        this.batchWorker.postMessage({ type: 'command', paused: true });
      }
      let manifest: Manifest = await cloudFetch(`/api/runs/${id}`);
      for (const field of ['mujoco_version', 'model_sha256', 'recipe_version', 'controller_version', 'rng']) {
        if (manifest.config.provenance?.[field] !== this.provenance[field]) throw new Error('Cannot resume after the physics model/runtime changed. Start a new run.');
      }
      while (manifest.status === 'running' && manifest.attempted < manifest.config.count && !this.cancelled.has(id) && this.readyState !== WebSocket.CLOSED) {
        const { rows }: { rows: Episode[] } = await this.rpc(this.batchWorker, 'batch', { ...manifest.config, first: manifest.attempted, size: 10 });
        const stream = new Blob([JSON.stringify(rows)]).stream().pipeThrough(new CompressionStream('gzip'));
        const compressed = await new Response(stream).arrayBuffer();
        // Retry the same immutable shard. The server accepts duplicates idempotently.
        for (let attempt = 0; ; attempt++) {
          try { manifest = await cloudFetch(`/api/runs/${id}/shards/${rows[0].episode_id}`, { method: 'PUT', headers: { 'Content-Type': 'application/gzip' }, body: compressed }); break; }
          catch (error) {
            // Another client may have cancelled while this batch was computing.
            const latest: Manifest = await cloudFetch(`/api/runs/${id}`);
            if (latest.status !== 'running') return;
            if (attempt >= 3) throw error; await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
          }
        }
      }
    } catch (error) {
      this.batchWorker?.terminate(); this.batchWorker = undefined;
      this.onerror?.((error as Error).message);
      if (this.readyState !== WebSocket.CLOSED) await cloudFetch(`/api/runs/${id}/pause`, { method: 'POST' }).catch(() => {});
    } finally { this.active = false; }
  }
}
