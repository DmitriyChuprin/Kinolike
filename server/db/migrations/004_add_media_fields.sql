-- Нормализованные поля для media_metadata
ALTER TABLE media_metadata ADD COLUMN IF NOT EXISTS release_year INTEGER;
ALTER TABLE media_metadata ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE media_metadata ADD COLUMN IF NOT EXISTS poster_path TEXT;
ALTER TABLE media_metadata ADD COLUMN IF NOT EXISTS overview TEXT;

-- Жанры (справочник)
CREATE TABLE IF NOT EXISTS genres (
  id INTEGER PRIMARY KEY,  -- TMDB genre ID
  name TEXT NOT NULL UNIQUE
);

-- Связь фильм/сериал ↔ жанры (M:N)
CREATE TABLE IF NOT EXISTS media_genres (
  media_metadata_id INTEGER NOT NULL REFERENCES media_metadata(id) ON DELETE CASCADE,
  genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
  PRIMARY KEY (media_metadata_id, genre_id)
);

-- Режиссёры
CREATE TABLE IF NOT EXISTS media_directors (
  id SERIAL PRIMARY KEY,
  media_metadata_id INTEGER NOT NULL REFERENCES media_metadata(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL,  -- TMDB person ID
  name TEXT NOT NULL
);

-- Актёры
CREATE TABLE IF NOT EXISTS media_actors (
  id SERIAL PRIMARY KEY,
  media_metadata_id INTEGER NOT NULL REFERENCES media_metadata(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL,  -- TMDB person ID
  name TEXT NOT NULL,
  character_name TEXT,
  sort_order INTEGER DEFAULT 0
);

-- Индексы
CREATE INDEX IF NOT EXISTS idx_media_genres_metadata ON media_genres(media_metadata_id);
CREATE INDEX IF NOT EXISTS idx_media_directors_metadata ON media_directors(media_metadata_id);
CREATE INDEX IF NOT EXISTS idx_media_actors_metadata ON media_actors(media_metadata_id);
CREATE INDEX IF NOT EXISTS idx_media_metadata_year ON media_metadata(release_year);
CREATE INDEX IF NOT EXISTS idx_media_metadata_title ON media_metadata(title);
