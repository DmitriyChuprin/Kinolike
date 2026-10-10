-- Phantom is not backed by Jellyfin UserData, so its resume state belongs to
-- KinoLike.  Keeping a completed row (rather than deleting it) makes a late
-- request from an older device conflict instead of resurrecting a resume.
CREATE TABLE IF NOT EXISTS phantom_watch_positions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'tv')),
  -- 0 is the internal movie sentinel; API responses keep movie season/episode
  -- absent. PostgreSQL primary-key columns cannot be NULL.
  season INTEGER NOT NULL DEFAULT 0 CHECK(season >= 0),
  episode INTEGER NOT NULL DEFAULT 0 CHECK(episode >= 0),
  position_seconds DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK(position_seconds >= 0),
  duration_seconds DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK(duration_seconds >= 0),
  completed_at TIMESTAMPTZ NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, tmdb_id, media_type, season, episode),
  CHECK (
    (media_type = 'movie' AND season = 0 AND episode = 0) OR
    (media_type = 'tv' AND season > 0 AND episode > 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_phantom_watch_positions_recent
  ON phantom_watch_positions (user_id, updated_at DESC);
