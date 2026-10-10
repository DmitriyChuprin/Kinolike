-- Daily IMDb ratings snapshot. This is deliberately separate from imdb_titles:
-- imdb_titles supports filmography, while this compact table can be refreshed
-- from title.ratings.tsv.gz without downloading the other large datasets.

CREATE TABLE IF NOT EXISTS imdb_ratings (
  imdb_id TEXT PRIMARY KEY CHECK (imdb_id ~ '^tt[0-9]+$'),
  rating REAL NOT NULL CHECK (rating >= 0 AND rating <= 10),
  votes INTEGER NOT NULL CHECK (votes >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_imdb_ratings_rank
  ON imdb_ratings(rating DESC, votes DESC);
CREATE INDEX IF NOT EXISTS idx_imdb_ratings_votes
  ON imdb_ratings(votes DESC);

CREATE UNLOGGED TABLE IF NOT EXISTS imdb_rating_staging (
  imdb_id TEXT PRIMARY KEY,
  rating REAL NOT NULL,
  votes INTEGER NOT NULL
);

ALTER TABLE imdb_import_runs
  ADD COLUMN IF NOT EXISTS import_type TEXT NOT NULL DEFAULT 'full';

ALTER TABLE imdb_dataset_files
  ADD COLUMN IF NOT EXISTS ratings_imported_at TIMESTAMPTZ;

