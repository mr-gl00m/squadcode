-- Squad Code initial schema. Charter §4 hygiene: WAL, foreign keys on, prepared statements only.
-- The connection layer (src/db/connect.ts) sets PRAGMA journal_mode=WAL and PRAGMA foreign_keys=ON.

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  session_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  prev_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log (session_id);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (ts);

CREATE TABLE IF NOT EXISTS sessions_index (
  session_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cwd TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  turn_count INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions_index (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions_index (cwd, updated_at DESC);
