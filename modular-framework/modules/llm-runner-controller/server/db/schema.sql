CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  url TEXT NOT NULL,
  token_hash TEXT,
  token_plain TEXT, -- MVP: stored to enable proxy; replace with encrypted storage later
  default_cwd TEXT,
  group_id TEXT,
  version TEXT,
  labels TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  last_seen_at TEXT,
  status TEXT DEFAULT 'offline' CHECK (status IN ('online','degraded','offline'))
);

CREATE TABLE IF NOT EXISTS agent_groups (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  labels TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS configs (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global','group','agent')),
  ref_id TEXT,
  version INTEGER NOT NULL,
  name TEXT,
  data TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assignments (
  agent_id TEXT NOT NULL,
  config_id TEXT NOT NULL,
  effective_version INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (agent_id, config_id)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  requester TEXT,
  kind TEXT,
  code_hash TEXT,
  cwd TEXT,
  env_redacted TEXT,
  status TEXT,
  exit_code INTEGER,
  stdout_head TEXT,
  stderr_head TEXT,
  duration_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS updates (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  target TEXT,
  strategy TEXT,
  status TEXT,
  logs TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT,
  token_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('reader','writer','admin')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_id);
CREATE INDEX IF NOT EXISTS idx_configs_scope_ref ON configs(scope, ref_id);

-- Initialize a global config record if not present
INSERT INTO configs (id, scope, ref_id, version, name, data)
SELECT 'cfg_global_v1', 'global', '*', 1, 'default', '{"runner":{"allowEnv":"HTTP_PROXY,HTTPS_PROXY"}}'
WHERE NOT EXISTS (SELECT 1 FROM configs WHERE scope='global');
