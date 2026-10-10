-- Normalized skip markers are shared metadata, not per-user playback state.
-- Duration is part of the key because releases can have different offsets.
CREATE TABLE IF NOT EXISTS streaming_segments (
  tmdb_id INTEGER NOT NULL,
  imdb_id TEXT,
  media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
  season INTEGER NOT NULL DEFAULT 0 CHECK (season >= 0),
  episode INTEGER NOT NULL DEFAULT 0 CHECK (episode >= 0),
  duration_seconds DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  intro_start DOUBLE PRECISION,
  intro_end DOUBLE PRECISION,
  credits_start DOUBLE PRECISION,
  credits_end DOUBLE PRECISION,
  source TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tmdb_id, media_type, season, episode, duration_seconds),
  CHECK ((intro_start IS NULL AND intro_end IS NULL) OR (intro_start >= 0 AND intro_end > intro_start)),
  CHECK ((credits_start IS NULL AND credits_end IS NULL) OR (credits_start >= 0 AND credits_end > credits_start))
);
CREATE INDEX IF NOT EXISTS idx_streaming_segments_lookup
  ON streaming_segments (tmdb_id, media_type, season, episode, updated_at DESC);
