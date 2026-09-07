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
    let proxyUrl = `socks5h://${host}:${port}`;
    if (user && pass) {
      proxyUrl = `socks5h://${user}:${pass}@${host}:${port}`;
    }
    agent = new SocksProxyAgent(proxyUrl);
    console.log(`TMDB прокси подключен: socks5h://${user ? '***@' : ''}${host}:${port}`);
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
 * Включает нормализованные поля: год, жанры, режиссёры, актёры
 */
async function getMediaMetadata(tmdbId, mediaType) {
  try {
    const { rows } = await db.query(
      `SELECT mm.*,
              COALESCE(
                (SELECT json_agg(json_build_object('id', g.id, 'name', g.name) ORDER BY g.name)
                 FROM media_genres mg JOIN genres g ON g.id = mg.genre_id
                 WHERE mg.media_metadata_id = mm.id),
                '[]'::json
              ) as genres,
              COALESCE(
                (SELECT json_agg(json_build_object('person_id', md.person_id, 'name', md.name) ORDER BY md.name)
                 FROM media_directors md WHERE md.media_metadata_id = mm.id),
                '[]'::json
              ) as directors,
              COALESCE(
                (SELECT json_agg(json_build_object('person_id', ma.person_id, 'name', ma.name, 'character_name', ma.character_name, 'sort_order', ma.sort_order) ORDER BY ma.sort_order)
                 FROM media_actors ma WHERE ma.media_metadata_id = mm.id),
                '[]'::json
              ) as actors
       FROM media_metadata mm
       WHERE mm.tmdb_id = $1 AND mm.media_type = $2`,
      [tmdbId, mediaType]
    );
    if (rows.length > 0) {
      console.log(`[Media Metadata] HIT: ${mediaType}/${tmdbId}`);
      return rows[0];
    }
    return null;
  } catch (err) {
    console.error('[Media Metadata] Ошибка чтения:', err.message);
    return null;
  }
}

/**
 * Сохранить метаданные фильма/сериала в БД (навсегда)
 * Плюс нормализованные поля: год, жанры, режиссёры, актёры
 */
async function saveMediaMetadata(tmdbId, mediaType, data) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Основные данные
    const releaseYear = data.release_date
      ? parseInt(data.release_date.slice(0, 4))
      : data.first_air_date
        ? parseInt(data.first_air_date.slice(0, 4))
        : null;

    const { rows } = await client.query(
      `INSERT INTO media_metadata (tmdb_id, media_type, data, release_year, title, poster_path, overview)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tmdb_id, media_type)
       DO UPDATE SET data = $3, fetched_at = CURRENT_TIMESTAMP,
                     release_year = $4, title = $5, poster_path = $6, overview = $7
       RETURNING id`,
      [tmdbId, mediaType, JSON.stringify(data), releaseYear, data.title || data.name || null, data.poster_path || null, data.overview || null]
    );
    const metaId = rows[0].id;

    // Жанры
    if (data.genres && data.genres.length > 0) {
      for (const g of data.genres) {
        await client.query(
          `INSERT INTO genres (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = $2`,
          [g.id, g.name]
        );
        await client.query(
          `INSERT INTO media_genres (media_metadata_id, genre_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [metaId, g.id]
        );
      }
    }

    // Удаляем старые связи режиссёров и актёров (при обновлении)
    await client.query('DELETE FROM media_directors WHERE media_metadata_id = $1', [metaId]);
    await client.query('DELETE FROM media_actors WHERE media_metadata_id = $1', [metaId]);

    // Режиссёры (из credits.crew, job === 'Director')
    const crew = data.credits?.crew || [];
    const directors = crew.filter(c => c.job === 'Director');
    for (const d of directors) {
      await client.query(
        `INSERT INTO media_directors (media_metadata_id, person_id, name) VALUES ($1, $2, $3)`,
        [metaId, d.id, d.name]
      );
    }

    // Создатели сериалов (created_by) — тоже в media_directors
    if (mediaType === 'tv' && data.created_by && data.created_by.length > 0) {
      for (const c of data.created_by) {
        await client.query(
          `INSERT INTO media_directors (media_metadata_id, person_id, name) VALUES ($1, $2, $3)`,
          [metaId, c.id, c.name]
        );
      }
    }

    // Актёры (из credits.cast, берём топ-15 по order)
    const cast = (data.credits?.cast || []).slice(0, 15);
    for (const a of cast) {
      await client.query(
        `INSERT INTO media_actors (media_metadata_id, person_id, name, character_name, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [metaId, a.id, a.name, a.character || null, a.order ?? 0]
      );
    }

    await client.query('COMMIT');
    console.log(`[Media Metadata] SET: ${mediaType}/${tmdbId} (year=${releaseYear}, genres=${data.genres?.length || 0}, directors=${directors.length}, actors=${cast.length})`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Media Metadata] Ошибка записи:', err.message);
  } finally {
    client.release();
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

// Детали фильма (возвращает raw TMDB JSON — совместимость с фронтом)
async function getMovieDetails(id) {
  // 1. Проверяем БД — если есть, отдаём data (JSONB)
  const cached = await getMediaMetadata(id, 'movie');
  if (cached) return cached.data;

  // 2. Нет в БД — качаем из TMDB
  try {
    const data = await tmdbRequest(`/movie/${id}`, { append_to_response: 'credits,similar,videos' });
    // Сохраняем навсегда (включая нормализованные поля)
    saveMediaMetadata(id, 'movie', data).catch(() => {});
    return data;
  } catch (err) {
    // TMDB недоступен — пробуем отдать хоть что-то из кэша API
    const fallback = await getFromCache(`/movie/${id}`, { append_to_response: 'credits,similar,videos' });
    if (fallback) return fallback;
    throw err;
  }
}

// Детали сериала (возвращает raw TMDB JSON — совместимость с фронтом)
async function getTvDetails(id) {
  // 1. Проверяем БД — если есть, отдаём data (JSONB)
  const cached = await getMediaMetadata(id, 'tv');
  if (cached) return cached.data;

  // 2. Нет в БД — качаем из TMDB
  try {
    const data = await tmdbRequest(`/tv/${id}`, { append_to_response: 'credits,similar,videos' });
    // Сохраняем навсегда (включая нормализованные поля)
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
