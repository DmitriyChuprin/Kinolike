const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

// Общая статистика
router.get('/overview', async (req, res) => {
  try {
    const userId = req.user.id;

    // Количество по статусам
    const { rows: statusCounts } = await db.query(
      'SELECT status, COUNT(*) as count FROM user_lists WHERE user_id = $1 GROUP BY status',
      [userId]
    );

    const counts = {};
    for (const row of statusCounts) {
      counts[row.status] = parseInt(row.count);
    }

    // Общее количество
    const total = Object.values(counts).reduce((sum, c) => sum + c, 0);

    // Средняя оценка
    const { rows: avgRows } = await db.query(
      'SELECT AVG(rating) as avg FROM user_lists WHERE user_id = $1 AND rating IS NOT NULL',
      [userId]
    );
    const avgRating = avgRows[0].avg ? Math.round(parseFloat(avgRows[0].avg) * 10) / 10 : 0;

    // Распределение оценок
    const { rows: topRated } = await db.query(
      `SELECT rating, COUNT(*) as count 
       FROM user_lists WHERE user_id = $1 AND rating IS NOT NULL 
       GROUP BY rating ORDER BY rating DESC`,
      [userId]
    );

    res.json({
      total,
      counts,
      avgRating,
      ratingDistribution: topRated,
    });
  } catch (err) {
    console.error('Ошибка статистики:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

function aggregate(items, year) {
  const filtered = year ? items.filter(item => Number(String(item.watched_at || item.updated_at || '').slice(0, 4)) === Number(year)) : items;
  const counts = { movies: 0, tv: 0 }; const genres = {}; const directors = {}; const actors = {}; const countries = {}; const decades = {}; const months = {};
  const ratings = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i + 1, 0]));
  let minutes = 0; let ratingSum = 0; let ratingCount = 0;
  for (const item of filtered) {
    const data = item.details || {}; item.media_type === 'tv' ? counts.tv++ : counts.movies++;
    minutes += item.media_type === 'movie' ? Number(data.runtime || 0) : Number(data.episode_run_time?.[0] || 45) * Number(data.number_of_episodes || 1);
    if (item.rating) { ratings[item.rating]++; ratingSum += Number(item.rating); ratingCount++; }
    const add = (target, name) => { if (name) target[name] = (target[name] || 0) + 1; };
    for (const genre of data.genres || []) add(genres, genre.name || genre);
    for (const person of data.credits?.crew || []) if (person.job === 'Director') add(directors, person.name);
    for (const person of (data.credits?.cast || []).slice(0, 10)) add(actors, person.name);
    for (const country of data.production_countries || []) add(countries, country.name);
    const releaseYear = Number(String(data.release_date || data.first_air_date || '').slice(0, 4)); if (releaseYear) add(decades, `${Math.floor(releaseYear / 10) * 10}`);
    const month = String(item.watched_at || item.updated_at || '').slice(0, 7); if (month) add(months, month);
  }
  const rank = object => Object.entries(object).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count }));
  const rated = filtered.filter(item => item.rating).sort((a, b) => b.rating - a.rating);
  return { total: filtered.length, ...counts, estimatedHours: Math.round(minutes / 6) / 10, averageRating: ratingCount ? Math.round(ratingSum / ratingCount * 10) / 10 : 0,
    ratingDistribution: ratings, genres: rank(genres), directors: rank(directors), actors: rank(actors), countries: rank(countries), decades: rank(decades), monthly: rank(months),
    highestRated: rated.slice(0, 5).map(item => ({ tmdb_id: item.tmdb_id, media_type: item.media_type, title: item.details?.title || item.details?.name, rating: item.rating, poster_path: item.details?.poster_path })),
    lowestRated: rated.slice(-5).reverse().map(item => ({ tmdb_id: item.tmdb_id, media_type: item.media_type, title: item.details?.title || item.details?.name, rating: item.rating, poster_path: item.details?.poster_path })) };
}

router.get('/extended', async (req, res) => {
  try {
    const ListItemModel = require('../models/listItem');
    const items = await ListItemModel.findAllWithMetadata(req.user.id, { status: 'watched' });
    const data = aggregate(items);
    const conversion = await db.query(`SELECT COUNT(*) FILTER (WHERE watched_at IS NOT NULL)::int watched, COUNT(*)::int shown FROM recommendation_events WHERE user_id=$1`, [req.user.id]);
    const row = conversion.rows[0] || { watched: 0, shown: 0 };
    data.recommendationConversion = row.shown ? Math.round(row.watched / row.shown * 1000) / 10 : 0;
    res.json(data);
  } catch (error) { console.error('[Extended stats]', error); res.status(500).json({ error: 'Не удалось загрузить статистику' }); }
});

router.get('/wrapped/:year', async (req, res) => {
  const year = Number(req.params.year);
  if (!Number.isInteger(year) || year < 1900 || year > 2200) return res.status(400).json({ error: 'Некорректный год' });
  try {
    const ListItemModel = require('../models/listItem');
    const data = aggregate(await ListItemModel.findAllWithMetadata(req.user.id, { status: 'watched' }), year);
    res.json({ year, ...data, favoriteGenre: data.genres[0] || null, favoriteDirector: data.directors[0] || null,
      favoriteActor: data.actors[0] || null, mostActiveMonth: data.monthly[0] || null,
      movieOfYear: data.highestRated.find(item => item.media_type === 'movie') || null,
      seriesOfYear: data.highestRated.find(item => item.media_type === 'tv') || null });
  } catch (error) { res.status(500).json({ error: 'Не удалось собрать киногод' }); }
});

module.exports = router;
