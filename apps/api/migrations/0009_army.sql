-- P16 Free Agent Army foundations: ranks, incidents, passports, capability tokens, missions, L5 grants,
-- army-level kill switches and a separate hash-chained army audit ledger. Additive + idempotent only
-- (CREATE ... IF NOT EXISTS) so it can be embedded by scripts/embed-migrations.mjs.

CREATE TABLE IF NOT EXISTS army_ranks (
  agent_id TEXT PRIMARY KEY,
  division TEXT NOT NULL,
  rank TEXT NOT NULL DEFAULT 'R0' CHECK (rank IN ('R0','R1','R2','R3','R4')),
  court_score REAL,                         -- Judge Court standing 0..1 (null = no verdicts yet)
  owner_accepted INTEGER NOT NULL DEFAULT 0, -- R3 needs owner acceptance; R4 is an owner decision
  reason TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_army_ranks_division ON army_ranks(division, rank);

CREATE TABLE IF NOT EXISTS army_incidents (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,                        -- security | canary_rollback | honeypot | weak_verdict | scope_violation | other
  severity INTEGER NOT NULL DEFAULT 1,       -- 1 low .. 4 critical
  detail TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_army_incidents_agent ON army_incidents(agent_id, at DESC);

CREATE TABLE IF NOT EXISTS army_passports (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  genome_id TEXT,
  genome_hash TEXT NOT NULL,
  lineage_id TEXT,
  rank TEXT NOT NULL,
  division TEXT NOT NULL,
  autonomy TEXT NOT NULL,
  redteam_score REAL,
  token_hash TEXT NOT NULL,                  -- sha256 of the signed passport string (the string itself is not stored)
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoke_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_army_passports_agent ON army_passports(agent_id, issued_at DESC);

CREATE TABLE IF NOT EXISTS army_capabilities (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  mission_id TEXT,
  parent_id TEXT,
  spec TEXT NOT NULL,                        -- the signed body (JSON), for listing / revocation cascades
  max_calls INTEGER NOT NULL,
  calls_used INTEGER NOT NULL DEFAULT 0,
  spend_cap_usd REAL NOT NULL DEFAULT 0,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoke_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_army_caps_agent ON army_capabilities(agent_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_army_caps_mission ON army_capabilities(mission_id);
CREATE INDEX IF NOT EXISTS idx_army_caps_revoked ON army_capabilities(revoked_at);

CREATE TABLE IF NOT EXISTS army_missions (
  id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  contract TEXT NOT NULL,                    -- full mission contract JSON
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','running','verifying','done','failed','rolled_back')),
  autonomy TEXT NOT NULL,
  action_class TEXT NOT NULL,
  risk_tier INTEGER NOT NULL,
  division TEXT,
  approvals TEXT NOT NULL DEFAULT '[]',      -- keys collected [{approver, by, at}]
  job_id TEXT,
  verdict TEXT,                              -- verifier result JSON
  rollback TEXT,                             -- rollback execution record JSON
  created_by TEXT NOT NULL,
  deadline INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_army_missions_status ON army_missions(status, created_at DESC);

CREATE TABLE IF NOT EXISTS army_l5_grants (
  mission_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_army_l5_agent ON army_l5_grants(agent_id, expires_at);

CREATE TABLE IF NOT EXISTS army_kill_switches (
  scope_key TEXT PRIMARY KEY,                -- division:<id> | mission:<id>
  on_flag INTEGER NOT NULL DEFAULT 0,
  actor TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS army_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE                  -- sha256(canonical {at, actor, action, target, detail, prev_hash})
);
CREATE INDEX IF NOT EXISTS idx_army_audit_action ON army_audit(action, seq DESC);
