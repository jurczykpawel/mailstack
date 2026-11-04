import { AsyncLocalStorage } from 'node:async_hooks';

/** Invocation budget (A 3.4.3): the trigger sets the wall-clock deadline and the job cap for the whole call. */
export type Trigger = 'request' | 'cron';

const PLANS: Record<Trigger, { ms: number; jobs: number }> = {
  // waitUntil after a response may run 30 s; Node ticks use the same deadline so a drain never hangs.
  request: { ms: 20000, jobs: 50 },
  // The minute cron has 30 s CPU on Paid; 45 s of wall time and 50 jobs keep it well inside.
  cron: { ms: 45000, jobs: 50 },
};

/** Operations of one Worker invocation (A 3.2): D1 calls counted by the D1 store from its start, job steps at least `ops`. */
const invocation = new AsyncLocalStorage<{ used: number; limit: number }>();
export const metered = <T>(limit: number, task: () => T): T => invocation.run({ used: 0, limit }, task);
export const countOperation = () => { const meter = invocation.getStore(); if (meter) meter.used++; };
/** The current invocation's meter: a key for results computed once per invocation (undefined outside `metered`). */
export const currentInvocation = (): object | undefined => invocation.getStore();

export interface Budget {
  /** True while at least `reserveMs` remain before the deadline and `ops` more operations fit the invocation. */
  has(reserveMs?: number, ops?: number): boolean;
  /** Takes one job slot; false once the cap, the deadline or the operations for one claimed step are reached. */
  take(ops?: number): boolean;
  /** A finished step that started at `from` costs at least `ops` (subrequests the meter does not see). */
  charge(from: number, ops: number): void;
  used(): number;
}

export function createBudget(trigger: Trigger, clock: () => number = Date.now, meter = invocation.getStore()): Budget {
  const { ms, jobs } = PLANS[trigger], deadline = clock() + ms;
  let left = jobs;
  const has = (reserveMs = 0, ops = 0) => clock() + reserveMs < deadline && (!meter || meter.used + ops <= meter.limit);
  return { has, take: (ops = 0) => has(0, ops) && left-- > 0, used: () => meter?.used ?? 0,
    charge(from, ops) { if (meter) meter.used = Math.max(meter.used, from + ops); } };
}
