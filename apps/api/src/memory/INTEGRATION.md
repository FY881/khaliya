# P5 integration (Org Memory/KB + Judge Court) — lines to add to files owned by others

Nothing below has been applied. All P5 code lives in `src/memory/*`, `src/court/*`, `test/memory/*`, `test/court/*`,
`migrations/0007_memory_court.sql`.

## 1. src/index.ts (routes: AFTER the owner gate at `app.use("/api/*", …)` ~line 99, next to the other `app.route` calls)
```ts
import { mountMemoryRoutes } from "./memory/routes";
import { mountCourtRoutes } from "./court/routes";
// ...
mountMemoryRoutes(app); // /api/kb/*
mountCourtRoutes(app);  // /api/court/*
```
Optional cron (inside `dailyMaintenance(env)`, after the existing work, each in its own try/catch):
```ts
import { scheduleMemoryCompact } from "./memory/jobs";
import { scheduleCourtProbe } from "./court/jobs";
try { await scheduleMemoryCompact(env); } catch (e) { console.error("memory.compact schedule failed", e); }
try { await scheduleCourtProbe(env, labFor(env, 0)); } catch (e) { console.error("court.probe schedule failed", e); }
```

## 2. src/jobs/handlers.ts (register the two job kinds)
```ts
import { memoryCompactJob } from "../memory/jobs";
import { courtProbeJob } from "../court/jobs";
// in HANDLERS:
  [memoryCompactJob.kind]: memoryCompactJob,   // "memory.compact"
  [courtProbeJob.kind]: courtProbeJob,         // "court.probe"
```
(or `...P5_JOB_HANDLERS` from `../court/handlers`). Until this is done, POST /api/kb/compact and POST /api/court/probe
create jobs the runner fails with "unknown job kind".

## 3. src/tools/catalog.ts (agent tools)
```ts
import { kbSearchTool, kbWriteTool } from "../memory/tools";
// append to TOOLS:
  kbSearchTool, // "kb.search" T0
  kbWriteTool,  // "kb.write"  T1
```
Genomes must list `kb.search` / `kb.write` in `tool_ids` to use them (starter org seed / evolution `tool_add`).

## 4. src/env.ts (optional typing; code reads it through `MemoryEnv` already)
```ts
  /** Vectorize index for KB embeddings (@cf/baai/bge-m3, 1024 dims). Optional: D1 FTS5 is used when unbound. */
  KB_VECTORS?: Vectorize;
  KB_EMBED?: string; // "off" disables embeddings
```

## 5. Vectorize (free plan) — create the index, then bind it
```bash
npx wrangler vectorize create khaliya-kb --dimensions=1024 --metric=cosine
```
Add to `wrangler.deploy.toml` (deploy config). Adding it to `wrangler.toml` too is fine for `wrangler dev --remote`, but
Vectorize has no local simulator, so keep tests on FTS5 (LLM_MODE=mock disables vectors anyway):
```toml
# Vectorize — free plan: 5M stored dims (~4,880 bge-m3 vectors; code caps at 4,000) and 30M queried dims/month
# (code caps vector queries at 500/day). Namespaces: "org" and "a:<agent id>".
[[vectorize]]
binding = "KB_VECTORS"
index_name = "khaliya-kb"
```
No metadata index is needed (scopes use Vectorize namespaces).

## 6. Embedded migrations (only if remote `wrangler d1 migrations apply` is unavailable)
`scripts/embed-migrations.mjs`: add `"0007_memory_court.sql"` to `names` AND allow virtual tables in its check:
`/^CREATE (UNIQUE |VIRTUAL )?(TABLE|INDEX) IF NOT EXISTS /i`, then run `node scripts/embed-migrations.mjs`.
`test/ops.test.ts` lists the embedded names and must then include `"0007_memory_court.sql"`.
Note: `wrangler d1 export` does not export FTS5 virtual tables; `kb_fts` can be rebuilt from `kb_docs`.

## 7. Using the court from judging (optional, no judge.ts change required)
```ts
import { courtWeights, weightedJudgeScore, courtGate } from "../court/score";
const w = await courtWeights(env, panel.models);         // benched → 0, unknown → 1
const score = weightedJudgeScore(perJudgeScores, w);    // instead of the plain mean
const gate = await courtGate(env, panel.models);        // C5: ≥2 families with current, non-benched records
```

## 8. Lessons for the proposal operators (optional; evolution/engine.ts ~line 391)
```ts
import { lessonsFor } from "../memory/lessons";
const failed = [...(await recentNotes(env, parent.role, ["lost", "rejected", "rolled_back"], 5)).map((n) => n.note.slice(0, 200)),
                ...(await lessonsFor(env, parent.role, "prompt_rewrite", 1))];
```
