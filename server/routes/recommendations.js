const express = require('express');
const router = express.Router();
const ListItemModel = require('../models/listItem');
const RecommendationModel = require('../models/recommendation');
const tmdbService = require('../services/tmdb');
const { generateForUser } = require('../services/backgroundRecommendations');
const { build_user_profile, movie_data, calculate_movie_score, candidate_passes_thresholds, reason_for } = require('../services/personalRecommendations');
const config = require('../services/recommendationConfig');
const { authMiddleware } = require('../middleware/auth');
const db = require('../db/database');
const history = require('../services/recommendationHistory');
const tasteProfile = require('../services/tasteProfile');

router.use(authMiddleware);

router.post('/feedback', async (req, res) => {
  try {
    const item = await history.feedback(req.user.id, req.body || {});
    const action = req.body?.action;
    if (['want_to_watch', 'watched', 'not_interested'].includes(action)) {
      const existing = await ListItemModel.findByTmdb(req.user.id, Number(req.body.tmdb_id), req.body.media_type);
      if (existing) await ListItemModel.update(existing.id, { status: action, watched_at: action === 'watched' ? new Date().toISOString() : undefined });
      else await ListItemModel.create(req.user.id, { tmdb_id: Number(req.body.tmdb_id), media_type: req.body.media_type, status: action });
    }
    if (action !== 'open') await Promise.all([RecommendationModel.clearCache(req.user.id), tasteProfile.invalidate(req.user.id)]);
    res.status(201).json({ feedback: item });
  } catch (error) { res.status(400).json({ error: error.message || 'Не удалось сохранить реакцию' }); }
});

function recommendationsUnavailable(res) {
  return res.status(503).json({
    error: 'recommendations_unavailable',
    message: 'Рекомендации временно недоступны. Попробуйте позже.',
  });
}

function recommendationsTimeout(res) {
  return res.status(504).json({
    error: 'recommendations_timeout',
    message: 'Не удалось получить рекомендации вовремя',
  });
}

function isTimeoutError(error) {
  return /timeout|timed out|abort/i.test(`${error?.name || ''} ${error?.message || ''}`);
}

router.post('/ask', async (req, res) => {
  try {
    const query = String(req.body?.query || '').trim();
    if (!query || query.length > 500) return res.status(400).json({ error: 'Введите запрос до 500 символов' });
    const { searchWithAI } = require('../services/aiSearch');
    const result = await searchWithAI(req.user.id, query, { limit: 5 });
    await history.recordImpressions(req.user.id, result.recommendations, { algorithm: 'today_v2', query });
    res.json(result);
  } catch (error) { console.error('[Today recommendations]', error); return isTimeoutError(error) ? recommendationsTimeout(res) : recommendationsUnavailable(res); }
});

router.post('/more', async (req, res) => {
  try {
    const query = String(req.body?.query || '').trim();
    if (!query || query.length > 500) return res.status(400).json({ error: 'Введите исходный запрос' });
    const shown = new Set((Array.isArray(req.body?.exclude) ? req.body.exclude : []).slice(0, 100).map(item => `${item.media_type}:${Number(item.tmdb_id)}`));
    const { searchWithAI } = require('../services/aiSearch');
    const result = await searchWithAI(req.user.id, query, { limit: 5, exclude: shown });
    await history.recordImpressions(req.user.id, result.recommendations, { algorithm: 'today_v2_more', query });
    res.json(result);
  } catch (error) { console.error('[More recommendations]', error); return isTimeoutError(error) ? recommendationsTimeout(res) : recommendationsUnavailable(res); }
});

router.get('/history', async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const { rows } = await db.query(`SELECT re.*, mm.title, mm.poster_path
      FROM recommendation_events re LEFT JOIN media_metadata mm ON mm.tmdb_id=re.tmdb_id AND mm.media_type=re.media_type
      WHERE re.user_id=$1 ORDER BY re.shown_at DESC LIMIT $2`, [req.user.id, limit]);
    res.json({ items: rows });
  } catch (error) { res.status(500).json({ error: 'Не удалось загрузить историю рекомендаций' }); }
});

router.get('/collections', async (req, res) => {
  try {
    const [cached, want] = await Promise.all([RecommendationModel.getCached(req.user.id), ListItemModel.findAllWithMetadata(req.user.id, { status: 'want_to_watch' })]);
    const normalize = item => ({ tmdb_id: item.tmdb_id, id: item.tmdb_id, media_type: item.media_type, score: Number(item.score) || null,
      reason: item.reason || '', structured_reasons: item.structured_reasons || {}, ...(item.details || {}) });
    const best = cached.map(normalize);
    const collections = [];
    const add = (key, title, items) => { if (items.length >= 3) collections.push({ key, title, items: items.slice(0, 10) }); };
    add('best', 'Лучшее для вас', best);
    add('under-two-hours', 'До 2 часов', best.filter(item => Number(item.runtime) > 0 && Number(item.runtime) <= 120));
    add('new-for-you', 'Новинки для вас', best.filter(item => Number(String(item.release_date || item.first_air_date || '').slice(0, 4)) >= new Date().getUTCFullYear() - 2));
    add('series', 'Сериалы для вас', best.filter(item => item.media_type === 'tv'));
    add('want', 'Из вашего Want to Watch', want.map(item => normalize({ ...item, details: item.details || {} })));
    res.json({ collections: collections.slice(0, 5) });
  } catch (error) { res.status(500).json({ error: 'Не удалось собрать коллекции' }); }
});

// Получить рекомендации
router.get('/', async (req, res) => {
  try {
    const userId = req.user.id;
    const { refresh } = req.query;

    if (refresh === 'true') {
      return await generateAndReturn(userId, res);
    }

    const cached = await RecommendationModel.getCached(userId);
    // Из кэша отдаём только фильмы (сериалы — в жанровых подборках)
    const movieItems = cached.filter(i => i.media_type === 'movie');
    if (movieItems.length > 0) {
      const recommendations = movieItems.map(item => ({ movie_id: item.tmdb_id, tmdb_id: item.tmdb_id, media_type: item.media_type, title: item.details?.title || item.details?.name || `TMDB #${item.tmdb_id}`, score: Number(item.score), reason: item.reason, matched_movies: item.matched_movies || [], structured_reasons: item.structured_reasons || {}, poster_path: item.details?.poster_path || null, overview: item.details?.overview || '', imdb_id: item.imdb_id || null, imdb_rating: item.imdb_rating == null ? null : Number(item.imdb_rating), imdb_votes: item.imdb_votes == null ? null : Number(item.imdb_votes) }));
      await history.recordImpressions(userId, recommendations, { algorithm: 'personal_v2' });
      return res.json({ items: recommendations, recommendations, fromCache: true });
    }

    // Кэш пустой — запускаем генерацию в фоне, возвращаем pending
    const { runningJobs } = require('../services/backgroundRecommendations');
    if (!runningJobs.has(userId)) {
      generateForUser(userId).catch(err => console.error('[Recommendations] background error:', err.message));
    }
    return res.json({ items: [], recommendations: [], pending: true, message: 'Рекомендации рассчитываются...' });
  } catch (err) {
    console.error('Ошибка рекомендаций:', err);
    res.status(500).json({ error: 'Не удалось получить рекомендации' });
  }
});

// Принудительная генерация
router.post('/generate', async (req, res) => {
  try {
    return await generateAndReturn(req.user.id, res);
  } catch (err) {
    console.error('Ошибка генерации:', err);
    res.status(500).json({ error: 'Не удалось сгенерировать рекомендации' });
  }
});

// Кастомный запрос. Этот маршрут оставлен для совместимости со старым
// клиентом, но должен использовать тот же AI-поиск, что и /search.
router.post('/custom', async (req, res) => {
  try {
    const { query } = req.body || {};
    if (typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'Введите запрос для поиска' });
    }
    if (query.length > 500) {
      return res.status(400).json({ error: 'Запрос слишком длинный (максимум 500 символов)' });
    }

    const { searchWithAI } = require('../services/aiSearch');
    const result = await searchWithAI(req.user.id, query.trim());
    return res.json(result);
  } catch (err) {
    console.error('[AI Search] Ошибка кастомного запроса:', err);
    return isTimeoutError(err) ? recommendationsTimeout(res) : recommendationsUnavailable(res);
  }
});

// Подборка по любимому жанру пользователя (агрегация оценок, без AI)
router.get('/favorite-genre', async (req, res) => {
  try {
    const userId = req.user.id;

    const watched = await ListItemModel.findAllWithMetadata(userId, { status: 'watched' });
    const rated = watched.filter(i => i.rating && i.details && Array.isArray(i.details.genres));

    if (rated.length === 0) {
      return res.json({ collection: null });
    }

    // Суммируем оценки по жанрам отдельно для фильмов и сериалов
    // (ID жанров фильмов и сериалов различаются)
    const scores = {};
    for (const item of rated) {
      for (const g of item.details.genres) {
        const key = `${item.media_type}:${g.id}`;
        if (!scores[key]) scores[key] = { sum: 0, count: 0, name: g.name, mediaType: item.media_type, id: g.id };
        scores[key].sum += item.rating;
        scores[key].count += 1;
      }
    }

    // Лучший жанр по средней оценке (минимум 2 оценённых тайтла в жанре)
    let best = null;
    for (const s of Object.values(scores)) {
      if (s.count < 2) continue;
      const avg = s.sum / s.count;
      if (!best || avg > best.avg) best = { ...s, avg };
    }

    if (!best) {
      return res.json({ collection: null });
    }

    // Исключаем просмотренные, «хочу посмотреть» и отмеченные как неинтересные
    const wantToWatch = await ListItemModel.findAll(userId, { status: 'want_to_watch' });
    const excludeIds = new Set([
      ...watched.map(i => i.tmdb_id),
      ...wantToWatch.map(i => i.tmdb_id),
    ]);

    const page = 1 + Math.floor(Math.random() * 3);
    const discover = best.mediaType === 'movie'
      ? tmdbService.discoverMovies
      : tmdbService.discoverTv;
    const data = await discover({
      with_genres: String(best.id),
      sort_by: 'vote_average.desc',
      'vote_count.gte': 100,
      'vote_average.gte': 6,
      page,
    });

    const items = (data.results || [])
      .filter(r => !excludeIds.has(r.id))
      .slice(0, 15)
      .map(r => ({ ...r, media_type: best.mediaType }));

    res.json({
      collection: {
        key: 'favorite',
        title: `Ваш любимый жанр: ${best.name}`,
        media_type: best.mediaType,
        items,
      },
    });
  } catch (err) {
    console.error('Ошибка подборки любимого жанра:', err);
    res.status(500).json({ error: 'Не удалось получить подборку' });
  }
});

// Жанровые подборки (TMDB Discover, без AI) — все жанры TMDB + SU/RU
const GENRE_COLLECTIONS = [
  // ===== Фильмы (все 18 жанров TMDB) =====
  { key: 'm-action',    title: 'Боевики',         mediaType: 'movie', params: { with_genres: '28',    sort_by: 'vote_average.desc', 'vote_count.gte': 300, 'vote_average.gte': 6 } },
  { key: 'm-adventure', title: 'Приключения',     mediaType: 'movie', params: { with_genres: '12',    sort_by: 'vote_average.desc', 'vote_count.gte': 300, 'vote_average.gte': 6 } },
  { key: 'm-animation', title: 'Мультфильмы',     mediaType: 'movie', params: { with_genres: '16',    sort_by: 'vote_average.desc', 'vote_count.gte': 200, 'vote_average.gte': 6 } },
  { key: 'm-comedy',    title: 'Комедии',         mediaType: 'movie', params: { with_genres: '35',    sort_by: 'vote_average.desc', 'vote_count.gte': 300, 'vote_average.gte': 6 } },
  { key: 'm-crime',     title: 'Криминал',        mediaType: 'movie', params: { with_genres: '80',    sort_by: 'vote_average.desc', 'vote_count.gte': 300, 'vote_average.gte': 6 } },
  { key: 'm-doc',       title: 'Документальные',  mediaType: 'movie', params: { with_genres: '99',    sort_by: 'vote_average.desc', 'vote_count.gte': 100, 'vote_average.gte': 6 } },
  { key: 'm-drama',     title: 'Драмы',           mediaType: 'movie', params: { with_genres: '18',    sort_by: 'vote_average.desc', 'vote_count.gte': 300, 'vote_average.gte': 6 } },
  { key: 'm-family',    title: 'Семейные',        mediaType: 'movie', params: { with_genres: '10751', sort_by: 'vote_average.desc', 'vote_count.gte': 200, 'vote_average.gte': 6 } },
  { key: 'm-fantasy',   title: 'Фэнтези',         mediaType: 'movie', params: { with_genres: '14',    sort_by: 'vote_average.desc', 'vote_count.gte': 200, 'vote_average.gte': 6 } },
  { key: 'm-history',   title: 'Исторические',    mediaType: 'movie', params: { with_genres: '36',    sort_by: 'vote_average.desc', 'vote_count.gte': 150, 'vote_average.gte': 6 } },
  { key: 'm-horror',    title: 'Ужасы',           mediaType: 'movie', params: { with_genres: '27',    sort_by: 'vote_average.desc', 'vote_count.gte': 300, 'vote_average.gte': 6 } },
  { key: 'm-music',     title: 'Музыкальные',     mediaType: 'movie', params: { with_genres: '10402', sort_by: 'vote_average.desc', 'vote_count.gte': 100, 'vote_average.gte': 6 } },
  { key: 'm-detective', title: 'Детективы',       mediaType: 'movie', params: { with_genres: '9648',  sort_by: 'vote_average.desc', 'vote_count.gte': 300, 'vote_average.gte': 6 } },
  { key: 'm-romance',   title: 'Мелодрамы',       mediaType: 'movie', params: { with_genres: '10749', sort_by: 'vote_average.desc', 'vote_count.gte': 300, 'vote_average.gte': 6 } },
  { key: 'm-scifi',     title: 'Фантастика',      mediaType: 'movie', params: { with_genres: '878',   sort_by: 'vote_average.desc', 'vote_count.gte': 300, 'vote_average.gte': 6 } },
  { key: 'm-thriller',  title: 'Триллеры',        mediaType: 'movie', params: { with_genres: '53',    sort_by: 'vote_average.desc', 'vote_count.gte': 300, 'vote_average.gte': 6 } },
  { key: 'm-war',       title: 'Военные',         mediaType: 'movie', params: { with_genres: '10752', sort_by: 'vote_average.desc', 'vote_count.gte': 150, 'vote_average.gte': 6 } },
  { key: 'm-western',   title: 'Вестерны',        mediaType: 'movie', params: { with_genres: '37',    sort_by: 'vote_average.desc', 'vote_count.gte': 100, 'vote_average.gte': 6 } },
  { key: 'm-soviet',    title: 'Советское кино',  mediaType: 'movie', params: { with_origin_country: 'SU', sort_by: 'vote_average.desc', 'vote_count.gte': 60, 'vote_average.gte': 6 } },
  { key: 'm-russian',   title: 'Российское кино', mediaType: 'movie', params: { with_origin_country: 'RU', sort_by: 'vote_average.desc', 'vote_count.gte': 40, 'vote_average.gte': 6 } },
  // ===== Сериалы (все 16 жанров TMDB) =====
  { key: 't-action',    title: 'Боевики и приключения', mediaType: 'tv', params: { with_genres: '10759', sort_by: 'vote_average.desc', 'vote_count.gte': 150, 'vote_average.gte': 6 } },
  { key: 't-animation', title: 'Мультсериалы',          mediaType: 'tv', params: { with_genres: '16',    sort_by: 'vote_average.desc', 'vote_count.gte': 100, 'vote_average.gte': 6 } },
  { key: 't-comedy',    title: 'Комедийные сериалы',    mediaType: 'tv', params: { with_genres: '35',    sort_by: 'vote_average.desc', 'vote_count.gte': 150, 'vote_average.gte': 6 } },
  { key: 't-crime',     title: 'Криминальные сериалы',  mediaType: 'tv', params: { with_genres: '80',    sort_by: 'vote_average.desc', 'vote_count.gte': 150, 'vote_average.gte': 6 } },
  { key: 't-doc',       title: 'Документальные сериалы', mediaType: 'tv', params: { with_genres: '99',   sort_by: 'vote_average.desc', 'vote_count.gte': 80,  'vote_average.gte': 6 } },
  { key: 't-drama',     title: 'Драматические сериалы', mediaType: 'tv', params: { with_genres: '18',    sort_by: 'vote_average.desc', 'vote_count.gte': 150, 'vote_average.gte': 6 } },
  { key: 't-family',    title: 'Семейные сериалы',      mediaType: 'tv', params: { with_genres: '10751', sort_by: 'vote_average.desc', 'vote_count.gte': 80,  'vote_average.gte': 6 } },
  { key: 't-kids',      title: 'Детские сериалы',       mediaType: 'tv', params: { with_genres: '10762', sort_by: 'vote_average.desc', 'vote_count.gte': 50,  'vote_average.gte': 6 } },
  { key: 't-detective', title: 'Детективные сериалы',   mediaType: 'tv', params: { with_genres: '9648',  sort_by: 'vote_average.desc', 'vote_count.gte': 150, 'vote_average.gte': 6 } },
  { key: 't-news',      title: 'Новости',               mediaType: 'tv', params: { with_genres: '10763', sort_by: 'vote_average.desc', 'vote_count.gte': 50, 'vote_average.gte': 6 } },
  { key: 't-reality',   title: 'Реалити-шоу',           mediaType: 'tv', params: { with_genres: '10764', sort_by: 'vote_average.desc', 'vote_count.gte': 50,  'vote_average.gte': 6 } },
  { key: 't-scifi',     title: 'Фантастика и фэнтези',  mediaType: 'tv', params: { with_genres: '10765', sort_by: 'vote_average.desc', 'vote_count.gte': 150, 'vote_average.gte': 6 } },
  { key: 't-soap',      title: 'Мыльные оперы',         mediaType: 'tv', params: { with_genres: '10766', sort_by: 'vote_average.desc', 'vote_count.gte': 50,  'vote_average.gte': 6 } },
  { key: 't-talk',      title: 'Ток-шоу',               mediaType: 'tv', params: { with_genres: '10767', sort_by: 'vote_average.desc', 'vote_count.gte': 50,  'vote_average.gte': 6 } },
  { key: 't-war',       title: 'Война и политика',      mediaType: 'tv', params: { with_genres: '10768', sort_by: 'vote_average.desc', 'vote_count.gte': 80,  'vote_average.gte': 6 } },
  { key: 't-western',   title: 'Вестерн-сериалы',       mediaType: 'tv', params: { with_genres: '37',    sort_by: 'vote_average.desc', 'vote_count.gte': 50,  'vote_average.gte': 6 } },
  { key: 't-russian',   title: 'Российские сериалы',    mediaType: 'tv', params: { with_origin_country: 'RU', sort_by: 'vote_average.desc', 'vote_count.gte': 30, 'vote_average.gte': 6 } },
  { key: 't-soviet',    title: 'Советские сериалы',     mediaType: 'tv', params: { with_origin_country: 'SU', sort_by: 'vote_average.desc', 'vote_count.gte': 20, 'vote_average.gte': 6 } },
];

// Обход массива с ограничением параллелизма (не долбим TMDB/прокси)
async function mapWithLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

// Жанровые подборки (персональные — скоринг через профиль вкуса)

router.get('/genres', async (req, res) => {
  try {
    const userId = req.user.id;

    // Исключаем просмотренные, «хочу посмотреть» и отмеченные как неинтересные
    const [watchedRaw, wantToWatch, notInterested] = await Promise.all([
      ListItemModel.findAllWithMetadata(userId, { status: 'watched' }),
      ListItemModel.findAll(userId, { status: 'want_to_watch' }),
      ListItemModel.findAll(userId, { status: 'not_interested' }),
    ]);
    const watched = watchedRaw.filter(i => i.details);
    const excludeIds = new Set([
      ...watchedRaw.map(i => i.tmdb_id),
      ...wantToWatch.map(i => i.tmdb_id),
      ...notInterested.map(i => i.tmdb_id),
    ]);

    // Профиль вкуса
    const profile = build_user_profile(watched);
    const hasProfile = profile.isSufficient;

    // Карта genre_id → name из БД
    const { rows: genreRows } = await db.query('SELECT id, name FROM genres');
    const genreMap = new Map(genreRows.map(g => [String(g.id), g.name]));

    const collections = await mapWithLimit(GENRE_COLLECTIONS, 5, async (col) => {
      try {
        const page = 1 + Math.floor(Math.random() * 3);
        const discover = col.mediaType === 'movie'
          ? tmdbService.discoverMovies
          : tmdbService.discoverTv;
        const data = await discover({ ...col.params, page });

        let items = (data.results || [])
          .filter(r => !excludeIds.has(r.id) && candidate_passes_thresholds({ tmdb_id: r.id, media_type: col.mediaType, details: r }))
          .slice(0, 15)
          .map(r => {
            // Конвертация genre_ids → genres для movie_data
            const genres = (r.genre_ids || []).map(id => ({
              id,
              name: genreMap.get(String(id)) || `#${id}`,
            }));
            return {
              ...r,
              title: r.title || r.name,
              genres,
              media_type: col.mediaType,
              details: { ...r, genres, title: r.title || r.name },
            };
          });

        // Скоринг если профиль достаточен
        if (hasProfile) {
          items = items.map(item => {
            const candidate = movie_data({ ...item, tmdb_id: item.id });
            const { score, components } = calculate_movie_score(candidate, profile);
            const { reason, matched_movies } = reason_for(candidate, profile);
            return { ...item, score, reason, matched_movies };
          });
          items.sort((a, b) => (b.score || 0) - (a.score || 0));
        }

        return { key: col.key, title: col.title, media_type: col.mediaType, items };
      } catch (err) {
        console.error(`[Recommendations] Ошибка подборки ${col.key}:`, err.message);
        return { key: col.key, title: col.title, media_type: col.mediaType, items: [] };
      }
    });

    res.json({ collections, hasProfile });
  } catch (err) {
    console.error('Ошибка жанровых подборок:', err);
    res.status(500).json({ error: 'Не удалось получить подборки' });
  }
});

// AI-поиск фильмов по естественному запросу
router.post('/search', async (req, res) => {
  try {
    const userId = req.user.id;
    const { query } = req.body;

    // Валидация
    if (!query || !query.trim()) {
      return res.status(400).json({ error: 'Введите запрос для поиска' });
    }
    if (query.length > 500) {
      return res.status(400).json({ error: 'Запрос слишком длинный (максимум 500 символов)' });
    }

    const { searchWithAI } = require('../services/aiSearch');
    const result = await searchWithAI(userId, query.trim());
    res.json(result);
  } catch (err) {
    console.error('[AI Search] Ошибка:', err);
    return isTimeoutError(err) ? recommendationsTimeout(res) : recommendationsUnavailable(res);
  }
});

// Discover с фильтрами — гибкий поиск по TMDB Discover API
router.get('/discover', async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      media_type,    // movie | tv | (пусто = оба)
      genre,         // ID жанра TMDB
      country,       // код страны (RU, US, GB и т.д.)
      year_from,     // минимальный год
      year_to,       // максимальный год
      rating_from,   // минимальный рейтинг
      sort_by,       // popularity.desc | vote_average.desc | primary_release_date.desc
      page = 1,
    } = req.query;

    // Исключаем просмотренные и «хочу посмотреть»
    const [watched, wantToWatch, notInterested] = await Promise.all([
      ListItemModel.findAll(userId, { status: 'watched' }),
      ListItemModel.findAll(userId, { status: 'want_to_watch' }),
      ListItemModel.findAll(userId, { status: 'not_interested' }),
    ]);
    const excludeIds = new Set([
      ...watched.map(i => i.tmdb_id),
      ...wantToWatch.map(i => i.tmdb_id),
      ...notInterested.map(i => i.tmdb_id),
    ]);

    const discoverParams = {
      page: parseInt(page),
      'vote_count.gte': config.MIN_VOTE_COUNT,
    };

    if (genre) discoverParams.with_genres = genre;
    if (country) {
      if (country.startsWith('!')) {
        // Исключить страну: without_countries
        discoverParams.without_countries = country.slice(1);
      } else {
        discoverParams.with_origin_country = country;
      }
    }
    if (rating_from) discoverParams['vote_average.gte'] = parseFloat(rating_from);
    if (year_from) discoverParams['primary_release_date.gte'] = `${year_from}-01-01`;
    if (year_to) discoverParams['primary_release_date.lte'] = `${year_to}-12-31`;
    if (sort_by) discoverParams.sort_by = sort_by;
    else discoverParams.sort_by = 'popularity.desc';

    const results = { items: [], total_results: 0, total_pages: 0 };

    const fetchType = async (type) => {
      const discover = type === 'tv' ? tmdbService.discoverTv : tmdbService.discoverMovies;
      const data = await discover(discoverParams);
      const items = (data.results || [])
        .filter(r => !excludeIds.has(r.id))
        .map(r => ({ ...r, media_type: type }));
      return { items, total_results: data.total_results || 0, total_pages: data.total_pages || 0 };
    };

    if (media_type === 'movie' || media_type === 'tv') {
      const r = await fetchType(media_type);
      results.items = r.items;
      results.total_results = r.total_results;
      results.total_pages = r.total_pages;
    } else {
      // Оба типа — параллельно
      const [movieR, tvR] = await Promise.all([fetchType('movie'), fetchType('tv')]);
      // Чередуем для разнообразия
      const merged = [];
      const maxLen = Math.max(movieR.items.length, tvR.items.length);
      for (let i = 0; i < maxLen; i++) {
        if (i < movieR.items.length) merged.push(movieR.items[i]);
        if (i < tvR.items.length) merged.push(tvR.items[i]);
      }
      results.items = merged;
      results.total_results = movieR.total_results + tvR.total_results;
      results.total_pages = Math.max(movieR.total_pages, tvR.total_pages);
    }

    res.json(results);
  } catch (err) {
    console.error('[Recommendations] Ошибка discover:', err);
    res.status(500).json({ error: 'Не удалось выполнить поиск' });
  }
});

// Очистить кэш
router.delete('/cache', async (req, res) => {
  try {
    await RecommendationModel.clearCache(req.user.id);
    res.json({ message: 'Кэш очищен' });
  } catch (err) {
    console.error('Ошибка очистки кэша:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Вспомогательная функция: генерация и возврат
async function generateAndReturn(userId, res) {
  await RecommendationModel.clearCache(userId);
  const generated = await generateForUser(userId);
  const items = await RecommendationModel.getCached(userId);
  const recommendations = items.map(item => ({
    movie_id: item.tmdb_id,
    tmdb_id: item.tmdb_id,
    media_type: item.media_type,
    title: item.details?.title || item.details?.name || `TMDB #${item.tmdb_id}`,
    score: Number(item.score),
    reason: item.reason,
    matched_movies: item.matched_movies || [],
    structured_reasons: item.structured_reasons || {},
    poster_path: item.details?.poster_path || null,
    overview: item.details?.overview || '',
    imdb_id: item.imdb_id || null,
    imdb_rating: item.imdb_rating == null ? null : Number(item.imdb_rating),
    imdb_votes: item.imdb_votes == null ? null : Number(item.imdb_votes),
  }));
  await history.recordImpressions(userId, recommendations, { algorithm: 'personal_v2' });
  res.json({ items: recommendations, recommendations, fromCache: false,
    message: generated.length ? undefined : 'Оцените как минимум два просмотренных фильма, чтобы получить персональные рекомендации.' });
}
module.exports = router;
