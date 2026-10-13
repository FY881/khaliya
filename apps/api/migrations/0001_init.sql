-- Khaliya registry schema (D1). P0/P1.
CREATE TABLE IF NOT EXISTS lineages (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  name TEXT NOT NULL,
  protected INTEGER NOT NULL DEFAULT 0,       -- 1 = cannot be mutated by agents it judges (Evaluator/Critic/Auditor)
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS genomes (
  id TEXT PRIMARY KEY,                         -- content hash: g_<sha256 prefix>
  lineage_id TEXT NOT NULL REFERENCES lineages(id),
  version INTEGER NOT NULL,
  role TEXT NOT NULL,
  parent_ids TEXT NOT NULL DEFAULT '[]',
  body TEXT NOT NULL,                          -- canonical genome JSON
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_genomes_lineage ON genomes(lineage_id, version);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  lineage_id TEXT NOT NULL REFERENCES lineages(id),
  genome_id TEXT NOT NULL REFERENCES genomes(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','sandboxed','candidate','champion','retired','quarantined')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);

CREATE TABLE IF NOT EXISTS deployments (
  role TEXT NOT NULL,
  genome_id TEXT NOT NULL REFERENCES genomes(id),
  agent_id TEXT NOT NULL,
  traffic_pct INTEGER NOT NULL DEFAULT 100,
  active INTEGER NOT NULL DEFAULT 1,
  deployed_at INTEGER NOT NULL,
  PRIMARY KEY (role, genome_id)
);

CREATE TABLE IF NOT EXISTS elo_ratings (
  genome_id TEXT PRIMARY KEY REFERENCES genomes(id),
  role TEXT NOT NULL,
  rating REAL NOT NULL DEFAULT 1200,
  rd REAL NOT NULL DEFAULT 350,
  matches INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  genome_id TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL,                        -- queued|running|done|failed|capped|killed
  stop_reason TEXT,
  steps INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  llm_calls INTEGER NOT NULL DEFAULT 0,
  wall_ms INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  trace TEXT,                                  -- JSON (truncated to 64 KB)
  seed TEXT,
  prompt_hash TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at DESC);

CREATE TABLE IF NOT EXISTS tools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tier INTEGER NOT NULL CHECK (tier BETWEEN 0 AND 4),
  description TEXT NOT NULL,
  schema TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  builtin INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS evals (
  id TEXT PRIMARY KEY,
  genome_id TEXT NOT NULL,
  suite TEXT NOT NULL,
  score REAL,
  details TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  run_id TEXT,
  tool_id TEXT NOT NULL,
  tier INTEGER NOT NULL,
  args TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired','executed','failed')),
  result TEXT,
  decided_by TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at DESC);

-- Append-only, hash-chained audit log.
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,                         -- owner | agent:<id> | system | governor
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;

-- Daily budget ledger. scope: global | agent:<id> | provider:<name>
CREATE TABLE IF NOT EXISTS budgets (
  day TEXT NOT NULL,
  scope TEXT NOT NULL,
  metric TEXT NOT NULL,                        -- llm_calls | tokens | tool_calls | runs | neurons
  used INTEGER NOT NULL DEFAULT 0,
  cap INTEGER NOT NULL,
  PRIMARY KEY (day, scope, metric)
);

-- Governor state (kill switches, cap overrides, auth anti-replay). Owner-only; no agent tool can write here.
CREATE TABLE IF NOT EXISTS governor_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- LLM response cache (KV-free) with TTL.
CREATE TABLE IF NOT EXISTS llm_cache (
  key TEXT PRIMARY KEY,
  response TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
