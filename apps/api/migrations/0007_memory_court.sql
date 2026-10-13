-- P5: Org Memory + Knowledge Base (src/memory) and Judge Court C5 (src/court).
-- Additive and idempotent only (CREATE ... IF NOT EXISTS), no triggers, no semicolons inside statements,
-- so scripts/embed-migrations.mjs can embed it (its regex must also allow CREATE VIRTUAL TABLE).

-- One row per memory/KB document. scope = 'org' (shared KB) or 'agent:<id>' (that agent's episodic memory).
CREATE TABLE IF NOT EXISTS kb_docs (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('doc','episode','lesson','summary','playbook')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'agent',
  author TEXT NOT NULL,
  author_role TEXT,
  author_lineage TEXT,
  trust TEXT NOT NULL DEFAULT 'pending' CHECK (trust IN ('trusted','pending','untrusted','rejected')),
  flags TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.5,
  content_hash TEXT NOT NULL,
  dup_of TEXT,
  votes INTEGER NOT NULL DEFAULT 0,
  uses INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  expires_at INTEGER,
  summary_of TEXT,
  embedded INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','expired','merged')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_docs_hash ON kb_docs(scope, content_hash);
CREATE INDEX IF NOT EXISTS idx_kb_docs_scope ON kb_docs(scope, status, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_kb_docs_trust ON kb_docs(trust, status, created_at);
CREATE INDEX IF NOT EXISTS idx_kb_docs_expiry ON kb_docs(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_kb_docs_author ON kb_docs(author, scope, status);

-- Keyword index (fallback when Vectorize is unbound, and the lexical half of hybrid search).
-- Text is stored pre-normalised (Arabic diacritics/alef/taa-marbuta folded, lowercased) by src/memory/text.ts.
CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(doc_id UNINDEXED, scope UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');

-- Review trail: critic-role or owner verdicts that move a doc between trust levels.
CREATE TABLE IF NOT EXISTS kb_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  reviewer_role TEXT,
  verdict TEXT NOT NULL CHECK (verdict IN ('approve','reject','untrusted')),
  method TEXT NOT NULL,
  notes TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_reviews_doc ON kb_reviews(doc_id, at);

-- Small key/value state for memory jobs (distillation cursor etc.). Not governor_state.
CREATE TABLE IF NOT EXISTS kb_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Judge Court: one row per probe unit (a judge seen in both orders on one probe item).
CREATE TABLE IF NOT EXISTS court_probes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  judge_model TEXT NOT NULL,
  judge_family TEXT NOT NULL,
  probe TEXT NOT NULL CHECK (probe IN ('position','verbosity','self_pref','lang','gold')),
  lang TEXT NOT NULL CHECK (lang IN ('en','ar')),
  item_key TEXT NOT NULL,
  ab TEXT NOT NULL,
  ba TEXT NOT NULL,
  verdict TEXT NOT NULL,
  consistent INTEGER NOT NULL,
  outcome REAL,
  detail TEXT,
  job_id TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_court_probes_judge ON court_probes(judge_model, probe, at);
CREATE INDEX IF NOT EXISTS idx_court_probes_item ON court_probes(item_key, lang, at);

-- Reliability record per judge per day (kept over time, latest row is current).
CREATE TABLE IF NOT EXISTS court_scores (
  judge_model TEXT NOT NULL,
  day TEXT NOT NULL,
  judge_family TEXT NOT NULL,
  n_probes INTEGER NOT NULL DEFAULT 0,
  position_consistency REAL,
  verbosity_bias REAL,
  self_pref_rate REAL,
  lang_consistency REAL,
  gold_accuracy_en REAL,
  gold_accuracy_ar REAL,
  kappa_en REAL,
  kappa_ar REAL,
  n_labels INTEGER NOT NULL DEFAULT 0,
  reliability REAL NOT NULL,
  weight REAL NOT NULL,
  benched INTEGER NOT NULL DEFAULT 0,
  reasons TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (judge_model, day)
);

-- Owner spot-check queue: items where judges disagreed (with each other, with gold, or across languages).
CREATE TABLE IF NOT EXISTS court_spotchecks (
  id TEXT PRIMARY KEY,
  judge_model TEXT,
  lang TEXT NOT NULL CHECK (lang IN ('en','ar')),
  item_key TEXT NOT NULL,
  item TEXT NOT NULL,
  judge_verdicts TEXT NOT NULL DEFAULT '{}',
  reason TEXT NOT NULL,
  owner_label TEXT CHECK (owner_label IN ('A','B','tie') OR owner_label IS NULL),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','labelled','skipped')),
  created_at INTEGER NOT NULL,
  labelled_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_court_spot_item ON court_spotchecks(item_key, lang);
CREATE INDEX IF NOT EXISTS idx_court_spot_status ON court_spotchecks(status, created_at);
