import plan from '../config/objectives.json';
export { plan };
export const recipes = plan.objectives.map(o => o.id);
export function randomGenerator(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function allocation(count: number) {
  const total = plan.objectives.reduce((n, o) => n + o.quota, 0);
  const exact = plan.objectives.map(o => count * o.quota / total);
  const quotas = exact.map(Math.floor);
  const order = exact.map((n, i) => ({ i, remainder: n - quotas[i] })).sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  const remaining = count - quotas.reduce((a, b) => a + b, 0);
  for (let i = 0; i < remaining; i++) quotas[order[i].i]++;
  return Object.fromEntries(plan.objectives.map((o, i) => [o.id, quotas[i]]));
}
export function schedule(count: number, seed: number) {
  const quotas = allocation(count);
  const items = plan.objectives.flatMap(o => Array<string>(quotas[o.id]).fill(o.id));
  const random = randomGenerator(seed);
  for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
  return items;
}
export type Variant = { objective: string; amplitude: number; speed: number; phase: number };
