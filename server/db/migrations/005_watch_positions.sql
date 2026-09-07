-- Позиции просмотра (для "Продолжить просмотр")
CREATE TABLE IF NOT EXISTS watch_positions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'tv')),
  position REAL NOT NULL DEFAULT 0,        -- seconds watched
  duration REAL NOT NULL DEFAULT 0,        -- total duration in seconds
  title TEXT DEFAULT '',
  poster_path TEXT DEFAULT '',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, tmdb_id, media_type)
);

CREATE INDEX IF NOT EXISTS idx_watch_positions_user ON watch_positions(user_id);
CREATE INDEX IF NOT EXISTS idx_watch_positions_updated ON watch_positions(user_id, updated_at DESC);
