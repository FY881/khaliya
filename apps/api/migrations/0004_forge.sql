-- Khaliya P4: Tool Forge (ARCHITECTURE §7). Forged tools run only inside the QuickJS-WASM sandbox.

CREATE TABLE IF NOT EXISTS forge_tools (
  id TEXT PRIMARY KEY,                          -- ft_<hash prefix>
  name TEXT NOT NULL,                           -- forge.<segment>[.<segment>…]
  version INTEGER NOT NULL,                     -- 1, 2, … per name
  hash TEXT NOT NULL,                           -- sha256 of the canonical spec (behaviour-defining fields)
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','admitted','rejected','deprecated')),
  status_reason TEXT,
  author TEXT NOT NULL,                         -- agent:<id> | owner | system:<x>
  lineage_id TEXT,
  spec TEXT NOT NULL,                           -- JSON: name, description, input_schema, output_schema, entry, tests, limits
  code TEXT NOT NULL,
  report TEXT,                                  -- JSON admission report (gates, warnings, stats)
  uses INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  admitted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_forge_tools_name_version ON forge_tools(name, version);
CREATE UNIQUE INDEX IF NOT EXISTS idx_forge_tools_name_hash ON forge_tools(name, hash);
CREATE INDEX IF NOT EXISTS idx_forge_tools_status ON forge_tools(status, name);

-- Every sandbox execution of a forged tool or verifier (admission, gateway call, verifier).
CREATE TABLE IF NOT EXISTS forge_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_id TEXT,                                 -- null for ad-hoc verifier runs
  context TEXT NOT NULL CHECK (context IN ('admission','call','verifier')),
  caller TEXT,                                  -- agent:<id> | owner | system:<x>
  run_id TEXT,
  ok INTEGER NOT NULL,
  error_kind TEXT,
  ms REAL NOT NULL DEFAULT 0,
  fuel_used INTEGER NOT NULL DEFAULT 0,
  output_bytes INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_forge_runs_tool ON forge_runs(tool_id, at DESC);
