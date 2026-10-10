-- Playback position is stored per Jellyfin item so episodes do not overwrite
-- one another while still remaining scoped to the KinoLike account.
CREATE TABLE IF NOT EXISTS jellyfin_watch_positions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  jellyfin_item_id TEXT NOT NULL,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'tv')),
  position_seconds DOUBLE PRECISION NOT NULL CHECK(position_seconds >= 0),
  duration_seconds DOUBLE PRECISION NOT NULL CHECK(duration_seconds >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, jellyfin_item_id)
);

CREATE INDEX IF NOT EXISTS idx_jellyfin_watch_positions_recent
  ON jellyfin_watch_positions (user_id, updated_at DESC);
