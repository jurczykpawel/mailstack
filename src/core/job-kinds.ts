import type { JobKind } from './jobs';
import { ERASE_JOB } from './erase';

/** The only registry of background job kinds; a job whose kind is missing here ends `dead`. */
export const JOB_KINDS: Record<string, JobKind> = { erase: ERASE_JOB };
