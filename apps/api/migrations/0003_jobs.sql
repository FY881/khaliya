-- Khaliya: background job system for long lab work (seed, saturation, evolution generation / tick).
-- A POST creates a row and returns its id at once; the JobRunner Durable Object advances it in small chunks
-- (one alarm invocation per chunk, each within free-plan CPU / subrequest limits) and stores progress here.
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,                          -- job_<hex>
  kind TEXT NOT NULL,                           -- eval.seed | eval.saturation | evolution.generation | evolution.tick
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','cancelled')),
  params TEXT NOT NULL DEFAULT '{}',            -- JSON: what the owner asked for
  state TEXT,                                   -- JSON: resumable cursor (handler-specific)
  dedupe_key TEXT,                              -- identical active jobs are not created twice
  progress_done INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  message TEXT,                                 -- last step, human readable
  result TEXT,                                  -- JSON summary when finished (also partial while running)
  error TEXT,
  stopped TEXT,                                 -- why a finished job stopped early: budget | daily_budget | killed | cancelled
  llm_calls INTEGER NOT NULL DEFAULT 0,
  max_calls INTEGER NOT NULL,
  chunks INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,          -- consecutive failed chunks (3 → failed)
  lease_until INTEGER,                          -- a chunk is running until then (prevents double execution)
  not_before INTEGER,                           -- earliest time of the next chunk (back-off)
  created_by TEXT NOT NULL DEFAULT 'owner',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_dedupe ON jobs(dedupe_key, status);
