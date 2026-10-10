-- The AI search candidate query filters the large TMDB JSON document by the
-- default quality floor before ranking. Without this index PostgreSQL scans
-- every media_metadata row on each text recommendation request.
CREATE INDEX IF NOT EXISTS idx_media_metadata_recommendation_quality
  ON media_metadata (((COALESCE(data->>'vote_average', '0'))::double precision) DESC, id)
  WHERE ((COALESCE(data->>'vote_count', '0'))::double precision >= 300)
    AND ((COALESCE(data->>'vote_average', '0'))::double precision >= 6)
    AND (((COALESCE(data->>'popularity', '0'))::double precision <= 0)
      OR ((COALESCE(data->>'popularity', '0'))::double precision >= 5));

-- Used by the required/excluded genre EXISTS clauses in the same query.
CREATE INDEX IF NOT EXISTS idx_media_genres_genre_metadata
  ON media_genres (genre_id, media_metadata_id);
