import { randomGenerator } from './objectives';

export type Task = 'transfer' | 'push' | 'stack' | 'pour' | 'so101';
export type Shape = 'cube' | 'sphere' | 'cylinder';
export type Scenario = { id: number; seed: number; task: Task; shape: Shape; title: string; size: number; mass: number; friction: number; start: [number, number]; goal: [number, number]; color: string; motion?: { speed: number; lift: number; lateral: number }; arm?: So101Pour; proposal?: { planId: string; model: string; variant: number; rationale: string } };
export type TableVariant = { task: Task; shape: Shape; size: number; mass: number; friction: number; speed: number; lift: number; lateral: number; startY: number; goalY: number; rationale: string };
export type TablePlan = { id: string; model: string; created_at: string; variants: TableVariant[]; count: number };
export const taskNames: Record<Task, string> = { transfer: 'Pick & place', push: 'Surface push', stack: 'Stack & balance', pour: 'Cup to cup', so101: 'SO-101 pour' };
export const isPour = (task: Task) => task === 'pour' || task === 'so101';

// ---- SO-101 arm: RAX's side-grasp-and-pour (rax_subq.pour) on the real arm's model ----
// The arm stands at the table's -x side and faces +x, like RAX's base frame: +y is the
// robot's left. The cup on its right (smaller y) is poured into the cup on its left.
export type So101Pour = { cupHeight: number; receiverRadius: number; flow: number; tilt: number; gap: number; lead: number; graspAt: number };
export const so101Base: [number, number, number] = [-.22, 0, .72];
/** Where the shoulder pan axis meets the table, world frame (the MJCF's shoulder offset). */
export const so101Pan: [number, number] = [so101Base[0] + .0388, so101Base[1]];
/** The pour, second by second: the phases of rax_subq.pour.pour, in order. */
export const so101Timeline = [
  ['home', .8, 'Home · look at both cups'], ['stand', 1.2, 'Stand off · level hand'], ['down', .6, 'Down to grasp height'],
  ['reach', 1.2, 'Reach in level'], ['close', .6, 'Grasp the right cup'], ['lift', 1, 'Lift'], ['carry', 1.4, 'Carry over'],
  ['settle', .4, 'Over the left cup'], ['tip', 2.6, 'Tip · roll the wrist down'], ['hold', 1.4, 'Hold the pour'],
  ['untip', 1, 'Stand it back up'], ['raise', .5, 'Up, clear of the left cup'], ['back', 1.2, 'Carry back'], ['lower', .8, 'Put it back'], ['release', .5, 'Release'],
  ['retreat', .7, 'Back out'], ['rest', 1, 'Home'],
] as const;
export type So101Phase = typeof so101Timeline[number][0];
export const so101Seconds = so101Timeline.reduce((sum, [, seconds]) => sum + seconds, 0);
export function so101PhaseAt(time: number): { name: So101Phase; label: string; start: number; end: number } {
  let start = 0;
  for (const [name, seconds, label] of so101Timeline) { if (time < start + seconds) return { name, label, start, end: start + seconds }; start += seconds; }
  const [name, seconds, label] = so101Timeline[so101Timeline.length - 1];
  return { name, label, start: start - seconds, end: start };
}
function so101Scenarios(first: number): Scenario[] {
  return Array.from({ length: 25 }, (_, k) => {
    const id = first + k, seed = 20261107 + 7919 * (k + 1), random = randomGenerator(seed);
    const deg = Math.PI / 180, at = (r: number, bearing: number): [number, number] => [so101Pan[0] + r * Math.cos(bearing), so101Pan[1] + r * Math.sin(bearing)];
    // A level hand only reaches low far out (>= 27 cm at 4 cm up), so the cups sit 25-28 cm out.
    const start = at(.25 + random() * .03, -(14 + random() * 12) * deg), goal = at(.24 + random() * .03, (8 + random() * 12) * deg);
    const radius = .028 + random() * .004;
    return { id, seed, task: 'so101' as Task, shape: 'cylinder' as Shape, title: 'SO-101 · pour right cup into left', size: radius, mass: .025 + random() * .015, friction: .6 + random() * .4, start, goal,
      color: ['#d9a441', '#8ba9ba', '#bf896e', '#a2af87'][k % 4],
      arm: { cupHeight: .08 + random() * .01, receiverRadius: .03 + random() * .004, flow: 90 * deg, tilt: (105 + random() * 15) * deg, gap: .012 + random() * .012, lead: .008 + random() * .012, graspAt: .5 + random() * .1 } };
  });
}
export const scenarios: Scenario[] = Array.from({ length: 100 }, (_, id): Scenario => {
  const seed = 20261107 + id * 97, random = randomGenerator(seed);
  const task = (['transfer', 'push', 'stack', 'pour'] as Task[])[Math.floor(id / 25)];
  const shape = (['cube', 'sphere', 'cylinder'] as Shape[])[id % 3];
  return { id, seed, task, shape, title: task === 'pour' ? 'Pour into receiving cup' : `${taskNames[task]} · ${shape}`,
    size: .023 + random() * .009, mass: .04 + random() * .08, friction: .5 + random() * .5,
    start: [-.19 + random() * .035, -.045 + random() * .08], goal: [.16 + random() * .03, -.025 + random() * .06],
    color: ['#bf896e', '#a2af87', '#8ba9ba', '#c4ab75'][id % 4] };
}).concat(so101Scenarios(100));
export const duration = 12;
export const sampleHz = 30;
/** Seconds in one episode: the hand studies are 12 s, the SO-101 pour runs its own timeline. */
export const durationOf = (task: Task) => task === 'so101' ? so101Seconds : duration;
export const phaseAt = (task: Task, time: number) => task === 'so101' ? so101PhaseAt(time).label : time < 1.5 ? 'Approach' : time < 3 ? (task === 'push' ? 'Contact' : 'Attach · assisted') : time < 7.5 ? (task === 'pour' ? 'Tilt & pour' : task === 'push' ? 'Push' : 'Transport') : time < 9 ? 'Release' : 'Settle & measure';

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
      start: [-.23 + random() * .07, v.startY], goal: [.14 + random() * .07, v.goalY], color: ['#bf896e', '#a2af87', '#8ba9ba', '#c4ab75'][id % 4], motion: { speed: v.speed, lift: v.lift, lateral: v.lateral }, proposal: { planId: plan.id, model: plan.model, variant: id % variants.length, rationale: v.rationale } } as Scenario;
  }).concat(so101Scenarios(plan.count));
}
