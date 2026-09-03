const { SocksProxyAgent } = require('socks-proxy-agent');
const fetch = require('node-fetch');
const crypto = require('crypto');
const db = require('../db/database');

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_API_KEY = process.env.TMDB_API_KEY;
// Кэш бессрочный — данные хранятся в БД навсегда
const CACHE_FOREVER = '9999-12-31 23:59:59';

// Настройка прокси
let agent = null;
if (process.env.TMDB_PROXY_ENABLED === 'true') {
  const type = process.env.TMDB_PROXY_TYPE || 'socks5';
  const host = process.env.TMDB_PROXY_HOST || '127.0.0.1';
  const port = process.env.TMDB_PROXY_PORT || '1080';
  const user = process.env.TMDB_PROXY_USERNAME;
  const pass = process.env.TMDB_PROXY_PASSWORD;

  if (type === 'socks5') {
    let proxyUrl = `socks5://${host}:${port}`;
    if (user && pass) {
      proxyUrl = `socks5://${user}:${pass}@${host}:${port}`;
    }
    agent = new SocksProxyAgent(proxyUrl);
    console.log(`TMDB прокси подключен: socks5://${user ? '***@' : ''}${host}:${port}`);
  } else {
    console.log(`TMDB прокси типа "${type}" пока не поддерживается`);
  }
} else {
  console.log('TMDB прокси отключен');
}

/**
 * Вычислить хеш параметров запроса для кэша
 */
function paramsHash(params) {
  const sorted = Object.keys(params).sort().reduce((acc, key) => {
    acc[key] = params[key];
    return acc;
  }, {});
  return crypto.createHash('md5').update(JSON.stringify(sorted)).digest('hex');
}

/**
 * Получить закэшированный ответ из БД
 */
async function getFromCache(endpoint, params) {
  try {
    const hash = paramsHash(params);
    const { rows } = await db.query(
      `SELECT response FROM tmdb_cache
       WHERE endpoint = $1 AND params_hash = $2 AND expires_at > NOW()`,
      [endpoint, hash]
    );
    if (rows.length > 0) {
      console.log(`[TMDB Cache] HIT: ${endpoint}`);
      return rows[0].response;
    }
    return null;
  } catch (err) {
    console.error('[TMDB Cache] Ошибка чтения кэша:', err.message);
    return null;
  }
}

/**
 * Получить метаданные фильма/сериала из БД (бессрочно)
 */
async function getMediaMetadata(tmdbId, mediaType) {
  try {
    const { rows } = await db.query(
      `SELECT data FROM media_metadata WHERE tmdb_id = $1 AND media_type = $2`,
      [tmdbId, mediaType]
    );
    if (rows.length > 0) {
      console.log(`[Media Metadata] HIT: ${mediaType}/${tmdbId}`);
      return rows[0].data;
    }
    return null;
  } catch (err) {
    console.error('[Media Metadata] Ошибка чтения:', err.message);
    return null;
  }
}

/**
 * Сохранить метаданные фильма/сериала в БД (навсегда)
 */
async function saveMediaMetadata(tmdbId, mediaType, data) {
  try {
    await db.query(
      `INSERT INTO media_metadata (tmdb_id, media_type, data)
       VALUES ($1, $2, $3)
       ON CONFLICT (tmdb_id, media_type)
       DO UPDATE SET data = $3, fetched_at = CURRENT_TIMESTAMP`,
      [tmdbId, mediaType, JSON.stringify(data)]
    );
    console.log(`[Media Metadata] SET: ${mediaType}/${tmdbId}`);
  } catch (err) {
    console.error('[Media Metadata] Ошибка записи:', err.message);
  }
}

/**
 * Сохранить ответ в кэш
 * ttlHours: если задан — кэш живёт N часов, иначе бессрочно
 */
async function saveToCache(endpoint, params, response, ttlHours = null) {
  try {
    const hash = paramsHash(params);
    const expiresAt = ttlHours
      ? `NOW() + INTERVAL '1 hour' * ${parseInt(ttlHours)}`
      : `'${CACHE_FOREVER}'`;
    await db.query(
      `INSERT INTO tmdb_cache (endpoint, params_hash, response, expires_at)
       VALUES ($1, $2, $3, ${expiresAt})
       ON CONFLICT (endpoint, params_hash)
       DO UPDATE SET response = $3, expires_at = ${expiresAt}`,
      [endpoint, hash, JSON.stringify(response)]
    );
    console.log(`[TMDB Cache] SET: ${endpoint}`);
  } catch (err) {
    console.error('[TMDB Cache] Ошибка записи кэша:', err.message);
  }
}

/**
 * Запрос к TMDB API с кэшированием и retry
 * Сначала ищет в БД, если нет — делает запрос и сохраняет
 * opts.ttlHours — время жизни кэша в часах (по умолчанию бессрочно)
 */
async function tmdbRequest(endpoint, params = {}, opts = {}) {
  // Пробуем получить из кэша
  const cached = await getFromCache(endpoint, params);
  if (cached) return cached;

  // Кэша нет — делаем запрос к API
  const url = new URL(`${TMDB_BASE}${endpoint}`);
  url.searchParams.set('api_key', TMDB_API_KEY);
  url.searchParams.set('language', 'ru-RU');

  for (const [key, val] of Object.entries(params)) {
    url.searchParams.set(key, val);
  }

  const options = {};
  if (agent) {
    options.agent = agent;
  }

  // Retry логика для сетевых ошибок
  const maxRetries = 3;
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url.toString(), options);

      if (!response.ok) {
        throw new Error(`TMDB API ошибка: ${response.status}`);
      }

      const data = await response.json();

      // Сохраняем в кэш
      saveToCache(endpoint, params, data, opts.ttlHours).catch(() => {});

      return data;
    } catch (err) {
      lastError = err;
      
      // Проверяем это сетевая ошибка (TLS, connection reset, etc.)
      const isNetworkError = err.message && (
        err.message.includes('socket disconnected') ||
        err.message.includes('ECONNRESET') ||
        err.message.includes('ETIMEDOUT') ||
        err.message.includes('ENOTFOUND') ||
        err.message.includes('network') ||
        err.code === 'ECONNRESET' ||
        err.code === 'ETIMEDOUT'
      );

      if (isNetworkError && attempt < maxRetries) {
        console.log(`[TMDB] Сетевая ошибка (попытка ${attempt}/${maxRetries}), retry через 2 сек: ${err.message}`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // Не сетевая ошибка или последняя попытка — пробрасываем
      throw err;
    }
  }

  // Если все попытки исчерпаны
  throw lastError || new Error('TMDB request failed after retries');
}

// Поиск
async function search(query, type = 'multi', page = 1) {
  return tmdbRequest(`/search/${type}`, { query, include_adult: false, page });
}

// Популярные фильмы
async function getPopularMovies() {
  return tmdbRequest('/movie/popular', { page: 1 });
}

// Популярные фильмы за последний год
async function getPopularMoviesLastYear() {
  const now = new Date();
  const yearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
  const dateTo = now.toISOString().slice(0, 10);
  const dateFrom = yearAgo.toISOString().slice(0, 10);
  return tmdbRequest('/discover/movie', {
    'primary_release_date.gte': dateFrom,
    'primary_release_date.lte': dateTo,
    sort_by: 'popularity.desc',
    page: 1,
  });
}

// Популярные сериалы за последний год
async function getPopularTvLastYear() {
  const now = new Date();
  const yearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
  const dateTo = now.toISOString().slice(0, 10);
  const dateFrom = yearAgo.toISOString().slice(0, 10);
  return tmdbRequest('/discover/tv', {
    'first_air_date.gte': dateFrom,
    'first_air_date.lte': dateTo,
    sort_by: 'popularity.desc',
    page: 1,
  });
}

// Популярные сериалы
async function getPopularTv() {
  return tmdbRequest('/tv/popular', { page: 1 });
}

// Сейчас на TV
async function getOnTheAirTv() {
  return tmdbRequest('/tv/on_the_air', { page: 1 });
}

// Тренды недели (TTL 6ч — обновляются еженедельно, кэш бессрочный не подходит)
async function getTrendingMoviesWeek() {
  return tmdbRequest('/trending/movie/week', {}, { ttlHours: 6 });
}

async function getTrendingTvWeek() {
  return tmdbRequest('/trending/tv/week', {}, { ttlHours: 6 });
}

// Сейчас в кино (RU, TTL 24ч)
async function getNowPlayingMovies() {
  return tmdbRequest('/movie/now_playing', { page: 1, region: 'RU' }, { ttlHours: 24 });
}

// Скоро выйдут (RU, TTL 24ч)
async function getUpcomingMovies() {
  return tmdbRequest('/movie/upcoming', { page: 1, region: 'RU' }, { ttlHours: 24 });
}

// Топ рейтинга (TTL 7 дней — меняется медленно)
async function getTopRatedMovies() {
  return tmdbRequest('/movie/top_rated', { page: 1 }, { ttlHours: 168 });
}

async function getTopRatedTv() {
  return tmdbRequest('/tv/top_rated', { page: 1 }, { ttlHours: 168 });
}

// Детали фильма
async function getMovieDetails(id) {
  // 1. Проверяем БД — если есть, отдаём сразу
  const cached = await getMediaMetadata(id, 'movie');
  if (cached) return cached;

  // 2. Нет в БД — качаем из TMDB
  try {
    const data = await tmdbRequest(`/movie/${id}`, { append_to_response: 'credits,similar,videos' });
    // Сохраняем навсегда
    saveMediaMetadata(id, 'movie', data).catch(() => {});
    return data;
  } catch (err) {
    // TMDB недоступен — пробуем отдать хоть что-то из кэша API
    const fallback = await getFromCache(`/movie/${id}`, { append_to_response: 'credits,similar,videos' });
    if (fallback) return fallback;
    throw err;
  }
}

// Детали сериала
async function getTvDetails(id) {
  // 1. Проверяем БД — если есть, отдаём сразу
  const cached = await getMediaMetadata(id, 'tv');
  if (cached) return cached;

  // 2. Нет в БД — качаем из TMDB
  try {
    const data = await tmdbRequest(`/tv/${id}`, { append_to_response: 'credits,similar,videos' });
    // Сохраняем навсегда
    saveMediaMetadata(id, 'tv', data).catch(() => {});
    return data;
  } catch (err) {
    // TMDB недоступен — пробуем отдать хоть что-то из кэша API
    const fallback = await getFromCache(`/tv/${id}`, { append_to_response: 'credits,similar,videos' });
    if (fallback) return fallback;
    throw err;
  }
}

// Жанры
async function getMovieGenres() {
  return tmdbRequest('/genre/movie/list');
}

async function getTvGenres() {
  return tmdbRequest('/genre/tv/list');
}

// Актёр — детали
async function getPersonDetails(id) {
  return tmdbRequest(`/person/${id}`);
}

// Актёр — фильмы
async function getPersonMovieCredits(id) {
  return tmdbRequest(`/person/${id}/movie_credits`);
}

// Актёр — сериалы
async function getPersonTvCredits(id) {
  return tmdbRequest(`/person/${id}/tv_credits`);
}

// Discover — фильмы с параметрами
async function discoverMovies(params = {}) {
  const defaultParams = {
    page: 1,
    'vote_count.gte': 100, // Исключаем малоизвестные
    ...params,
  };
  return tmdbRequest('/discover/movie', defaultParams);
}

// Discover — сериалы с параметрами
async function discoverTv(params = {}) {
  const defaultParams = {
    page: 1,
    'vote_count.gte': 100,
    ...params,
  };
  return tmdbRequest('/discover/tv', defaultParams);
}

module.exports = {
  search,
  getPopularMovies,
  getPopularMoviesLastYear,
  getPopularTvLastYear,
  getPopularTv,
  getOnTheAirTv,
  getTrendingMoviesWeek,
  getTrendingTvWeek,
  getNowPlayingMovies,
  getUpcomingMovies,
  getTopRatedMovies,
  getTopRatedTv,
  getMovieDetails,
  getTvDetails,
  getMovieGenres,
  getTvGenres,
  getPersonDetails,
  getPersonMovieCredits,
  getPersonTvCredits,
  getMediaMetadata,
  saveMediaMetadata,
  tmdbRequest,
  discoverMovies,
  discoverTv,
};
