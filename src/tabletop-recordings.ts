import { fetchAsset, withAbort } from './asset-fetch';
import type { Scenario } from './tabletop-scenarios';
import type { TableEpisode, TableGeom } from './tabletop-physics';

type File = { file: string; sha256: string; bytes: number };
type Entry = File & { id: number; scenario: Scenario; frames: number; standalone_file: string };
export type RecordingManifest = { schema_version: number; revision: string; base_url: string; plan_fingerprint: string; sample_hz: number; planned: number; recorded: number; episodes: Entry[]; meshes: Record<string, File> };
const hashPattern = /^[a-f0-9]{64}$/;
const canonical = (value: any): string => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

export function validateRecordingManifest(value: any): RecordingManifest {
  check(value?.schema_version === 1 && value.sample_hz === 30, 'Unsupported recording manifest');
  check(typeof value.revision === 'string' && /^[a-f0-9]{40}$/.test(value.revision), 'Recordings must use an immutable dataset revision');
  check(typeof value.base_url === 'string' && (value.base_url.startsWith('/') && !value.base_url.startsWith('//') && !value.base_url.includes('..') || value.base_url === `https://huggingface.co/datasets/MedSalim/labbit-robotic-manipulation/resolve/${value.revision}/tabletop/`), 'Invalid recording dataset URL');
  check(hashPattern.test(value.plan_fingerprint), 'Invalid recording plan fingerprint');
  check(Array.isArray(value.episodes) && value.episodes.length <= 5000 && value.recorded === value.episodes.length && Number.isInteger(value.planned) && value.planned >= value.recorded, 'Invalid recording inventory count');
  check(value.meshes && typeof value.meshes === 'object' && !Array.isArray(value.meshes) && Object.keys(value.meshes).length <= 64, 'Invalid shared geometry inventory');
  const ids = new Set<number>(), files = new Set<string>();
  for (const entry of value.episodes) {
    check(Number.isInteger(entry.id) && entry.id >= 0 && entry.id < value.planned && entry.scenario?.id === entry.id && entry.frames === 361, 'Invalid recorded scenario');
    check(!ids.has(entry.id) && !files.has(entry.file), 'Duplicate recording ID or filename'); ids.add(entry.id); files.add(entry.file);
    check((entry.file === `compact/episode-${String(entry.id + 1).padStart(4, '0')}.json.gz` || entry.file === `compact/${entry.sha256}.json.gz`) && hashPattern.test(entry.sha256) && Number.isInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= 16 * 1024 * 1024, 'Invalid recorded trajectory descriptor');
  }
  for (const [hash, file] of Object.entries(value.meshes) as [string, File][]) check(hashPattern.test(hash) && file.sha256 === hash && file.file === `meshes/${hash}.json.gz` && Number.isInteger(file.bytes) && file.bytes > 0 && file.bytes <= 16 * 1024 * 1024, 'Invalid shared mesh descriptor');
  return value;
}

async function verifiedJSON(base: string, file: File, signal?: AbortSignal) {
  const bytes = await fetchAsset(base + file.file, 'Published recording', signal);
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
  check(bytes.length === file.bytes && hash === file.sha256, 'Published recording checksum mismatch; no computed substitute was used');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader(), chunks: Uint8Array[] = []; let length = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    length += value.length;
    if (length > 64 * 1024 * 1024) { await reader.cancel(); throw new Error('Published recording exceeds decoded size limit'); }
    chunks.push(value);
  }
  const raw = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(raw));
}

function validateMesh(mesh: any) {
  check(Array.isArray(mesh?.vertices) && mesh.vertices.length % 3 === 0 && mesh.vertices.length <= 3000000 && mesh.vertices.every((v: unknown) => typeof v === 'number' && Number.isFinite(v)), 'Invalid published mesh vertices');
  check(Array.isArray(mesh.faces) && mesh.faces.length % 3 === 0 && mesh.faces.length <= 3000000 && mesh.faces.every((v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) < mesh.vertices.length / 3), 'Invalid published mesh faces');
  return mesh as NonNullable<TableGeom['mesh']>;
}

export class TabletopRecordings {
  private meshes = new Map<string, Promise<NonNullable<TableGeom['mesh']>>>();
  private base: string;
  constructor(readonly manifest: RecordingManifest) {
    this.base = manifest.base_url.startsWith('/') ? manifest.base_url : `/api/tabletop/recordings/${manifest.revision}/`;
  }
  static async open() {
    const response = await fetch('/data/tabletop-recordings.json', { signal: AbortSignal.timeout(10000) });
    if (response.status === 404) return null;
    check(response.ok, `Published recording inventory unavailable (HTTP ${response.status})`);
    if (import.meta.env.DEV && response.headers.get('content-type')?.includes('text/html')) return null; // Only Vite's successful missing-static-file fallback.
    return new TabletopRecordings(validateRecordingManifest(await response.json()));
  }
  private mesh(hash: string) {
    check(hashPattern.test(hash), 'Invalid recorded mesh hash');
    const descriptor = this.manifest.meshes[hash]; check(descriptor, 'Recorded episode references unknown geometry');
    let pending = this.meshes.get(hash);
    if (!pending) {
      pending = verifiedJSON(this.base, descriptor).then(validateMesh).catch(error => { this.meshes.delete(hash); throw error; });
      this.meshes.set(hash, pending);
    }
    return pending;
  }
  async load(scenario: Scenario, signal?: AbortSignal): Promise<TableEpisode | null> {
    const entry = this.manifest.episodes.find(e => e.id === scenario.id);
    if (!entry || !same(entry.scenario, scenario)) return null; // A live plan may reuse numeric IDs.
    const data = await verifiedJSON(this.base, entry, signal);
    check(data.schema_version === 1 && same(data.scenario, entry.scenario), 'Published trajectory scenario differs from its manifest');
    check(Array.isArray(data.geoms) && data.geoms.length > 0 && data.geoms.length <= 256 && Array.isArray(data.frames) && data.frames.length === entry.frames, 'Invalid recorded geometry/frame count');
    const geoms: TableGeom[] = [];
    // Sequential mesh loads bound network/decode concurrency and reuse geometry.
    for (const geom of data.geoms) {
      check(['mesh', 'box', 'sphere', 'cylinder'].includes(geom.type) && Number.isInteger(geom.id) && Array.isArray(geom.size) && geom.size.every((n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 10) && typeof geom.color === 'string', 'Invalid recorded geometry');
      // Detach cancelled selections without cancelling a mesh shared by others.
      if (geom.type === 'mesh') { check(typeof geom.mesh === 'string', 'Invalid shared mesh reference'); geoms.push({ ...geom, mesh: await withAbort(this.mesh(geom.mesh), signal) }); }
      else geoms.push(geom);
    }
    const vector = (value: any, size: number) => Array.isArray(value) && value.length === size && value.every((n: unknown) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 10);
    for (let i = 0; i < data.frames.length; i++) {
      const frame = data.frames[i];
      check(Number.isFinite(frame.time) && Math.abs(frame.time - i / 30) < .02 && Number.isSafeInteger(frame.contacts) && frame.contacts >= 0 && typeof frame.holding === 'boolean', 'Invalid recorded telemetry');
      check(Array.isArray(frame.positions) && frame.positions.length === geoms.length && frame.positions.every((p: any) => vector(p, 3)) && Array.isArray(frame.rotations) && frame.rotations.length === geoms.length && frame.rotations.every((r: any) => vector(r, 9)), 'Invalid recorded transforms');
      check(['object', 'objectCenter', 'palm', 'palmNormal', 'graspCenter'].every(key => vector(frame[key], 3)), 'Invalid recorded grip telemetry');
    }
    check(data.metrics?.finite === true && Number.isFinite(data.metrics.goalDistance) && data.metrics.goalDistance >= 0 && Number.isSafeInteger(data.metrics.contacts) && data.metrics.contacts >= 0 && data.provenance?.handActuators === 20 && ['runtime', 'controller', 'hand', 'fluid'].every(key => typeof data.provenance[key] === 'string') && Number.isFinite(data.provenance.timestep) && data.provenance.timestep > 0, 'Invalid recorded measurements/provenance');
    return { scenario: data.scenario, geoms, frames: data.frames, metrics: data.metrics, provenance: data.provenance,
      recording: { dataset_url: 'https://huggingface.co/datasets/MedSalim/labbit-robotic-manipulation', revision: this.manifest.revision, file: entry.file, sha256: entry.sha256 } };
  }
}
