-- IMDb is an enrichment source. TMDB/media_metadata remains the canonical
-- KinoLike title entity and user_lists remains the only user library.

ALTER TABLE media_metadata ADD COLUMN IF NOT EXISTS imdb_id TEXT;
ALTER TABLE media_metadata ADD COLUMN IF NOT EXISTS imdb_rating REAL;
ALTER TABLE media_metadata ADD COLUMN IF NOT EXISTS imdb_votes INTEGER;
ALTER TABLE media_metadata ADD COLUMN IF NOT EXISTS imdb_updated_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_media_metadata_imdb_id
  ON media_metadata(imdb_id)
  WHERE imdb_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_media_metadata_tmdb_id ON media_metadata(tmdb_id);
CREATE INDEX IF NOT EXISTS idx_media_metadata_imdb_rating
  ON media_metadata(imdb_rating DESC NULLS LAST, imdb_votes DESC NULLS LAST);

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
  started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  source_changed BOOLEAN NOT NULL DEFAULT FALSE,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_imdb_import_runs_started
  ON imdb_import_runs(started_at DESC);

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
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Compact auxiliary title index. It deliberately contains no posters,
-- descriptions or localized title entity: those continue to come from TMDB.
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

CREATE INDEX IF NOT EXISTS idx_imdb_titles_type_year
  ON imdb_titles(title_type, start_year DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_imdb_titles_rating
  ON imdb_titles(imdb_rating DESC NULLS LAST, imdb_votes DESC NULLS LAST);

-- This table is both the bridge for KinoLike people and the local nconst index
-- needed to answer filmography requests without rescanning title.principals.
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

CREATE INDEX IF NOT EXISTS idx_person_credits_imdb_person
  ON person_credits(imdb_person_id, imdb_title_id);
CREATE INDEX IF NOT EXISTS idx_person_credits_person
  ON person_credits(person_id, imdb_title_id);
CREATE INDEX IF NOT EXISTS idx_person_credits_title ON person_credits(title_id);
CREATE INDEX IF NOT EXISTS idx_person_credits_imdb_title ON person_credits(imdb_title_id);

-- Reusable import staging. UNLOGGED avoids WAL amplification; the importer
-- owns it under a PostgreSQL advisory lock and never serves it to the app.
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
CREATE INDEX IF NOT EXISTS idx_imdb_credit_staging_person
  ON imdb_credit_staging(imdb_person_id);

CREATE UNLOGGED TABLE IF NOT EXISTS imdb_name_staging (
  imdb_person_id TEXT PRIMARY KEY,
  primary_name TEXT NOT NULL,
  birth_year INTEGER,
  death_year INTEGER,
  primary_professions TEXT,
  known_for_titles TEXT
);
