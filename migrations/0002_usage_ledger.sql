-- Per-turn usage ledger. One row per `usage` event from the provider so the
-- user can audit token consumption across sessions instead of trusting an
-- in-memory counter that vanishes when the REPL closes. Powers the /usage
-- slash command and `squad usage` CLI subcommand.

CREATE TABLE IF NOT EXISTS usage_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  session_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  slash_command TEXT,
  source TEXT NOT NULL DEFAULT 'turn'
);

CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_ledger (ts DESC);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_ledger (session_id);
CREATE INDEX IF NOT EXISTS idx_usage_cwd_ts ON usage_ledger (cwd, ts DESC);
