const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const tmdbService = require('../services/tmdb');
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

// Поиск
router.get('/search', async (req, res) => {
  try {
    const { query, type, page } = req.query;
    if (!query) {
      return res.status(400).json({ error: 'query обязателен' });
    }
    const result = await tmdbService.search(query, type || 'multi', page || 1);
    res.json(result);
  } catch (err) {
    console.error('Ошибка TMDB поиска:', err);
    res.status(502).json({ error: 'Ошибка TMDB API' });
  }
});

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

// Видео фильма
router.get('/movie/:id/videos', async (req, res) => {
  try {
    const result = await tmdbService.tmdbRequest(`/movie/${req.params.id}/videos`);
    res.json(result);
  } catch (err) {
    console.error('Ошибка TMDB:', err);
    res.status(502).json({ error: 'Ошибка TMDB API' });
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

// Видео сериала
router.get('/tv/:id/videos', async (req, res) => {
  try {
    const result = await tmdbService.tmdbRequest(`/tv/${req.params.id}/videos`);
    res.json(result);
  } catch (err) {
    console.error('Ошибка TMDB:', err);
    res.status(502).json({ error: 'Ошибка TMDB API' });
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
router.get('/person/:id', async (req, res) => {
  try {
    const [person, movieCredits, tvCredits] = await Promise.all([
      tmdbService.getPersonDetails(req.params.id),
      tmdbService.getPersonMovieCredits(req.params.id),
      tmdbService.getPersonTvCredits(req.params.id),
    ]);
    res.json({
      ...person,
      movie_credits: movieCredits,
      tv_credits: tvCredits,
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

module.exports = router;
