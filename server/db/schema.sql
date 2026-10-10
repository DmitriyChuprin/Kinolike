-- Пользователи
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_url TEXT DEFAULT NULL,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  jellyfin_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  preferred_streaming_source TEXT NOT NULL DEFAULT 'phantom' CHECK (preferred_streaming_source IN ('phantom', 'videohub')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Списки фильмов/сериалов
CREATE TABLE IF NOT EXISTS user_lists (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'tv')),
  status TEXT NOT NULL DEFAULT 'want_to_watch'
    CHECK(status IN ('want_to_watch','watched','not_interested')),
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
  matched_movies JSONB NOT NULL DEFAULT '[]'::jsonb,
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

-- Cached, normalized intro/credits markers. Duration is part of the primary
-- key because different releases of the same title may have shifted offsets.
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
  PRIMARY KEY (tmdb_id, media_type, season, episode, duration_seconds)
);
CREATE INDEX IF NOT EXISTS idx_streaming_segments_lookup ON streaming_segments (tmdb_id, media_type, season, episode, updated_at DESC);

-- Метаданные фильмов/сериалов (хранятся навсегда)
-- Отдельная таблица чтобы приложение всегда сначала смотрело в БД
CREATE TABLE IF NOT EXISTS media_metadata (
  id SERIAL PRIMARY KEY,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'tv')),
  data JSONB NOT NULL,
  locale TEXT,
  fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  release_year INTEGER,
  title TEXT,
  poster_path TEXT,
  overview TEXT,
  UNIQUE(tmdb_id, media_type)
);

CREATE INDEX IF NOT EXISTS idx_media_metadata_lookup ON media_metadata(tmdb_id, media_type);
CREATE INDEX IF NOT EXISTS idx_media_metadata_year ON media_metadata(release_year);
CREATE INDEX IF NOT EXISTS idx_media_metadata_title ON media_metadata(title);

-- Постоянный кэш AI-сводок отзывов
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
CREATE INDEX IF NOT EXISTS idx_ai_review_summaries_lookup ON ai_review_summaries(tmdb_id, media_type);

-- Жанры (справочник)
CREATE TABLE IF NOT EXISTS genres (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

-- Связь фильм/сериал ↔ жанры (M:N)
CREATE TABLE IF NOT EXISTS media_genres (
  media_metadata_id INTEGER NOT NULL REFERENCES media_metadata(id) ON DELETE CASCADE,
  genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
  PRIMARY KEY (media_metadata_id, genre_id)
);
CREATE INDEX IF NOT EXISTS idx_media_genres_metadata ON media_genres(media_metadata_id);

-- Режиссёры
CREATE TABLE IF NOT EXISTS media_directors (
  id SERIAL PRIMARY KEY,
  media_metadata_id INTEGER NOT NULL REFERENCES media_metadata(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL,
  name TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_directors_metadata ON media_directors(media_metadata_id);

-- Актёры
CREATE TABLE IF NOT EXISTS media_actors (
  id SERIAL PRIMARY KEY,
  media_metadata_id INTEGER NOT NULL REFERENCES media_metadata(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  character_name TEXT,
  sort_order INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_media_actors_metadata ON media_actors(media_metadata_id);

-- IMDb enrichment (TMDB remains the canonical catalog source)
ALTER TABLE media_metadata ADD COLUMN IF NOT EXISTS imdb_id TEXT;
ALTER TABLE media_metadata ADD COLUMN IF NOT EXISTS imdb_rating REAL;
ALTER TABLE media_metadata ADD COLUMN IF NOT EXISTS imdb_votes INTEGER;
ALTER TABLE media_metadata ADD COLUMN IF NOT EXISTS imdb_updated_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS uq_media_metadata_imdb_id ON media_metadata(imdb_id) WHERE imdb_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_media_metadata_tmdb_id ON media_metadata(tmdb_id);
CREATE INDEX IF NOT EXISTS idx_media_metadata_imdb_rating ON media_metadata(imdb_rating DESC NULLS LAST, imdb_votes DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS people (
  id BIGSERIAL PRIMARY KEY,
  tmdb_id INTEGER NOT NULL UNIQUE,
  imdb_id TEXT UNIQUE,
  name TEXT NOT NULL,
  profile_path TEXT,
  biography TEXT,
  birthday DATE,
  deathday DATE,
  place_of_birth TEXT,
  tmdb_popularity REAL,
  tmdb_known_for JSONB NOT NULL DEFAULT '[]'::jsonb,
  imdb_primary_name TEXT,
  imdb_birth_year INTEGER,
  imdb_death_year INTEGER,
  imdb_primary_professions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  imdb_known_for_titles TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  tmdb_updated_at TIMESTAMPTZ,
  imdb_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_people_tmdb_id ON people(tmdb_id);
CREATE INDEX IF NOT EXISTS idx_people_imdb_id ON people(imdb_id);

CREATE TABLE IF NOT EXISTS imdb_import_runs (
  id BIGSERIAL PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  import_type TEXT NOT NULL DEFAULT 'full',
  started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  source_changed BOOLEAN NOT NULL DEFAULT FALSE,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_imdb_import_runs_started ON imdb_import_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS imdb_dataset_files (
  dataset_name TEXT PRIMARY KEY,
  source_url TEXT NOT NULL,
  local_path TEXT NOT NULL,
  etag TEXT,
  last_modified TEXT,
  sha256 TEXT,
  byte_size BIGINT,
  downloaded_at TIMESTAMPTZ,
  imported_at TIMESTAMPTZ,
  ratings_imported_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS imdb_titles (
  imdb_id TEXT PRIMARY KEY,
  title_type TEXT NOT NULL,
  primary_title TEXT NOT NULL,
  original_title TEXT,
  is_adult BOOLEAN NOT NULL DEFAULT FALSE,
  start_year INTEGER,
  end_year INTEGER,
  runtime_minutes INTEGER,
  genres TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  imdb_rating REAL,
  imdb_votes INTEGER,
  imdb_updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  import_run_id BIGINT
);
CREATE INDEX IF NOT EXISTS idx_imdb_titles_type_year ON imdb_titles(title_type, start_year DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_imdb_titles_rating ON imdb_titles(imdb_rating DESC NULLS LAST, imdb_votes DESC NULLS LAST);

-- Compact canonical snapshot from title.ratings.tsv.gz. Keeping it independent
-- from imdb_titles makes the frequent ratings refresh cheap and self-contained.
CREATE TABLE IF NOT EXISTS imdb_ratings (
  imdb_id TEXT PRIMARY KEY CHECK (imdb_id ~ '^tt[0-9]+$'),
  rating REAL NOT NULL CHECK (rating >= 0 AND rating <= 10),
  votes INTEGER NOT NULL CHECK (votes >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_imdb_ratings_rank ON imdb_ratings(rating DESC, votes DESC);
CREATE INDEX IF NOT EXISTS idx_imdb_ratings_votes ON imdb_ratings(votes DESC);

CREATE UNLOGGED TABLE IF NOT EXISTS imdb_rating_staging (
  imdb_id TEXT PRIMARY KEY,
  rating REAL NOT NULL,
  votes INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS person_credits (
  id BIGSERIAL PRIMARY KEY,
  person_id BIGINT REFERENCES people(id) ON DELETE CASCADE,
  imdb_person_id TEXT NOT NULL,
  title_id INTEGER REFERENCES media_metadata(id) ON DELETE SET NULL,
  imdb_title_id TEXT NOT NULL REFERENCES imdb_titles(imdb_id) ON DELETE CASCADE,
  ordering INTEGER NOT NULL,
  category TEXT NOT NULL,
  characters JSONB,
  job TEXT,
  import_run_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(imdb_person_id, imdb_title_id, ordering)
);
CREATE INDEX IF NOT EXISTS idx_person_credits_imdb_person ON person_credits(imdb_person_id, imdb_title_id);
CREATE INDEX IF NOT EXISTS idx_person_credits_person ON person_credits(person_id, imdb_title_id);
CREATE INDEX IF NOT EXISTS idx_person_credits_title ON person_credits(title_id);
CREATE INDEX IF NOT EXISTS idx_person_credits_imdb_title ON person_credits(imdb_title_id);

CREATE UNLOGGED TABLE IF NOT EXISTS imdb_title_staging (
  imdb_id TEXT PRIMARY KEY,
  title_type TEXT NOT NULL,
  primary_title TEXT NOT NULL,
  original_title TEXT,
  is_adult BOOLEAN NOT NULL,
  start_year INTEGER,
  end_year INTEGER,
  runtime_minutes INTEGER,
  genres TEXT,
  imdb_rating REAL,
  imdb_votes INTEGER
);
CREATE UNLOGGED TABLE IF NOT EXISTS imdb_credit_staging (
  imdb_person_id TEXT NOT NULL,
  imdb_title_id TEXT NOT NULL,
  ordering INTEGER NOT NULL,
  category TEXT NOT NULL,
  characters TEXT,
  job TEXT,
  PRIMARY KEY(imdb_person_id, imdb_title_id, ordering)
);
CREATE INDEX IF NOT EXISTS idx_imdb_credit_staging_person ON imdb_credit_staging(imdb_person_id);
CREATE UNLOGGED TABLE IF NOT EXISTS imdb_name_staging (
  imdb_person_id TEXT PRIMARY KEY,
  primary_name TEXT NOT NULL,
  birth_year INTEGER,
  death_year INTEGER,
  primary_professions TEXT,
  known_for_titles TEXT
);
