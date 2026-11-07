import { randomGenerator } from './objectives';

export type Task = 'transfer' | 'push' | 'stack' | 'pour';
export type Shape = 'cube' | 'sphere' | 'cylinder';
export type Scenario = { id: number; seed: number; task: Task; shape: Shape; title: string; size: number; mass: number; friction: number; start: [number, number]; goal: [number, number]; color: string };
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
