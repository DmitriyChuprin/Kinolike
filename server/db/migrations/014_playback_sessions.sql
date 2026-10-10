CREATE TABLE IF NOT EXISTS jellyfin_playback_sessions (
  play_session_id TEXT PRIMARY KEY,
  client_session_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  jellyfin_item_id TEXT NOT NULL,
  media_source_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'tv')),
  play_method TEXT NOT NULL DEFAULT 'DirectPlay',
  audio_stream_index INTEGER,
  subtitle_stream_index INTEGER,
  state TEXT NOT NULL DEFAULT 'prepared'
    CHECK(state IN ('prepared', 'playing', 'stopping', 'stopped')),
  position_ticks BIGINT NOT NULL DEFAULT 0,
  duration_ticks BIGINT NOT NULL DEFAULT 0,
  last_progress_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  stopped_at TIMESTAMPTZ,
  stop_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_jellyfin_playback_sessions_active
  ON jellyfin_playback_sessions (state, last_progress_at);
CREATE INDEX IF NOT EXISTS idx_jellyfin_playback_sessions_owner
  ON jellyfin_playback_sessions (user_id, client_session_id, created_at DESC);
