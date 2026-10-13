/** Job handlers added by P5, for `Object.assign(HANDLERS, P5_JOB_HANDLERS)` or explicit entries in jobs/handlers.ts. */
import type { JobHandler } from "../jobs/handlers";
import { memoryCompactJob } from "../memory/jobs";
import { courtProbeJob } from "./jobs";

export const P5_JOB_HANDLERS: Record<string, JobHandler> = {
  [memoryCompactJob.kind]: memoryCompactJob,
  [courtProbeJob.kind]: courtProbeJob,
};
