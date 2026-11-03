import type { JobKind } from './jobs';

/** The only registry of background job kinds; a job whose kind is missing here ends `dead`. */
export const JOB_KINDS: Record<string, JobKind> = {};
