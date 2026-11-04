import type { JobKind } from './jobs';
import { ERASE_JOB } from './erase';
import { reconcileStep } from './ext-migrations';

/** The only registry of background job kinds; a job whose kind is missing here ends `dead`. */
export const JOB_KINDS: Record<string, JobKind> = {
  erase: ERASE_JOB,
  // Fan-out runs without a job row since R11; a `job_fanout_*` row left from before finishes without work.
  fanout: { step: async () => ({ result: null }) },
  'ext.reconcile': { step: (job, ctx) => reconcileStep(job, ctx) },
};
