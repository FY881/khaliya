-- Khaliya P2 (Eval & Benchmark Factory) + P3 (Evolution Loop).

-- ---------------- P2: eval factory ----------------
CREATE TABLE IF NOT EXISTS eval_suites (
  id TEXT PRIMARY KEY,                          -- e.g. code-core
  role TEXT NOT NULL,                           -- role whose champion this suite benchmarks
  name TEXT NOT NULL,
  name_ar TEXT,
  description TEXT,
  level INTEGER NOT NULL DEFAULT 5,             -- difficulty ladder: current top difficulty
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  saturation REAL,                              -- latest champion pass rate on the private split
  saturation_genome TEXT,
  saturated_at INTEGER,
  ladder_requested_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS eval_items (
  id TEXT PRIMARY KEY,                          -- ei_<sha256 prefix of the normalized content>
  suite_id TEXT NOT NULL REFERENCES eval_suites(id),
  role TEXT NOT NULL,
  task TEXT NOT NULL,
  inputs TEXT NOT NULL DEFAULT '{}',
  checker TEXT NOT NULL,                        -- JSON: {type: exact|regex|json_schema|numeric|contains|rubric, ...}
  reference TEXT,                               -- reference solution: owner/Governor only, never shown to agents
  difficulty INTEGER NOT NULL CHECK (difficulty BETWEEN 1 AND 10),
  tags TEXT NOT NULL DEFAULT '[]',
  split TEXT NOT NULL CHECK (split IN ('public','private','canary')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','reserve','rejected','retired')),
  quality REAL,
  norm_hash TEXT NOT NULL,
  validation TEXT,                              -- JSON report of the last validation
  author TEXT NOT NULL,                         -- owner | system:seed | system:ladder | agent:<id>
  author_lineage TEXT,
  checks INTEGER NOT NULL DEFAULT 0,            -- re-check count (flake detection)
  flakes INTEGER NOT NULL DEFAULT 0,
  status_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_eval_items_hash ON eval_items(norm_hash);
CREATE INDEX IF NOT EXISTS idx_eval_items_suite ON eval_items(suite_id, status, split);

-- Every graded answer (validation baselines, sandbox, tournament, canary, saturation, flake re-checks).
CREATE TABLE IF NOT EXISTS eval_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  genome_id TEXT NOT NULL,
  context TEXT NOT NULL,                        -- validation|sandbox|tournament|canary|saturation|recheck
  ref TEXT,                                     -- tournament / canary / proposal id
  pass INTEGER NOT NULL,
  score REAL NOT NULL,
  answer TEXT,
  judge TEXT,                                   -- JSON verdict (method, agreement, per-judge scores)
  tokens INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eval_results_pair ON eval_results(genome_id, item_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_results_ref ON eval_results(ref);

-- ---------------- P3: evolution loop ----------------
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  lineage_id TEXT NOT NULL,
  genome_id TEXT,                               -- candidate genome (null if it never became a valid genome)
  parent_ids TEXT NOT NULL DEFAULT '[]',
  operator TEXT NOT NULL,
  proposer TEXT NOT NULL,                       -- agent:<id> | owner | system:evolution
  agent_id TEXT,                                -- sandbox/candidate agent
  stage TEXT NOT NULL CHECK (stage IN ('proposed','checked','sandboxed','tournament','canary','promoted','rolled_back','rejected','lost')),
  reason TEXT,
  note TEXT,                                    -- the operator's own description of the change
  static_report TEXT,
  sandbox_report TEXT,
  tournament_id TEXT,
  decision TEXT,                                -- promotion-gate report
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proposals_stage ON proposals(stage, created_at);
CREATE INDEX IF NOT EXISTS idx_proposals_role ON proposals(role, created_at DESC);

CREATE TABLE IF NOT EXISTS tournaments (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  champion_genome TEXT NOT NULL,
  participants TEXT NOT NULL,                   -- JSON [{genome_id, agent_id, proposal_id?}]
  items TEXT NOT NULL,                          -- JSON [item ids] (held-out private split)
  status TEXT NOT NULL CHECK (status IN ('running','done','aborted')),
  summary TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tournaments_role ON tournaments(role, created_at DESC);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  a_genome TEXT NOT NULL,
  b_genome TEXT NOT NULL,
  outcome REAL NOT NULL,                        -- 1 = a wins, 0 = b wins, 0.5 = tie (from a's view)
  method TEXT NOT NULL,                         -- deterministic | panel
  agreement REAL NOT NULL DEFAULT 1,
  detail TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_matches_t ON matches(tournament_id);

CREATE TABLE IF NOT EXISTS promotions (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('canary_start','promote','auto_rollback','owner_rollback')),
  from_genome TEXT,
  to_genome TEXT,
  from_agent TEXT,
  to_agent TEXT,
  proposal_id TEXT,
  reason TEXT,
  detail TEXT,
  actor TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_promotions_role ON promotions(role, at DESC);

CREATE TABLE IF NOT EXISTS canaries (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  candidate_agent TEXT NOT NULL,
  candidate_genome TEXT NOT NULL,
  champion_agent TEXT NOT NULL,
  champion_genome TEXT NOT NULL,
  traffic_pct INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','promoted','rolled_back')),
  obs INTEGER NOT NULL DEFAULT 0,
  cand_pass INTEGER NOT NULL DEFAULT 0,
  champ_pass INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  started_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_canaries_status ON canaries(status, role);

-- Thompson-sampling bandit over mutation operators (per role).
CREATE TABLE IF NOT EXISTS operator_stats (
  role TEXT NOT NULL,
  operator TEXT NOT NULL,
  alpha REAL NOT NULL DEFAULT 1,
  beta REAL NOT NULL DEFAULT 1,
  trials INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (role, operator)
);

-- "What worked" (and what did not): fed back into future proposals until the P5 knowledge base exists.
CREATE TABLE IF NOT EXISTS evolution_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  operator TEXT NOT NULL,
  genome_id TEXT,
  outcome TEXT NOT NULL,                        -- promoted | rolled_back | lost | rejected
  note TEXT NOT NULL,
  delta REAL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evolution_notes_role ON evolution_notes(role, at DESC);

-- Glicko-2 volatility (rating / rd already exist from P1).
ALTER TABLE elo_ratings ADD COLUMN vol REAL NOT NULL DEFAULT 0.06;
