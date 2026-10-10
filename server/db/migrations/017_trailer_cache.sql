CREATE TABLE IF NOT EXISTS trailer_cache (
  id SERIAL PRIMARY KEY,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
  source TEXT NOT NULL,
  video_id TEXT,
  url TEXT NOT NULL,
  embed_url TEXT,
  language TEXT,
  type TEXT,
  official BOOLEAN NOT NULL DEFAULT FALSE,
  title TEXT,
  score INTEGER NOT NULL DEFAULT 0,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  available BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (tmdb_id, media_type, source, video_id)
);

CREATE INDEX IF NOT EXISTS idx_trailer_cache_lookup
  ON trailer_cache (tmdb_id, media_type, available, score DESC, checked_at DESC);
