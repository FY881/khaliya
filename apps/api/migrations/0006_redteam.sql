-- Khaliya P8: Red-Team Arena (ARCHITECTURE §18 P8, §19 C6). Attacks are data; targets run in sandbox mode against
-- simulated tools; deterministic detectors + a critic score each run; a breach is confirmed only after a clean
-- control run and two reproductions, and then becomes a permanent regression test (mirrored as an eval item in the
-- 'redteam-core' suite). Additive and idempotent (CREATE ... IF NOT EXISTS only) so it can be embedded.

CREATE TABLE IF NOT EXISTS redteam_attacks (
  id TEXT PRIMARY KEY,                          -- rta_<sha256 prefix of the content>
  hash TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  lang TEXT NOT NULL,
  vector TEXT NOT NULL,
  title TEXT NOT NULL,
  difficulty INTEGER NOT NULL,
  spec TEXT NOT NULL,                           -- JSON AttackSpec (task, payload, goal, expected_safe, safe_reference)
  source TEXT NOT NULL DEFAULT 'seed',          -- seed | owner | attacker:<id>
  attacker_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',        -- active | candidate | rejected | retired
  validation TEXT,                              -- JSON admission report
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_redteam_attacks_cat ON redteam_attacks(status, category, difficulty);

CREATE TABLE IF NOT EXISTS redteam_attackers (
  id TEXT PRIMARY KEY,                          -- attacker lineage id, e.g. rt-attacker
  name TEXT NOT NULL,
  genome TEXT NOT NULL,                         -- JSON AttackerGenome (T1/T2 only, no tools, no network)
  generated INTEGER NOT NULL DEFAULT 0,         -- attacks admitted to the library
  rejected INTEGER NOT NULL DEFAULT 0,          -- generated attacks refused at admission
  confirmed INTEGER NOT NULL DEFAULT 0,         -- attacks that produced a confirmed (reproduced) breach
  score REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS redteam_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id TEXT,                             -- job id (or 'gate:<candidate>' for promotion-gate runs)
  attack_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  genome_id TEXT NOT NULL,
  role TEXT NOT NULL,
  category TEXT NOT NULL,
  kind TEXT NOT NULL,                           -- probe | control | repro | gate
  breach INTEGER NOT NULL DEFAULT 0,
  soft INTEGER NOT NULL DEFAULT 0,
  severity REAL NOT NULL DEFAULT 0,
  contained INTEGER NOT NULL DEFAULT 1,
  detectors TEXT,                               -- JSON DetectorHit[]
  critic TEXT,                                  -- JSON CriticVerdict | null
  trace TEXT,                                   -- JSON TargetTrace (truncated)
  llm_calls INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_redteam_results_agent ON redteam_results(kind, agent_id, attack_id);
CREATE INDEX IF NOT EXISTS idx_redteam_results_genome ON redteam_results(genome_id, attack_id, kind);
CREATE INDEX IF NOT EXISTS idx_redteam_results_campaign ON redteam_results(campaign_id);

CREATE TABLE IF NOT EXISTS redteam_breaches (
  id TEXT PRIMARY KEY,                          -- rtb_<random>
  attack_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  genome_id TEXT NOT NULL,
  role TEXT NOT NULL,
  category TEXT NOT NULL,
  campaign_id TEXT,
  status TEXT NOT NULL DEFAULT 'suspected',     -- suspected | confirmed | rejected
  soft INTEGER NOT NULL DEFAULT 0,              -- critic-only breach
  severity REAL NOT NULL DEFAULT 0,
  contained INTEGER NOT NULL DEFAULT 1,
  repro_ok INTEGER NOT NULL DEFAULT 0,
  repro_runs INTEGER NOT NULL DEFAULT 0,
  control_breach INTEGER,                       -- null = control not run yet
  detectors TEXT,                               -- JSON DetectorHit[] of the probe
  evidence TEXT,                                -- JSON {final, actions} excerpt
  regression_id TEXT,
  attacker_id TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (attack_id, genome_id)
);
CREATE INDEX IF NOT EXISTS idx_redteam_breaches_status ON redteam_breaches(status, category);

CREATE TABLE IF NOT EXISTS redteam_regressions (
  id TEXT PRIMARY KEY,                          -- rtr_<attack hash prefix>
  attack_id TEXT NOT NULL UNIQUE,
  breach_id TEXT NOT NULL,
  category TEXT NOT NULL,
  soft INTEGER NOT NULL DEFAULT 0,
  eval_item_id TEXT,                            -- mirror item in eval suite 'redteam-core'
  gates TEXT,                                   -- JSON eval-factory gate results for the mirror item
  status TEXT NOT NULL DEFAULT 'active',        -- permanent: there is no retire path in code
  created_at INTEGER NOT NULL
);
