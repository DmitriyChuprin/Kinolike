const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const tmdbService = require('../services/tmdb');
const { summarizeReviews } = require('../services/ai');
const reviewSummaryModel = require('../models/reviewSummary');
const catalogService = require('../services/catalog').createCatalogService(tmdbService.tmdbRequest);
const { optionalAuth } = require('../middleware/auth');
const { SocksProxyAgent } = require('socks-proxy-agent');
const fetch = require('node-fetch');

// Директория кэша изображений
const IMAGE_CACHE_DIR = path.join(__dirname, '..', 'cache', 'images');
fs.mkdirSync(IMAGE_CACHE_DIR, { recursive: true });

/**
 * Ключ кэша: размер + имя файла из TMDB-пути
 * /abc123.jpg → w342_abc123.jpg
 */
function cacheKey(imgSize, tmdbPath) {
  const filename = tmdbPath.replace(/^\//, ''); // убираем начальный /
  return `${imgSize}_${filename}`;
}

// Настройка прокси для изображений
let imageAgent = null;
if (process.env.TMDB_PROXY_ENABLED === 'true') {
  const type = process.env.TMDB_PROXY_TYPE || 'socks5';
  const host = process.env.TMDB_PROXY_HOST || '127.0.0.1';
  const port = process.env.TMDB_PROXY_PORT || '1080';
  const user = process.env.TMDB_PROXY_USERNAME;
  const pass = process.env.TMDB_PROXY_PASSWORD;
  if (type === 'socks5') {
    let proxyUrl = `socks5h://${host}:${port}`;
    if (user && pass) proxyUrl = `socks5h://${user}:${pass}@${host}:${port}`;
    imageAgent = new SocksProxyAgent(proxyUrl);
  }
}

// Прокси изображений TMDB с кэшированием на диск
router.get('/image', async (req, res) => {
  try {
    const { path: tmdbPath, size } = req.query;
    if (!tmdbPath) return res.status(400).json({ error: 'path обязателен' });
    const imgSize = size || 'w342';
    const key = cacheKey(imgSize, tmdbPath);
    const filePath = path.join(IMAGE_CACHE_DIR, key);

    // 1. Если файл уже в кэше — отдаём сразу
    if (fs.existsSync(filePath)) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=604800'); // 7 дней
      return res.sendFile(filePath);
    }

    // 2. Кэша нет — качаем из TMDB с retry
    const url = `https://image.tmdb.org/t/p/${imgSize}${tmdbPath}`;
    const options = {};
    if (imageAgent) options.agent = imageAgent;
    
    const maxRetries = 3;
    let response = null;
    let lastError = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        response = await fetch(url, options);
        if (response.ok) break;
        
        // Если не ok, но не сетевая ошибка — выходим
        if (response.status !== 502 && response.status !== 503) {
          return res.status(response.status).end();
        }
        lastError = new Error(`HTTP ${response.status}`);
      } catch (err) {
        lastError = err;
        
        // Проверяем это сетевая ошибка
        const isNetworkError = err.message && (
          err.message.includes('socket disconnected') ||
          err.message.includes('ECONNRESET') ||
          err.message.includes('ETIMEDOUT') ||
          err.message.includes('network')
        );
        
        if (isNetworkError && attempt < maxRetries) {
          console.log(`[Image Proxy] Сетевая ошибка (попытка ${attempt}/${maxRetries}), retry через 1 сек`);
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        
        // Не сетевая ошибка или последняя попытка
        throw err;
      }
    }
    
    if (!response || !response.ok) {
      throw lastError || new Error('Image proxy failed after retries');
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const buffer = await response.buffer();

    // Сохраняем в кэш (fire-and-forget)
    fs.writeFile(filePath, buffer, (err) => {
      if (err) console.error('[Image Cache] Ошибка записи:', err.message);
    });

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.send(buffer);
  } catch (err) {
    console.error('Ошибка прокси изображения:', err.message);
    res.status(502).end();
  }
});

// Public catalog and search share the same pagination contract.
for (const name of ['search', 'catalog']) {
  router.get(`/${name}`, async (req, res) => {
    try {
      res.json(await catalogService[name](req.query));
    } catch (err) {
      console.error(`Ошибка TMDB ${name}:`, err.message);
      res.status(err.status || 502).json({ error: err.status ? err.message : 'Не удалось загрузить каталог. Попробуйте ещё раз.' });
    }
  });
}

// Популярные фильмы
router.get('/movie/popular', async (req, res) => {
  try {
    const result = await tmdbService.getPopularMovies();
    res.json(result);
  } catch (err) {
    console.error('Ошибка TMDB:', err);
    res.status(502).json({ error: 'Ошибка TMDB API' });
  }
});

// Популярные фильмы за последний год
router.get('/movie/last_year', async (req, res) => {
  try {
    const result = await tmdbService.getPopularMoviesLastYear();
    res.json(result);
  } catch (err) {
    console.error('Ошибка TMDB:', err);
    res.status(502).json({ error: 'Ошибка TMDB API' });
  }
});

// Популярные сериалы за последний год
router.get('/tv/last_year', async (req, res) => {
  try {
    const result = await tmdbService.getPopularTvLastYear();
    res.json(result);
  } catch (err) {
    console.error('Ошибка TMDB:', err);
    res.status(502).json({ error: 'Ошибка TMDB API' });
  }
});

// Тренды недели
router.get('/trending/movie/week', async (req, res) => {
  try {
    const result = await tmdbService.getTrendingMoviesWeek();
    res.json(result);
  } catch (err) {
    console.error('Ошибка TMDB:', err);
    res.status(502).json({ error: 'Ошибка TMDB API' });
  }
});

router.get('/trending/tv/week', async (req, res) => {
  try {
    const result = await tmdbService.getTrendingTvWeek();
    res.json(result);
  } catch (err) {
    console.error('Ошибка TMDB:', err);
    res.status(502).json({ error: 'Ошибка TMDB API' });
  }
});

// Сейчас в кино
router.get('/movie/now_playing', async (req, res) => {
  try {
    const result = await tmdbService.getNowPlayingMovies();
    res.json(result);
  } catch (err) {
    console.error('Ошибка TMDB:', err);
    res.status(502).json({ error: 'Ошибка TMDB API' });
  }
});

// Скоро выйдут
router.get('/movie/upcoming', async (req, res) => {
  try {
    const result = await tmdbService.getUpcomingMovies();
    res.json(result);
  } catch (err) {
    console.error('Ошибка TMDB:', err);
    res.status(502).json({ error: 'Ошибка TMDB API' });
  }
});

// Топ по рейтингу
router.get('/movie/top_rated', async (req, res) => {
  try {
    const result = await tmdbService.getTopRatedMovies();
    res.json(result);
  } catch (err) {
    console.error('Ошибка TMDB:', err);
    res.status(502).json({ error: 'Ошибка TMDB API' });
  }
});

router.get('/tv/top_rated', async (req, res) => {
  try {
    const result = await tmdbService.getTopRatedTv();
    res.json(result);
  } catch (err) {
    console.error('Ошибка TMDB:', err);
    res.status(502).json({ error: 'Ошибка TMDB API' });
  }
});

// Детали фильма
router.get('/movie/:id', async (req, res) => {
  try {
    const result = await tmdbService.getMovieDetails(req.params.id);
    res.json(result);
  } catch (err) {
    console.error('Ошибка TMDB:', err);
    res.status(502).json({ error: 'Ошибка TMDB API' });
  }
});

// Кредиты фильма
router.get('/movie/:id/credits', async (req, res) => {
  try {
    const result = await tmdbService.tmdbRequest(`/movie/${req.params.id}/credits`);
    res.json(result);
  } catch (err) {
    console.error('Ошибка TMDB:', err);
    res.status(502).json({ error: 'Ошибка TMDB API' });
  }
});

// Похожие фильмы
router.get('/movie/:id/similar', async (req, res) => {
  try {
    const result = await tmdbService.tmdbRequest(`/movie/${req.params.id}/similar`);
    res.json(result);
  } catch (err) {
    console.error('Ошибка TMDB:', err);
    res.status(502).json({ error: 'Ошибка TMDB API' });
  }
});

async function sendReviewSummary(mediaType, req, res) {
  try {
    const id = req.params.id;
    const cached = await reviewSummaryModel.find(id, mediaType);
    if (cached) {
      return res.json({
        summary: cached.summary,
        sourceCount: cached.source_count,
        language: cached.source_language || '',
        cached: true,
        generatedAt: cached.generated_at,
      });
    }

    const [details, reviewData] = await Promise.all([
      mediaType === 'movie' ? tmdbService.getMovieDetails(id) : tmdbService.getTvDetails(id),
      tmdbService.getReviews(mediaType, id),
    ]);
    const title = details.title || details.name || 'Без названия';
    const date = details.release_date || details.first_air_date || '';
    const result = await summarizeReviews({
      title,
      year: String(date).slice(0, 4),
      mediaType,
      reviews: reviewData.results || [],
    });
    if (result.summary) {
      const saved = await reviewSummaryModel.save(id, mediaType, {
        ...result,
        language: reviewData.language || '',
      });
      return res.json({
        summary: saved.summary,
        sourceCount: saved.source_count,
        language: saved.source_language || '',
        cached: false,
        generatedAt: saved.generated_at,
      });
    }
    res.json({ ...result, language: reviewData.language || '', cached: false });
  } catch (err) {
    console.error('Ошибка AI-сводки отзывов:', err.message);
    res.status(503).json({ error: 'AI-сводка отзывов временно недоступна' });
  }
}

router.get('/movie/:id/review-summary', (req, res) => sendReviewSummary('movie', req, res));

router.get('/movie/:id/reviews', async (req, res) => {
  try {
    res.json(await tmdbService.getReviews('movie', req.params.id));
  } catch (err) {
    console.error('Ошибка отзывов TMDB:', err);
    res.status(502).json({ error: 'Не удалось загрузить отзывы' });
  }
});

// Популярные сериалы
router.get('/tv/popular', async (req, res) => {
  try {
    const result = await tmdbService.getPopularTv();
    res.json(result);
  } catch (err) {
    console.error('Ошибка TMDB:', err);
    res.status(502).json({ error: 'Ошибка TMDB API' });
  }
});

// Сейчас на TV
router.get('/tv/on_the_air', async (req, res) => {
  try {
    const result = await tmdbService.getOnTheAirTv();
    res.json(result);
  } catch (err) {
    console.error('Ошибка TMDB:', err);
    res.status(502).json({ error: 'Ошибка TMDB API' });
  }
});

// Детали сериала
router.get('/tv/:id', async (req, res) => {
  try {
    const result = await tmdbService.getTvDetails(req.params.id);
    res.json(result);
  } catch (err) {
    console.error('Ошибка TMDB:', err);
    res.status(502).json({ error: 'Ошибка TMDB API' });
  }
});

// Кредиты сериала
router.get('/tv/:id/credits', async (req, res) => {
  try {
    const result = await tmdbService.tmdbRequest(`/tv/${req.params.id}/credits`);
    res.json(result);
  } catch (err) {
    console.error('Ошибка TMDB:', err);
    res.status(502).json({ error: 'Ошибка TMDB API' });
  }
});

// Похожие сериалы
router.get('/tv/:id/similar', async (req, res) => {
  try {
    const result = await tmdbService.tmdbRequest(`/tv/${req.params.id}/similar`);
    res.json(result);
  } catch (err) {
    console.error('Ошибка TMDB:', err);
    res.status(502).json({ error: 'Ошибка TMDB API' });
  }
});

router.get('/tv/:id/review-summary', (req, res) => sendReviewSummary('tv', req, res));

router.get('/tv/:id/reviews', async (req, res) => {
  try {
    res.json(await tmdbService.getReviews('tv', req.params.id));
  } catch (err) {
    console.error('Ошибка отзывов TMDB:', err);
    res.status(502).json({ error: 'Не удалось загрузить отзывы' });
  }
});

// Жанры
router.get('/genres/movie', async (req, res) => {
  try {
    const result = await tmdbService.getMovieGenres();
    res.json(result);
  } catch (err) {
    console.error('Ошибка TMDB:', err);
    res.status(502).json({ error: 'Ошибка TMDB API' });
  }
});

router.get('/genres/tv', async (req, res) => {
  try {
    const result = await tmdbService.getTvGenres();
    res.json(result);
  } catch (err) {
    console.error('Ошибка TMDB:', err);
    res.status(502).json({ error: 'Ошибка TMDB API' });
  }
});

// Объединённый маршрут для жанров
router.get('/genres', async (req, res) => {
  try {
    const [movieGenres, tvGenres] = await Promise.all([
      tmdbService.getMovieGenres(),
      tmdbService.getTvGenres(),
    ]);
    res.json({ movie: movieGenres.genres, tv: tvGenres.genres });
  } catch (err) {
    console.error('Ошибка TMDB:', err);
    res.status(502).json({ error: 'Ошибка TMDB API' });
  }
});

// ===== Актёр =====
// Детали актёра + фильмы + сериалы за один запрос
router.get('/person/:id', optionalAuth, async (req, res) => {
  try {
    const [person, movieCredits, tvCredits] = await Promise.all([
      tmdbService.getPersonDetails(req.params.id),
      tmdbService.getPersonMovieCredits(req.params.id),
      tmdbService.getPersonTvCredits(req.params.id),
    ]);
    const imdbService = require('../services/imdb');
    const movieCast = movieCredits.cast || [];
    const tvCast = tvCredits.cast || [];
    const imdb = await imdbService.getPersonFilmography(
      person,
      movieCast,
      tvCast,
      req.user?.id || null,
    );
    res.json({
      ...person,
      movie_credits: movieCredits,
      tv_credits: tvCredits,
      imdb_id: imdb.imdb_id,
      known_works: imdb.known_works,
      filmography: imdb.filmography,
    });
  } catch (err) {
    console.error('Ошибка TMDB person:', err);
    res.status(502).json({ error: 'Ошибка TMDB API' });
  }
});

// Обновить метаданные фильма/сериала (удалить кэш и перезапросить)
router.delete('/metadata/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    if (!['movie', 'tv'].includes(type)) {
      return res.status(400).json({ error: 'type должен быть movie или tv' });
    }
    const db = require('../db/database');
    // Удаляем из media_metadata
    await db.query('DELETE FROM media_metadata WHERE tmdb_id = $1 AND media_type = $2', [id, type]);
    // Удаляем из tmdb_cache
    await db.query('DELETE FROM tmdb_cache WHERE endpoint = $1', [`/${type}/${id}`]);
    console.log(`[Media Metadata] DELETED: ${type}/${id}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Ошибка удаления метаданных:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ── TMDB Sync endpoints ─────────────────────────────────────────────────────

const { runSync, getLastSyncTime } = require('../services/tmdbSyncService');

// GET /api/tmdb/sync/status — sync history and status
router.get('/sync/status', async (req, res) => {
  try {
    const db = require('../db/database');
    const history = await db.query(
      'SELECT * FROM tmdb_sync_history ORDER BY started_at DESC LIMIT 10'
    );
    const lastSync = await getLastSyncTime();
    res.json({ lastSuccessfulSync: lastSync, history: history.rows });
  } catch (err) {
    console.error('[TMDB Sync] Status error:', err);
    res.status(500).json({ error: 'Ошибка получения статуса синхронизации' });
  }
});

// POST /api/tmdb/sync/run — manual trigger
router.post('/sync/run', async (req, res) => {
  try {
    console.log('[TMDB Sync] Manual sync triggered');
    const stats = await runSync();
    res.json({ success: true, stats });
  } catch (err) {
    console.error('[TMDB Sync] Manual sync error:', err);
    res.status(500).json({ error: 'Ошибка синхронизации: ' + err.message });
  }
});

module.exports = router;
