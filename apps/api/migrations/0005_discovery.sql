-- Khaliya P4.5: Discovery Lab core (ARCHITECTURE §17). Problems with sandboxed verifiers, evolved programs
-- (islands + MAP-Elites), and records with certificates. A record is shown as 'verified' only after two
-- independent re-verifications; a record that beats the published best is flagged for human review and
-- never claimed automatically.

CREATE TABLE IF NOT EXISTS discovery_problems (
  id TEXT PRIMARY KEY,                          -- slug, e.g. golomb-10
  family TEXT NOT NULL,
  title_en TEXT NOT NULL,
  title_ar TEXT NOT NULL,
  statement_en TEXT NOT NULL,
  statement_ar TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('max','min')),
  params TEXT NOT NULL DEFAULT '{}',            -- JSON: human-stated instance parameters
  instance TEXT NOT NULL,                       -- JSON: full instance given to construct() and verify()
  verifier TEXT NOT NULL,                       -- guest JS declaring verify({solution, instance})
  verifier_hash TEXT NOT NULL,
  seed_program TEXT NOT NULL,                   -- guest JS declaring construct(input)
  best_known_score REAL,
  best_known_status TEXT NOT NULL DEFAULT 'unverified',
  best_known_source TEXT NOT NULL DEFAULT '',
  tolerance REAL NOT NULL DEFAULT 1e-9,
  limits TEXT,                                  -- JSON {constructFuel, verifyFuel}
  source TEXT NOT NULL DEFAULT 'builtin',       -- builtin | owner | agent:<id>
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','rejected')),
  validation TEXT,                              -- JSON submission-validation report
  examples TEXT,                                -- JSON {good:[], bad:[]} (submitted problems)
  generation INTEGER NOT NULL DEFAULT 0,
  islands INTEGER NOT NULL DEFAULT 3,
  bandit TEXT,                                  -- JSON ThompsonBandit over mutation operators
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discovery_problems_status ON discovery_problems(status, family);

CREATE TABLE IF NOT EXISTS discovery_programs (
  id TEXT PRIMARY KEY,                          -- dp_<random>
  problem_id TEXT NOT NULL REFERENCES discovery_problems(id),
  island INTEGER NOT NULL DEFAULT 0,
  hash TEXT NOT NULL,                           -- sha256 of the code
  code TEXT NOT NULL,
  score REAL,                                   -- verifier score (null when invalid)
  valid INTEGER NOT NULL DEFAULT 0,
  cell TEXT,                                    -- MAP-Elites cell "scoreBucket.lengthBucket.behaviour"
  elite INTEGER NOT NULL DEFAULT 0,             -- 1 = current elite of (problem, island, cell)
  parent_id TEXT,
  second_parent_id TEXT,
  operator TEXT NOT NULL,                       -- seed | tweak | crossover | llm | migration
  lineage TEXT,                                 -- agent / lineage that wrote it (e.g. lab:discovery, model id)
  generation INTEGER NOT NULL DEFAULT 0,
  eval_seed INTEGER NOT NULL DEFAULT 1,         -- sandbox seed used for construct()
  solution TEXT,                                -- JSON solution produced (kept for valid programs only)
  error TEXT,                                   -- sandbox / verifier error for invalid programs
  construct_ms REAL,
  verify_ms REAL,
  fuel_used INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_discovery_programs_hash ON discovery_programs(problem_id, island, hash);
CREATE INDEX IF NOT EXISTS idx_discovery_programs_elite ON discovery_programs(problem_id, island, elite, cell);
CREATE INDEX IF NOT EXISTS idx_discovery_programs_score ON discovery_programs(problem_id, valid, score);

CREATE TABLE IF NOT EXISTS discovery_records (
  id TEXT PRIMARY KEY,                          -- dr_<random>
  problem_id TEXT NOT NULL REFERENCES discovery_problems(id),
  score REAL NOT NULL,
  program_id TEXT REFERENCES discovery_programs(id),
  solution TEXT NOT NULL,                       -- JSON: the exact certificate
  verifier_hash TEXT NOT NULL,
  instance_hash TEXT NOT NULL,
  eval_seed INTEGER NOT NULL DEFAULT 1,
  lineage TEXT,
  verified_count INTEGER NOT NULL DEFAULT 0,
  verifications TEXT NOT NULL DEFAULT '[]',    -- JSON [{seed, valid, score, at, ms, detail}]
  reproducible INTEGER,                         -- 1/0 once the program was re-run with its own seed
  vs_known TEXT NOT NULL DEFAULT 'unknown' CHECK (vs_known IN ('below','matches','beats','unknown')),
  best_known_score REAL,                        -- snapshot of the published value at creation
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','verified','beats_known_needs_review','rejected')),
  status_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discovery_records_problem ON discovery_records(problem_id, status, score);
