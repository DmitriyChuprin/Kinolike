-- Пользователи
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_url TEXT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Списки фильмов/сериалов
CREATE TABLE IF NOT EXISTS user_lists (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'tv')),
  status TEXT NOT NULL DEFAULT 'want_to_watch'
    CHECK(status IN ('want_to_watch','watching','watched','on_hold')),
  rating INTEGER CHECK(rating IS NULL OR (rating >= 1 AND rating <= 10)),
  notes TEXT DEFAULT NULL,
  added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  watched_at TIMESTAMP DEFAULT NULL,
  UNIQUE(user_id, tmdb_id, media_type)
);

-- Кэш рекомендаций
CREATE TABLE IF NOT EXISTS recommendations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'tv')),
  reason TEXT,
  score REAL,
  generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP,
  UNIQUE(user_id, tmdb_id, media_type)
);

-- Ссылки на стриминг (TorrServer + Jellyfin)
CREATE TABLE IF NOT EXISTS streaming_links (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'tv')),
  title TEXT NOT NULL,
  poster TEXT DEFAULT '',
  hash TEXT NOT NULL,
  stream_url TEXT NOT NULL,
  jellyfin_url TEXT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, tmdb_id, media_type)
);

-- Кэш TMDB запросов
-- Хранит ответы API чтобы не делать повторные запросы
CREATE TABLE IF NOT EXISTS tmdb_cache (
  id SERIAL PRIMARY KEY,
  endpoint TEXT NOT NULL,
  params_hash TEXT NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  UNIQUE(endpoint, params_hash)
);

-- Индексы для быстрого поиска в кэше
CREATE INDEX IF NOT EXISTS idx_tmdb_cache_lookup ON tmdb_cache(endpoint, params_hash);
CREATE INDEX IF NOT EXISTS idx_tmdb_cache_expires ON tmdb_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_user_lists_user ON user_lists(user_id);
CREATE INDEX IF NOT EXISTS idx_user_lists_status ON user_lists(user_id, status);

-- Метаданные фильмов/сериалов (хранятся навсегда)
-- Отдельная таблица чтобы приложение всегда сначала смотрело в БД
CREATE TABLE IF NOT EXISTS media_metadata (
  id SERIAL PRIMARY KEY,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'tv')),
  data JSONB NOT NULL,
  fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tmdb_id, media_type)
);

CREATE INDEX IF NOT EXISTS idx_media_metadata_lookup ON media_metadata(tmdb_id, media_type);
