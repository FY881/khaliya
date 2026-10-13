/** P5 Org Memory + Knowledge Base — public surface. */
export { mountMemoryRoutes, memoryRoutes } from "./routes";
export { memoryCompactJob, memoryCompactInit, scheduleMemoryCompact, MEMORY_COMPACT_KIND, MEMORY_COMPACT_CALLS } from "./jobs";
export { kbSearchTool, kbWriteTool, KB_TOOLS, episodicMemoryStore } from "./tools";
export { lessonsFor, distillLessons } from "./lessons";
export { wrapRetrieved, injectionSignals, neutralize } from "./hygiene";
export { writeDoc, searchDocs, reviewDoc, getDoc, listDocs, KB_QUOTAS } from "./store";
export { criticReview } from "./review";
export { vectorsEnabled, EMBED_MODEL, EMBED_DIMS } from "./embed";
export type { MemoryEnv, KbDoc, KbHit, KbTrust, KbKind } from "./types";
