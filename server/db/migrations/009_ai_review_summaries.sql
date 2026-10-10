-- Постоянный кэш AI-сводок отзывов, переживает перезапуск приложения.
CREATE TABLE IF NOT EXISTS ai_review_summaries (
  id SERIAL PRIMARY KEY,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'tv')),
  summary TEXT NOT NULL,
  source_count INTEGER NOT NULL DEFAULT 0,
  source_language TEXT,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tmdb_id, media_type)
);

CREATE INDEX IF NOT EXISTS idx_ai_review_summaries_lookup
  ON ai_review_summaries(tmdb_id, media_type);
