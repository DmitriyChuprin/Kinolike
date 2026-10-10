-- Personalization platform: explicit preferences, recommendation feedback,
-- impression/outcome history and a short-lived derived taste-profile cache.

CREATE TABLE IF NOT EXISTS user_taste_preferences (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  genre_preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  min_year INTEGER CHECK (min_year IS NULL OR min_year BETWEEN 1880 AND 2200),
  max_year INTEGER CHECK (max_year IS NULL OR max_year BETWEEN 1880 AND 2200),
  min_rating REAL CHECK (min_rating IS NULL OR min_rating BETWEEN 0 AND 10),
  min_vote_count INTEGER CHECK (min_vote_count IS NULL OR min_vote_count >= 0),
  runtime_min INTEGER CHECK (runtime_min IS NULL OR runtime_min >= 0),
  runtime_max INTEGER CHECK (runtime_max IS NULL OR runtime_max >= 0),
  include_unknown BOOLEAN NOT NULL DEFAULT FALSE,
  include_classics BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (min_year IS NULL OR max_year IS NULL OR min_year <= max_year),
  CHECK (runtime_min IS NULL OR runtime_max IS NULL OR runtime_min <= runtime_max)
);

CREATE TABLE IF NOT EXISTS recommendation_events (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
  algorithm TEXT NOT NULL DEFAULT 'personal_v2',
  request_query TEXT,
  request_key TEXT,
  score REAL,
  score_components JSONB NOT NULL DEFAULT '{}'::jsonb,
  structured_reasons JSONB NOT NULL DEFAULT '{}'::jsonb,
  shown_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  opened_at TIMESTAMPTZ,
  want_to_watch_at TIMESTAMPTZ,
  watched_at TIMESTAMPTZ,
  watched_rating INTEGER CHECK (watched_rating IS NULL OR watched_rating BETWEEN 1 AND 10),
  rejected_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_recommendation_events_user_shown
  ON recommendation_events(user_id, shown_at DESC);
CREATE INDEX IF NOT EXISTS idx_recommendation_events_user_media
  ON recommendation_events(user_id, tmdb_id, media_type, shown_at DESC);
CREATE INDEX IF NOT EXISTS idx_recommendation_events_request
  ON recommendation_events(user_id, request_key, shown_at DESC);

CREATE TABLE IF NOT EXISTS recommendation_feedback (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
  recommendation_id BIGINT REFERENCES recommendation_events(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('want_to_watch', 'watched', 'not_interested', 'hide', 'open')),
  reason TEXT CHECK (reason IS NULL OR reason IN (
    'too_old', 'too_new', 'disliked_genre', 'disliked_actor',
    'disliked_director', 'unknown', 'already_seen', 'not_now', 'other'
  )),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_recommendation_feedback_user_created
  ON recommendation_feedback(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recommendation_feedback_user_media
  ON recommendation_feedback(user_id, tmdb_id, media_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recommendation_feedback_negative
  ON recommendation_feedback(user_id, reason, created_at DESC)
  WHERE action IN ('not_interested', 'hide');

CREATE TABLE IF NOT EXISTS taste_profile_cache (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  profile JSONB NOT NULL,
  ai_summary TEXT,
  source_updated_at TIMESTAMPTZ,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS score_components JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS structured_reasons JSONB NOT NULL DEFAULT '{}'::jsonb;

