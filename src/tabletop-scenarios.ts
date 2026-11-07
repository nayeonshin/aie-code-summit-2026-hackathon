import { randomGenerator } from './objectives';

export type Task = 'transfer' | 'push' | 'stack' | 'pour';
export type Shape = 'cube' | 'sphere' | 'cylinder';
export type Scenario = { id: number; seed: number; task: Task; shape: Shape; title: string; size: number; mass: number; friction: number; start: [number, number]; goal: [number, number]; color: string; motion?: { speed: number; lift: number; lateral: number }; proposal?: { planId: string; model: string; variant: number; rationale: string } };
export type TableVariant = { task: Task; shape: Shape; size: number; mass: number; friction: number; speed: number; lift: number; lateral: number; startY: number; goalY: number; rationale: string };
export type TablePlan = { id: string; model: string; created_at: string; variants: TableVariant[]; count: number };
export const taskNames: Record<Task, string> = { transfer: 'Pick & place', push: 'Surface push', stack: 'Stack & balance', pour: 'Cup to cup' };
export const scenarios: Scenario[] = Array.from({ length: 100 }, (_, id) => {
  const seed = 20261107 + id * 97, random = randomGenerator(seed);
  const task = (['transfer', 'push', 'stack', 'pour'] as Task[])[Math.floor(id / 25)];
  const shape = (['cube', 'sphere', 'cylinder'] as Shape[])[id % 3];
  return { id, seed, task, shape, title: task === 'pour' ? 'Pour into receiving cup' : `${taskNames[task]} · ${shape}`,
    size: .023 + random() * .009, mass: .04 + random() * .08, friction: .5 + random() * .5,
    start: [-.19 + random() * .035, -.045 + random() * .08], goal: [.16 + random() * .03, -.025 + random() * .06],
    color: ['#bf896e', '#a2af87', '#8ba9ba', '#c4ab75'][id % 4] };
});
export const duration = 12;
export const sampleHz = 30;
export const phaseAt = (task: Task, time: number) => time < 1.5 ? 'Approach' : time < 3 ? (task === 'push' ? 'Contact' : 'Attach · assisted') : time < 7.5 ? (task === 'pour' ? 'Tilt & pour' : task === 'push' ? 'Push' : 'Transport') : time < 9 ? 'Release' : 'Settle & measure';

export function validateTableVariants(value: unknown): TableVariant[] {
  if (!Array.isArray(value) || value.length < 12 || value.length > 60) throw new Error('Muse must propose 12–60 tabletop variants.');
  const bounds: Record<string, [number, number]> = { size: [.02, .035], mass: [.035, .14], friction: [.3, 1.2], speed: [.9, 1.08], lift: [.12, .22], lateral: [-.04, .04], startY: [-.10, .10], goalY: [-.10, .10] };
  for (const v of value) {
    if (!v || !['transfer', 'push', 'stack', 'pour'].includes(v.task) || !['cube', 'sphere', 'cylinder'].includes(v.shape) || typeof v.rationale !== 'string' || v.rationale.length > 500 || Object.entries(bounds).some(([key, [min, max]]) => !Number.isFinite(v[key]) || v[key] < min || v[key] > max)) throw new Error('Muse proposed an unsupported or out-of-bounds tabletop variant.');
  }
  return value;
}
export function createCollection(plan: TablePlan): Scenario[] {
  const variants = validateTableVariants(plan.variants);
  if (!Number.isInteger(plan.count) || plan.count < 100 || plan.count > 5000) throw new Error('Use 100–5000 tabletop scenarios.');
  return Array.from({ length: plan.count }, (_, id) => {
    const v = variants[id % variants.length], seed = 20261107 + id * 97, random = randomGenerator(seed);
    const jitter = () => .96 + random() * .08;
    return { id, seed, task: v.task, shape: v.shape, title: v.task === 'pour' ? 'Pour into receiving cup' : `${taskNames[v.task]} · ${v.shape}`, size: Math.max(.02, Math.min(.035, v.size * jitter())), mass: Math.max(.035, Math.min(.14, v.mass * jitter())), friction: Math.max(.3, Math.min(1.2, v.friction * jitter())),
      start: [-.23 + random() * .07, v.startY], goal: [.14 + random() * .07, v.goalY], color: ['#bf896e', '#a2af87', '#8ba9ba', '#c4ab75'][id % 4], motion: { speed: v.speed, lift: v.lift, lateral: v.lateral }, proposal: { planId: plan.id, model: plan.model, variant: id % variants.length, rationale: v.rationale } };
  });
}
