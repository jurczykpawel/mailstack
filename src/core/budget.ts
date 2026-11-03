/** Invocation budget (A 3.4.3): the trigger sets the wall-clock deadline and the job cap for the whole call. */
export type Trigger = 'request' | 'cron';

const PLANS: Record<Trigger, { ms: number; jobs: number }> = {
  // waitUntil after a response may run 30 s; Node ticks use the same deadline so a drain never hangs.
  request: { ms: 20000, jobs: 50 },
  // The minute cron has 30 s CPU on Paid; 45 s of wall time and 50 jobs keep it well inside.
  cron: { ms: 45000, jobs: 50 },
};

export interface Budget {
  /** True while at least `reserveMs` remain before the deadline. */
  has(reserveMs?: number): boolean;
  /** Takes one job slot; false once the cap or the deadline is reached. */
  take(): boolean;
}

export function createBudget(trigger: Trigger, clock: () => number = Date.now): Budget {
  const { ms, jobs } = PLANS[trigger], deadline = clock() + ms;
  let left = jobs;
  const has = (reserveMs = 0) => clock() + reserveMs < deadline;
  return { has, take: () => has() && left-- > 0 };
}
