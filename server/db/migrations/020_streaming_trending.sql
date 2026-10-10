-- A snapshot is intentionally retained for each successful refresh.  This lets
-- us add rank movement later without changing the current-list API.
CREATE TABLE IF NOT EXISTS streaming_trending_snapshots (
  id BIGSERIAL PRIMARY KEY,
  service TEXT NOT NULL CHECK (service IN ('kinopoisk', 'okko', 'kion', 'wink', 'premier')),
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source_url TEXT NOT NULL,
  UNIQUE (service, fetched_at)
);

CREATE TABLE IF NOT EXISTS streaming_trending_items (
  snapshot_id BIGINT NOT NULL REFERENCES streaming_trending_snapshots(id) ON DELETE CASCADE,
  position SMALLINT NOT NULL CHECK (position > 0),
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
  source_title TEXT NOT NULL,
  source_url TEXT,
  PRIMARY KEY (snapshot_id, position),
  UNIQUE (snapshot_id, tmdb_id, media_type)
);

CREATE INDEX IF NOT EXISTS idx_streaming_trending_snapshot_service
  ON streaming_trending_snapshots(service, fetched_at DESC);
