-- 0008 Agent Studio + Hive Services (additive; CREATE ... IF NOT EXISTS only).
-- Studio: briefs → designs (architect pipeline, job "studio.design") → promoted genomes.
-- Services: versioned endpoints over promoted designs, customer keys (hashed), quotas, metering, audit.
-- Everything customer-facing stays behind env SERVICES_PUBLIC (default "off").

CREATE TABLE IF NOT EXISTS studio_briefs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  title_ar TEXT NOT NULL,
  spec TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'seed' CHECK (source IN ('seed','owner')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS studio_designs (
  id TEXT PRIMARY KEY,
  brief_id TEXT NOT NULL,
  genome_id TEXT,
  lineage_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'designing' CHECK (status IN ('designing','evaluating','promoted','rejected','failed')),
  suite_id TEXT,
  job_id TEXT,
  report TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  promoted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_studio_designs_brief ON studio_designs(brief_id, created_at);
CREATE INDEX IF NOT EXISTS idx_studio_designs_status ON studio_designs(status);

CREATE TABLE IF NOT EXISTS services (
  slug TEXT PRIMARY KEY,
  brief_id TEXT NOT NULL,
  title TEXT NOT NULL,
  title_ar TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','unlisted','retired')),
  current_version INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS service_versions (
  slug TEXT NOT NULL,
  version INTEGER NOT NULL,
  design_id TEXT NOT NULL,
  genome_id TEXT NOT NULL,
  eval_summary TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (slug, version)
);

CREATE TABLE IF NOT EXISTS service_customers (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  contact TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS service_keys (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '["*"]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_service_keys_customer ON service_keys(customer_id);

CREATE TABLE IF NOT EXISTS service_usage (
  key_id TEXT NOT NULL,
  period TEXT NOT NULL,
  metric TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, period, metric)
);

CREATE TABLE IF NOT EXISTS service_rate (
  key_id TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, bucket)
);

CREATE TABLE IF NOT EXISTS service_invocations (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  version INTEGER,
  key_id TEXT,
  caller TEXT NOT NULL CHECK (caller IN ('owner','key')),
  status TEXT NOT NULL,
  reason TEXT,
  credits INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  ms INTEGER NOT NULL DEFAULT 0,
  input_hash TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_service_invocations_slug ON service_invocations(slug, at);
CREATE INDEX IF NOT EXISTS idx_service_invocations_key ON service_invocations(key_id, at);

CREATE TABLE IF NOT EXISTS service_billing_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_type TEXT,
  payload_hash TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ignored',
  received_at INTEGER NOT NULL
);
