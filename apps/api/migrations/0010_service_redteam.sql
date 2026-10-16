-- Safety wave piece 2 (2026-10-16): Studio-service red-team campaign results (one row per probe × runtime).
-- Additive + idempotent only (CREATE ... IF NOT EXISTS) so it can be embedded by scripts/embed-migrations.mjs.

CREATE TABLE IF NOT EXISTS service_redteam_runs (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,                 -- the job id
  slug TEXT NOT NULL,
  version INTEGER NOT NULL,
  attack_id TEXT NOT NULL,
  category TEXT NOT NULL,
  lang TEXT NOT NULL,
  runtime TEXT NOT NULL CHECK (runtime IN ('hardened','legacy')),
  breach INTEGER NOT NULL DEFAULT 0,
  hits TEXT NOT NULL DEFAULT '[]',           -- [{detector, evidence}]
  guard TEXT NOT NULL DEFAULT '[]',          -- guard action kinds that ran (hardened) / would run (legacy)
  guard_blocked INTEGER NOT NULL DEFAULT 0,
  answer TEXT,                               -- <= 700 chars, credential-scrubbed, canaries masked (owner-only)
  model TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_service_redteam_campaign ON service_redteam_runs(campaign_id, slug, runtime);
CREATE INDEX IF NOT EXISTS idx_service_redteam_attack ON service_redteam_runs(slug, attack_id, runtime, at);
