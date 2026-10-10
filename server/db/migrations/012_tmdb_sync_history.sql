-- Track TMDB catalog sync runs
CREATE TABLE IF NOT EXISTS tmdb_sync_history (
  id SERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed')),
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_tmdb_sync_history_started ON tmdb_sync_history(started_at DESC);

-- Store the timestamp of the last successful sync
CREATE TABLE IF NOT EXISTS tmdb_sync_state (
  key TEXT PRIMARY KEY,
  value TIMESTAMPTZ NOT NULL
);
