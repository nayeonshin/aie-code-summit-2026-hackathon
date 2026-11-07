// Explicit paid Muse call; credentials stay local and are never logged/exported.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const base = process.argv.find(arg => arg.startsWith('http')) ?? 'https://hand-studio.hidden-pond-5e6a.workers.dev';
const token = readFileSync('.deploy.env', 'utf8').split('\n').find(line => line.startsWith('ADMIN_TOKEN='))?.slice('ADMIN_TOKEN='.length).trim();
if (!token) throw new Error('Configure ADMIN_TOKEN locally before generating Muse diversity.');
const response = await fetch(base + '/api/tabletop/plans', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 1000 }), signal: AbortSignal.timeout(120000) });
const plan = await response.json();
if (!response.ok) throw new Error(plan.detail ?? `Muse failed (${response.status})`);
mkdirSync('data/publish/muse', { recursive: true });
writeFileSync('data/publish/muse/tabletop-plan.json', JSON.stringify(plan, null, 2));
console.log(`Saved real ${plan.model} plan ${plan.id}: ${plan.variants.length} anchors / ${plan.count} scenarios.`);
