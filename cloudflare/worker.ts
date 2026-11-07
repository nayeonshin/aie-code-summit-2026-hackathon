import { plan, recipes, allocation, schedule, type Variant } from '../src/objectives';
import { validateTableVariants } from '../src/tabletop-scenarios';

interface Env { ASSETS: Fetcher; DATA: R2Bucket; COORDINATOR: DurableObjectNamespace; ADMIN_TOKEN: string; SUBQ_API_KEY?: string; MODEL_API_KEY?: string; META_MODEL: string; AI_BUDGET_USD: string }
type Manifest = { id: string; schema_version: number; status: string; attempted: number; valid: number; objective_passed: number; annotated: number; updated_at: string; coverage: Record<string, number>; shards: { file: string; first: number; episodes: number; sha256: string; bytes: number }[]; config: { count: number; seconds: number; seed: number; objective_quotas: Record<string, number>; provenance: unknown; variants?: Variant[] } };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const bad = (detail: string, status = 400) => json({ detail }, status);
const sha = async (value: BufferSource) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', value))].map(n => n.toString(16).padStart(2, '0')).join('');
const manifestKey = (id: string) => `runs/${id}/manifest.json`;
const summary = (m: Manifest) => { const { shards, ...rest } = m; return { ...rest, status: m.status === 'running' && Date.now() - Date.parse(m.updated_at) > 120000 ? 'interrupted' : m.status }; };
const validId = (id: string) => /^[a-z0-9-]{1,64}$/.test(id);
async function readManifest(env: Env, id: string): Promise<Manifest | null> { const item = await env.DATA.get(manifestKey(id)); return item ? item.json<Manifest>() : null; }
async function writeManifest(env: Env, m: Manifest) { m.updated_at = new Date().toISOString(); await env.DATA.put(manifestKey(m.id), JSON.stringify(m), { httpMetadata: { contentType: 'application/json' } }); return json(m); }
async function boundedBody(request: Request, limit: number) {
  if (Number(request.headers.get('content-length')) > limit) throw new Error('Request body exceeds limit.');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = []; let size = 0;
  while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > limit) { await reader.cancel(); throw new Error('Request body exceeds limit.'); } chunks.push(value); }
  const body = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; } return body;
}
function validateVariants(value: unknown): Variant[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('Expected at most 64 parameter variants.');
  return value.map(v => {
    if (!recipes.includes(v.objective) || !Number.isFinite(v.amplitude) || v.amplitude < .4 || v.amplitude > 1 || !Number.isFinite(v.speed) || v.speed < .3 || v.speed > 1.5 || !Number.isFinite(v.phase) || v.phase < 0 || v.phase > Math.PI * 2) throw new Error('AI proposed an out-of-bounds variant.');
    return { objective: v.objective, amplitude: v.amplitude, speed: v.speed, phase: v.phase };
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url), path = url.pathname;
    try {
      if (path === '/api/health') return json({ runtime: 'browser-wasm', subq_configured: !!env.SUBQ_API_KEY, meta_configured: !!env.MODEL_API_KEY, recipes });
      if (path === '/api/tabletop/plans/latest' && request.method === 'GET') { const object = await env.DATA.get('tabletop/latest-plan.json'); return object ? json(await object.json()) : bad('No Muse tabletop plan has been generated yet.', 404); }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        if (!env.ADMIN_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.ADMIN_TOKEN}`) return bad('Cloud writes and AI calls require the admin token (key icon).', 401);
        const origin = request.headers.get('Origin');
        if (origin && origin !== url.origin) return bad('Cross-origin writes are not allowed.', 403);
      }
      if (path === '/api/runs' && request.method === 'GET') {
        const catalog = await env.DATA.get('catalog/runs.json');
        const ids = catalog ? await catalog.json<string[]>() : [];
        const manifests = await Promise.all(ids.slice(0, 20).map(id => readManifest(env, id)));
        return json(manifests.filter((m): m is Manifest => !!m).map(summary).sort((a, b) => b.updated_at.localeCompare(a.updated_at)));
      }
      const runMatch = path.match(/^\/api\/runs\/([a-z0-9-]+)$/);
      if (runMatch && request.method === 'GET') { const m = await readManifest(env, runMatch[1]); return m ? json(summary(m)) : bad('Run not found.', 404); }
      const replay = path.match(/^\/api\/runs\/([a-z0-9-]+)\/episodes\/(\d+)$/);
      if (replay && request.method === 'GET') {
        const m = await readManifest(env, replay[1]), index = Number(replay[2]);
        const shard = m?.shards.find(s => index >= s.first && index < s.first + s.episodes);
        if (!shard) return bad('Episode not recorded.', 404);
        const object = await env.DATA.get(`runs/${m!.id}/${shard.file}`);
        if (!object) return bad('Shard not found.', 404);
        const raw = await new Response(object.body.pipeThrough(new DecompressionStream('gzip'))).json<any[]>();
        return json(raw[index - shard.first]);
      }
      if (path.startsWith('/datasets/') && request.method === 'GET') {
        const key = path.replace('/datasets/', 'runs/');
        if (key.includes('..') || !/^runs\/[a-z0-9-]+\/(manifest\.json|shard-\d+\.json\.gz)$/.test(key)) return bad('Invalid dataset path.');
        const object = await env.DATA.get(key); if (!object) return bad('Dataset not found.', 404);
        const headers = new Headers(); object.writeHttpMetadata(headers); headers.set('ETag', object.httpEtag);
        return new Response(object.body, { headers });
      }
      if (path.startsWith('/api/') && request.method !== 'GET') return env.COORDINATOR.get(env.COORDINATOR.idFromName('dataset-coordinator')).fetch(request);
      if (path.startsWith('/api/')) return bad('Unknown API route.', 404);
      return env.ASSETS.fetch(request);
    } catch (error) { return bad((error as Error).message, 400); }
  },
} satisfies ExportedHandler<Env>;

export class Coordinator {
  private tail: Promise<void> = Promise.resolve();
  constructor(private state: DurableObjectState, private env: Env) {}
  async fetch(request: Request) {
    // Serialize R2 manifest commits and AI budget reservations across all tabs.
    const previous = this.tail; let release!: () => void;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await this.route(request); } catch (error) { return bad((error as Error).message); } finally { release(); }
  }
  private async route(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const env = this.env;
    if (path === '/api/runs' && request.method === 'POST') {
      const input = JSON.parse(new TextDecoder().decode(await boundedBody(request, 64000)));
      if (!Number.isInteger(input.count) || input.count < 1 || input.count > 100000 || input.seconds !== 20) return bad('Use 1–100k episodes, each 20 seconds.');
      let variants: Variant[] = [];
      if (input.plan_id) {
        if (!validId(input.plan_id)) return bad('Invalid plan ID.');
        const object = await env.DATA.get(`plans/${input.plan_id}.json`);
        if (!object) return bad('AI plan not found.');
        variants = validateVariants((await object.json<any>()).variants);
      }
      const id = crypto.randomUUID();
      const m: Manifest = { id, schema_version: 2, status: 'running', attempted: 0, valid: 0, objective_passed: 0, annotated: 0, updated_at: '', shards: [], coverage: Object.fromEntries(recipes.map(r => [r, 0])),
        config: { count: input.count, seconds: 20, seed: input.seed ?? 42, objective_quotas: allocation(input.count), provenance: input.provenance, variants } };
      await writeManifest(env, m);
      const catalog = await env.DATA.get('catalog/runs.json');
      const ids = catalog ? await catalog.json<string[]>() : [];
      await env.DATA.put('catalog/runs.json', JSON.stringify([id, ...ids].slice(0, 500)));
      return json({ id });
    }
    const upload = path.match(/^\/api\/runs\/([a-z0-9-]+)\/shards\/(\d+)$/);
    if (upload && request.method === 'PUT') {
      const [, id, firstText] = upload, first = Number(firstText);
      const m = await readManifest(env, id); if (!m) return bad('Run not found.', 404);
      const compressed = await boundedBody(request, 8 * 1024 * 1024);
      const digest = await sha(compressed);
      const existing = m.shards.find(s => s.first === first);
      if (existing) return existing.sha256 === digest ? json(summary(m)) : bad('Conflicting shard already committed.', 409);
      if (m.status !== 'running') return bad(`Run is ${m.status}; explicitly resume before submitting new shards.`, 409);
      if (first !== m.attempted) return bad('Shard does not match the next checkpoint.', 409);
      const decoded = await boundedBody(new Request('https://decode.local', { method: 'POST', body: new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')) }), 16 * 1024 * 1024);
      const rows = JSON.parse(new TextDecoder().decode(decoded));
      if (!Array.isArray(rows) || rows.length < 1 || rows.length > 10 || first + rows.length > m.config.count) return bad('Invalid shard length.');
      const objectives = schedule(m.config.count, m.config.seed);
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!Array.isArray(row.time) || row.time.length !== 600 || row.time.some((t: unknown, index: number) => typeof t !== 'number' || !Number.isFinite(t) || t < 0 || (index > 0 && t <= row.time[index - 1])) ||
            !Array.isArray(row.contacts) || row.contacts.length !== 600 || row.contacts.some((n: unknown) => !Number.isSafeInteger(n) || (n as number) < 0) ||
            typeof row.valid !== 'boolean' || typeof row.objective_pass !== 'boolean' || (row.objective_pass && !row.valid)) return bad('Invalid timestamps, contacts, or validity flags.');
        if (row.episode_id !== first + i || row.recipe !== objectives[first + i] || row.seconds !== 20 || row.time?.length !== 600 || ['qpos', 'qvel', 'ctrl', 'actuator_force', 'external_force'].some(key => row[key]?.length !== 600 || row[key].some((a: unknown[]) => !Array.isArray(a) || a.length !== 16 || a.some(n => typeof n !== 'number' || !Number.isFinite(n))))) return bad('Invalid episode schema or objective schedule.');
      }
      const file = `shard-${String(first).padStart(6, '0')}.json.gz`;
      await env.DATA.put(`runs/${id}/${file}`, compressed, { httpMetadata: { contentType: 'application/gzip' }, customMetadata: { sha256: digest } });
      m.shards.push({ file, first, episodes: rows.length, sha256: digest, bytes: compressed.byteLength });
      m.attempted += rows.length; m.valid += rows.filter(r => r.valid === true).length; m.objective_passed += rows.filter(r => r.objective_pass === true).length;
      rows.forEach(row => m.coverage[row.recipe]++);
      if (m.attempted === m.config.count) m.status = 'complete';
      await writeManifest(env, m); return json(summary(m));
    }
    const control = path.match(/^\/api\/runs\/([a-z0-9-]+)\/(cancel|resume|pause)$/);
    if (control && request.method === 'POST') {
      const m = await readManifest(env, control[1]); if (!m) return bad('Run not found.', 404);
      if (m.status === 'complete') return bad('Run is already complete.', 409);
      // Cleanup from a failed/stale client must not overwrite another tab's cancellation.
      if (control[2] === 'pause' && m.status !== 'running') return json(summary(m));
      m.status = control[2] === 'resume' ? 'running' : control[2] === 'cancel' ? 'cancelled' : 'interrupted';
      return writeManifest(env, m);
    }
    if (path === '/api/annotate' && request.method === 'POST') return this.annotate(request);
    if (path === '/api/plans' && request.method === 'POST') return this.metaPlan(request);
    if (path === '/api/tabletop/plans' && request.method === 'POST') return this.tabletopPlan(request);
    if (path === '/api/budget' && request.method === 'POST') return json({ reserved_usd: (await this.state.storage.get('ai_reserved_usd')) ?? 0, cap_usd: Number(env.AI_BUDGET_USD) });
    return bad('Unknown mutation route.', 404);
  }
  private async reserve(amount: number) {
    const spent = (await this.state.storage.get<number>('ai_reserved_usd')) ?? 0;
    if (spent + amount > Number(this.env.AI_BUDGET_USD || 100)) throw new Error('AI budget cap reached.');
    // Conservative reservation remains charged locally even if a request fails.
    await this.state.storage.put('ai_reserved_usd', spent + amount);
  }
  private async tabletopPlan(request: Request) {
    if (!this.env.MODEL_API_KEY) return bad('Meta API key is not configured.', 503);
    const input = JSON.parse(new TextDecoder().decode(await boundedBody(request, 8000)));
    const count = input.count ?? 1000;
    if (!Number.isInteger(count) || count < 100 || count > 5000) return bad('Use 100–5000 tabletop scenarios.');
    await this.reserve(.50);
    const bounds: Record<string, [number, number]> = { size: [.02, .035], mass: [.035, .14], friction: [.3, 1.2], speed: [.9, 1.08], lift: [.12, .22], lateral: [-.04, .04], startY: [-.10, .10], goalY: [-.10, .10] };
    const properties = { task: { type: 'string', enum: ['transfer', 'push', 'stack', 'pour'] }, shape: { type: 'string', enum: ['cube', 'sphere', 'cylinder'] }, ...Object.fromEntries(Object.entries(bounds).map(([key, [minimum, maximum]]) => [key, { type: 'number', minimum, maximum }])), rationale: { type: 'string' } };
    const schema = { type: 'object', additionalProperties: false, required: ['variants'], properties: { variants: { type: 'array', minItems: 24, maxItems: 24, items: { type: 'object', additionalProperties: false, required: Object.keys(properties), properties } } } };
    const response = await fetch('https://api.meta.ai/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${this.env.MODEL_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'muse-wonder-1.0', store: false, max_output_tokens: 24000, reasoning: { effort: 'low' },
      input: `Design exactly 24 physically bounded robotic tabletop manipulation variants, balanced 6 each transfer, push, stack, pour, interleaved. Cross task/shape, high/low mass and friction, object size, path curvature, motion speed, lift clearance, source and target Y positions. Each numeric field MUST stay inside ${JSON.stringify(bounds)}. Include a brief rationale explaining the intended diversity axis. Units are meters, kilograms, and speed multipliers. Do not claim successful grasping. The simulator uses assisted grasps and 36 rigid pouring particles. Pour cup geometry/tilt/clearance remain fixed; size refers to movable solid shapes only. No executable code. User focus: ${String(input.focus ?? 'broad balanced contact and motion diversity').slice(0, 1000)}`,
      text: { format: { type: 'json_schema', name: 'TabletopDiversity', strict: true, schema } } }), signal: AbortSignal.timeout(90000) });
    if (!response.ok) return bad(`Muse returned HTTP ${response.status}.`, 502);
    const body = await response.json<any>();
    if (body.status && body.status !== 'completed') return bad(`Muse output incomplete (${body.incomplete_details?.reason ?? body.status}); no plan was applied.`, 502);
    const text = body.output?.flatMap((o: any) => o.content ?? []).filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('') ?? '';
    const variants = validateTableVariants(JSON.parse(text).variants);
    const result = { id: crypto.randomUUID(), model: 'muse-wonder-1.0', created_at: new Date().toISOString(), count, variants, usage: body.usage, source: 'Muse parameter proposals; MuJoCo results are separate' };
    await this.env.DATA.put(`tabletop/plans/${result.id}.json`, JSON.stringify(result));
    await this.env.DATA.put('tabletop/latest-plan.json', JSON.stringify(result));
    return json(result);
  }
  private async annotate(request: Request) {
    if (!this.env.SUBQ_API_KEY) return bad('SubQ is not configured.', 503);
    const input = JSON.parse(new TextDecoder().decode(await boundedBody(request, 6 * 1024 * 1024)));
    if (!Array.isArray(input.frames) || input.frames.length < 1 || input.frames.length > 4 || input.frames.some((f: unknown) => typeof f !== 'string' || f.length > 1400000 || !f.startsWith('iVBOR')) || JSON.stringify(input.summary).length > 16000) return bad('Expected up to four small PNG frames and compact telemetry.');
    const hash = await sha(new TextEncoder().encode(JSON.stringify(input)));
    const cached = await this.env.DATA.get(`annotations/${hash}.json`); if (cached) return json({ ...await cached.json<any>(), cached: true });
    await this.reserve(.01);
    const response = await fetch('https://api.subq.ai/v1/systemone', { method: 'POST', headers: { Authorization: `Bearer ${this.env.SUBQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'subq-snap-1.1', state: { instructions: 'Classify visible robotic finger movement. Images do not establish physical safety.', telemetry: input.summary }, images: input.frames.map((base64: string) => ({ mediaType: 'image/png', base64 })),
        questions: { movement: { type: 'choice', instructions: 'Which movement matches the chronological frames?', criteria: { ...Object.fromEntries(plan.objectives.map(o => [o.id, o.goal])), unclear: 'Insufficient evidence' } }, coordination: { type: 'score', instructions: 'Rate visible coordination, not physical safety.', criteria: ['Unclear', 'Partial', 'Coordinated'] } } }), signal: AbortSignal.timeout(45000) });
    if (!response.ok) return bad(`SubQ returned HTTP ${response.status}.`, 502);
    const body = await response.json<any>();
    const result = { model: 'subq-snap-1.1', answers: body.answers, usage: body.usage, image_count: input.frames.length, advisory: true, input_sha256: hash };
    await this.env.DATA.put(`annotations/${hash}.json`, JSON.stringify(result)); return json(result);
  }
  private async metaPlan(request: Request) {
    if (!this.env.MODEL_API_KEY) return bad('Meta API key is not configured.', 503);
    const input = JSON.parse(new TextDecoder().decode(await boundedBody(request, 8000)));
    const model = ['muse-wonder-1.0', 'muse-spark-1.3'].includes(this.env.META_MODEL) ? this.env.META_MODEL : 'muse-wonder-1.0';
    await this.reserve(.10);
    const prompt = `Propose diverse bounded parameter variants for this robotic hand dataset. Return ONLY JSON with {"variants":[{"objective":"ID","amplitude":0.8,"speed":1,"phase":0}],"notes":"brief"}. Use 14–28 variants, supported objective IDs only, amplitude in [0.4,1], speed in [0.3,1.5], phase in [0,6.283185307]. No executable code, geometry changes, or physical-success claims. Objectives: ${JSON.stringify(plan.objectives)}. User focus: ${String(input.focus ?? 'broad coverage').slice(0, 1500)}`;
    const schema = { type: 'object', additionalProperties: false, required: ['variants', 'notes'], properties: {
      variants: { type: 'array', minItems: 14, maxItems: 28, items: { type: 'object', additionalProperties: false, required: ['objective', 'amplitude', 'speed', 'phase'], properties: { objective: { type: 'string', enum: recipes }, amplitude: { type: 'number', minimum: .4, maximum: 1 }, speed: { type: 'number', minimum: .3, maximum: 1.5 }, phase: { type: 'number', minimum: 0, maximum: Math.PI * 2 } } } }, notes: { type: 'string' },
    } };
    const response = await fetch('https://api.meta.ai/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${this.env.MODEL_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, input: prompt, max_output_tokens: 2048, store: false, text: { format: { type: 'json_schema', name: 'HandVariants', strict: true, schema } } }), signal: AbortSignal.timeout(45000) });
    if (!response.ok) return bad(`Meta returned HTTP ${response.status}; verify key, credit and billing access.`, 502);
    const body = await response.json<any>();
    if (body.status && body.status !== 'completed') return bad('Meta output was incomplete; no plan was applied.', 502);
    const text = body.output?.flatMap((o: any) => o.content ?? []).filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('') ?? '';
    const proposal = JSON.parse(text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
    const variants = validateVariants(proposal.variants);
    const id = crypto.randomUUID();
    const result = { id, model, variants, notes: String(proposal.notes ?? '').slice(0, 2000), usage: body.usage, advisory: true };
    await this.env.DATA.put(`plans/${id}.json`, JSON.stringify(result)); return json(result);
  }
}
