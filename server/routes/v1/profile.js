const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const tasteProfile = require('../../services/tasteProfile');
const { ApiError, asyncRoute } = require('../../api/errors');

// GET /api/v1/profile/preferences — return aggregated taste profile
router.get('/preferences', asyncRoute(async (req, res) => {
  const profile = await tasteProfile.getTasteProfile(req.user.id);

  // Fetch high-rated movies and TV separately
  const { rows } = await db.query(`
    SELECT ul.rating, ul.tmdb_id, ul.media_type, mm.id, mm.title, mm.release_year
    FROM user_lists ul
    LEFT JOIN media_metadata mm ON mm.tmdb_id = ul.tmdb_id AND mm.media_type = ul.media_type
    WHERE ul.user_id = $1 AND ul.status = 'watched' AND ul.rating >= 8
    ORDER BY ul.rating DESC, ul.watched_at DESC NULLS LAST
    LIMIT 40
  `, [req.user.id]);

  const compact = row => ({
    id: row.id == null ? null : Number(row.id),
    tmdb_id: row.tmdb_id,
    title: row.title,
    year: row.release_year,
    rating: Number(row.rating),
  });

  const decades = profile.favoriteDecades || [];
  const decadeValues = decades.map(item => Number(item.name)).filter(Number.isFinite);

  const result = {
    favorite_genres: profile.favoriteGenres || [],
    disliked_genres: profile.dislikedGenres || [],
    preferred_year_range: decadeValues.length
      ? { from: Math.min(...decadeValues), to: Math.max(...decadeValues) + 9 }
      : {},
    favorite_actors: profile.favoriteActors || [],
    favorite_directors: profile.favoriteDirectors || [],
    high_rated_movies: rows.filter(row => row.media_type === 'movie').map(compact),
    high_rated_tv: rows.filter(row => row.media_type === 'tv').map(compact),
  };

  res.json(result);
}));

module.exports = router;
