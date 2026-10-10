const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const { scheduleGeneration } = require('../services/backgroundRecommendations');
const tmdbService = require('../services/tmdb');
const tasteProfile = require('../services/tasteProfile');

router.use(authMiddleware);

async function ensureMetadata(tmdbId, mediaType) {
  try {
    return await tmdbService.ensureLocalizedMetadata(tmdbId, mediaType);
  } catch (err) {
    console.error('[Watched] Обновление русских метаданных не удалось:', tmdbId, mediaType, err.message);
    return null;
  }
}

async function loadWatchedItems(userId, filters) {
  const { sort, year, min_rating, max_rating, media_type, compact } = filters;
  const detailsExpression = compact === '1' || compact === 'true'
    ? `jsonb_strip_nulls(jsonb_build_object(
         'id', mm.tmdb_id,
         'title', mm.data->>'title',
         'name', mm.data->>'name',
         'release_date', mm.data->>'release_date',
         'first_air_date', mm.data->>'first_air_date',
         'poster_path', mm.poster_path,
         'vote_average', mm.data->'vote_average',
         'vote_count', mm.data->'vote_count'
       ))`
    : `jsonb_strip_nulls(COALESCE(mm.data, '{}'::jsonb) || jsonb_build_object(
         'imdb_id', mm.imdb_id,
         'imdb_rating', mm.imdb_rating,
         'imdb_votes', mm.imdb_votes
       ))`;
  let query = `
    SELECT ul.*,
           ${detailsExpression} as details,
           mm.imdb_id, mm.imdb_rating, mm.imdb_votes, mm.locale
    FROM user_lists ul
    LEFT JOIN media_metadata mm
      ON mm.tmdb_id = ul.tmdb_id AND mm.media_type = ul.media_type
    WHERE ul.user_id = $1 AND ul.status = $2
  `;
  const params = [userId, 'watched'];
  let idx = 3;

  if (media_type) {
    query += ` AND ul.media_type = $${idx++}`;
    params.push(media_type);
  }
  if (min_rating) {
    query += ` AND ul.rating >= $${idx++}`;
    params.push(parseInt(min_rating));
  }
  if (max_rating) {
    query += ` AND ul.rating <= $${idx++}`;
    params.push(parseInt(max_rating));
  }
  if (year) {
    query += ` AND TO_CHAR(ul.watched_at, 'YYYY') = $${idx++}`;
    params.push(year);
  }

  const sortMap = {
    'rating': 'ul.rating DESC',
    'rating_asc': 'ul.rating ASC',
    'added_at': 'ul.added_at DESC',
    'watched_at': 'ul.watched_at DESC',
    'watched_at_asc': 'ul.watched_at ASC',
    'year': 'ul.watched_at DESC',
  };
  query += ` ORDER BY ${sortMap[sort] || 'ul.watched_at DESC'}`;

  const { rows } = await db.query(query, params);
  return rows;
}

// Получить просмотренные с фильтрами
router.get('/', async (req, res) => {
  try {
    const rows = await loadWatchedItems(req.user.id, req.query);
    const staleItems = rows.filter((item) => item.locale !== 'ru-RU');
    if (staleItems.length > 0) {
      // Не блокируем страницу внешними запросами: кэш заполнится в фоне.
      void Promise.allSettled(staleItems.map((item) => ensureMetadata(item.tmdb_id, item.media_type)));
    }

    res.json({ items: rows });
  } catch (err) {
    console.error('Ошибка получения просмотренных:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Оценить просмотренное
router.put('/:id/rate', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM user_lists WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    const item = rows[0];

    if (!item) {
      return res.status(404).json({ error: 'Запись не найдена' });
    }

    const { rating, notes, watched_at } = req.body;

    await db.query(
      `UPDATE user_lists 
       SET rating = $1, notes = $2, watched_at = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [rating || null, notes || null, watched_at || item.watched_at, req.params.id]
    );

    const { rows: updated } = await db.query('SELECT * FROM user_lists WHERE id = $1', [req.params.id]);

    // Запускаем фоновую генерацию рекомендаций
    scheduleGeneration(req.user.id);
    await tasteProfile.invalidate(req.user.id);
    await db.query(`UPDATE recommendation_events SET watched_at=COALESCE(watched_at,NOW()), watched_rating=$1
      WHERE user_id=$2 AND tmdb_id=$3 AND media_type=$4`, [rating || null, req.user.id, item.tmdb_id, item.media_type]);

    res.json({ item: updated[0] });
  } catch (err) {
    console.error('Ошибка оценки:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Статистика просмотренных
router.get('/stats', async (req, res) => {
  try {
    const userId = req.user.id;

    const { rows: totalRows } = await db.query(
      'SELECT COUNT(*) as count FROM user_lists WHERE user_id = $1 AND status = $2',
      [userId, 'watched']
    );
    const total = parseInt(totalRows[0].count);

    const { rows: moviesRows } = await db.query(
      'SELECT COUNT(*) as count FROM user_lists WHERE user_id = $1 AND status = $2 AND media_type = $3',
      [userId, 'watched', 'movie']
    );
    const movies = parseInt(moviesRows[0].count);

    const { rows: tvRows } = await db.query(
      'SELECT COUNT(*) as count FROM user_lists WHERE user_id = $1 AND status = $2 AND media_type = $3',
      [userId, 'watched', 'tv']
    );
    const tv = parseInt(tvRows[0].count);

    const { rows: avgRows } = await db.query(
      'SELECT AVG(rating) as avg FROM user_lists WHERE user_id = $1 AND status = $2 AND rating IS NOT NULL',
      [userId, 'watched']
    );
    const avgRating = avgRows[0].avg ? Math.round(parseFloat(avgRows[0].avg) * 10) / 10 : 0;

    const { rows: ratingDistribution } = await db.query(
      'SELECT rating, COUNT(*) as count FROM user_lists WHERE user_id = $1 AND status = $2 AND rating IS NOT NULL GROUP BY rating ORDER BY rating',
      [userId, 'watched']
    );

    res.json({
      total,
      movies,
      tv,
      avgRating,
      ratingDistribution,
    });
  } catch (err) {
    console.error('Ошибка статистики:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
