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

const TMDB_LOCALE = 'ru-RU';

function localizedCacheParams(params = {}) {
  return { language: TMDB_LOCALE, ...params };
}

/**
 * Получить закэшированный ответ из БД
 */
async function getFromCache(endpoint, params, { allowExpired = false } = {}) {
  try {
    const hash = paramsHash(params);
    const { rows } = await db.query(
      `SELECT response FROM tmdb_cache
       WHERE endpoint = $1 AND params_hash = $2 ${allowExpired ? '' : 'AND expires_at > NOW()'}
       ORDER BY created_at DESC LIMIT 1`,
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
       WHERE mm.tmdb_id = $1 AND mm.media_type = $2 AND mm.locale = $3`,
      [tmdbId, mediaType, TMDB_LOCALE]
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

function mergeImdbMetadata(data, metadata) {
  if (!metadata) return data;
  return {
    ...data,
    imdb_id: metadata.imdb_id || data?.imdb_id || data?.external_ids?.imdb_id || null,
    imdb_rating: metadata.imdb_rating === null ? null : Number(metadata.imdb_rating),
    imdb_votes: metadata.imdb_votes === null ? null : Number(metadata.imdb_votes),
    imdb_updated_at: metadata.imdb_updated_at || null,
  };
}

async function ensureCachedImdbMetadata(metadata, tmdbId, mediaType) {
  if (!metadata) return metadata;
  const embeddedId = metadata.data?.imdb_id || metadata.data?.external_ids?.imdb_id;
  if (metadata.imdb_id || /^tt\d+$/.test(embeddedId || '')) {
    if (!metadata.imdb_id && embeddedId) {
      await db.query(
        `UPDATE media_metadata SET imdb_id = $2
         WHERE id = $1
           AND NOT EXISTS (SELECT 1 FROM media_metadata WHERE imdb_id = $2 AND id <> $1)`,
        [metadata.id, embeddedId],
      );
      metadata.imdb_id = embeddedId;
    }
    return metadata;
  }

  try {
    const external = await tmdbRequest(`/${mediaType}/${tmdbId}/external_ids`);
    const imdbId = external?.imdb_id;
    if (!/^tt\d+$/.test(imdbId || '')) return metadata;
    const conflict = await db.query(
      'SELECT id FROM media_metadata WHERE imdb_id = $1 AND id <> $2',
      [imdbId, metadata.id],
    );
    if (conflict.rows.length > 0) return metadata;
    await db.query(
      `UPDATE media_metadata target SET
         imdb_id = $2,
         imdb_rating = rating.rating,
         imdb_votes = rating.votes,
         imdb_updated_at = COALESCE(rating.updated_at, CURRENT_TIMESTAMP)
       FROM (SELECT rating, votes, updated_at FROM imdb_ratings WHERE imdb_id = $2) rating
       WHERE target.id = $1`,
      [metadata.id, imdbId],
    );
    await db.query(
      'UPDATE media_metadata SET imdb_id = $2 WHERE id = $1 AND imdb_id IS NULL',
      [metadata.id, imdbId],
    );
    await db.query(
      `UPDATE person_credits SET title_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE imdb_title_id = $2 AND title_id IS DISTINCT FROM $1`,
      [metadata.id, imdbId],
    );
    const refreshed = await getMediaMetadata(tmdbId, mediaType);
    return refreshed || { ...metadata, imdb_id: imdbId };
  } catch (error) {
    console.warn(`[TMDB] Не удалось дополнить ${mediaType}/${tmdbId} IMDb ID: ${error.message}`);
    return metadata;
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

    let imdbId = data.imdb_id || data.external_ids?.imdb_id || null;
    if (imdbId && !/^tt\d+$/.test(imdbId)) imdbId = null;
    if (imdbId) {
      const conflict = await client.query(
        `SELECT tmdb_id, media_type FROM media_metadata
         WHERE imdb_id = $1 AND (tmdb_id <> $2 OR media_type <> $3)`,
        [imdbId, tmdbId, mediaType],
      );
      if (conflict.rows.length > 0) {
        console.warn(`[TMDB] IMDb ${imdbId} уже связан с ${conflict.rows[0].media_type}/${conflict.rows[0].tmdb_id}; новая связь пропущена`);
        imdbId = null;
      }
    }
    const imdbData = imdbId
      ? (await client.query(
        `SELECT rating AS imdb_rating, votes AS imdb_votes, updated_at AS imdb_updated_at
         FROM imdb_ratings WHERE imdb_id = $1`,
        [imdbId],
      )).rows[0]
      : null;

    const { rows } = await client.query(
      `INSERT INTO media_metadata
         (tmdb_id, media_type, data, locale, release_year, title, poster_path,
          overview, imdb_id, imdb_rating, imdb_votes, imdb_updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (tmdb_id, media_type)
       DO UPDATE SET data = $3, locale = $4, fetched_at = CURRENT_TIMESTAMP,
                     release_year = $5, title = $6, poster_path = $7, overview = $8,
                     imdb_id = COALESCE($9, media_metadata.imdb_id),
                     imdb_rating = COALESCE($10, media_metadata.imdb_rating),
                     imdb_votes = COALESCE($11, media_metadata.imdb_votes),
                     imdb_updated_at = COALESCE($12, media_metadata.imdb_updated_at)
       RETURNING id`,
      [
        tmdbId,
        mediaType,
        JSON.stringify(data),
        TMDB_LOCALE,
        releaseYear,
        data.title || data.name || null,
        data.poster_path || null,
        data.overview || null,
        imdbId,
        imdbData?.imdb_rating ?? null,
        imdbData?.imdb_votes ?? null,
        imdbData?.imdb_updated_at ?? null,
      ]
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

    if (imdbId) {
      await client.query(
        `UPDATE person_credits SET title_id = $1, updated_at = CURRENT_TIMESTAMP
         WHERE imdb_title_id = $2 AND title_id IS DISTINCT FROM $1`,
        [metaId, imdbId],
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
  const cacheParams = localizedCacheParams(params);
  // Пробуем получить из кэша
  const cached = await getFromCache(endpoint, cacheParams);
  if (cached) return cached;

  // Кэша нет — делаем запрос к API
  const url = new URL(`${TMDB_BASE}${endpoint}`);
  url.searchParams.set('api_key', TMDB_API_KEY);
  url.searchParams.set('language', TMDB_LOCALE);

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
      saveToCache(endpoint, cacheParams, data, opts.ttlHours).catch(() => {});

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

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function sixMonthsAgo(today) {
  const start = new Date(today);
  start.setUTCMonth(start.getUTCMonth() - 6);
  return start;
}

function russianNewScore(item, today) {
  const releaseDate = new Date(`${item.releaseDate}T00:00:00Z`);
  const ageDays = Math.max(0, (today - releaseDate) / 86400000);
  const freshness = Math.max(0, Math.min(1, 1 - ageDays / 183));
  // A saturating curve keeps one unusually high TMDB popularity value from
  // drowning out recency and rating confidence.
  const popularity = Math.max(0, Number(item.popularity) || 0);
  const popularityScore = popularity / (popularity + 20);
  const votes = Math.max(0, Number(item.voteCount) || 0);
  const rating = Math.max(0, Math.min(10, Number(item.voteAverage) || 0)) / 10;
  const ratingConfidence = rating * (0.35 + 0.65 * (1 - Math.exp(-votes / 30)));
  return Number((0.45 * freshness + 0.35 * popularityScore + 0.20 * ratingConfidence).toFixed(4));
}

function normalizeRussianNew(items, mediaType, today, start) {
  return items.map((raw) => {
    const releaseDate = String(mediaType === 'movie' ? raw.release_date : raw.first_air_date || '');
    const item = {
      id: Number(raw.id), mediaType,
      title: String(raw.title || raw.name || ''),
      originalTitle: String(raw.original_title || raw.original_name || ''),
      posterPath: String(raw.poster_path || ''), releaseDate,
      voteAverage: Number(raw.vote_average) || 0, voteCount: Number(raw.vote_count) || 0,
      popularity: Number(raw.popularity) || 0,
      // Preserve TMDB field names so the established frontend mapper and
      // MovieCard can render these without another card type.
      titleRaw: raw.title, nameRaw: raw.name, originalTitleRaw: raw.original_title,
      originalNameRaw: raw.original_name, overview: raw.overview || '',
    };
    item.score = russianNewScore(item, today);
    return item;
  }).filter((item) => {
    const release = new Date(`${item.releaseDate}T00:00:00Z`);
    const correctlyFormattedDate = /^\d{4}-\d{2}-\d{2}$/.test(item.releaseDate)
      && !Number.isNaN(release.getTime()) && dateOnly(release) === item.releaseDate;
    if (!item.id || !item.title || !item.posterPath || !correctlyFormattedDate || release < start || release > today) return false;
    const ageDays = Math.max(0, (today - release) / 86400000);
    // Brand-new titles get a lower evidence bar, but still need visible TMDB
    // interest. Older titles need either popularity or a small voting signal.
    if (ageDays <= 30) return item.popularity >= 7;
    return item.popularity >= 4 || item.voteCount >= 8;
  }).sort((a, b) => b.score - a.score);
}

/**
 * Curated six-month Russian-language releases for the home page.
 * Discover responses are cached for 12h in the existing PostgreSQL TMDB cache.
 */
async function getRussianNew() {
  const cacheEndpoint = '/home/russian-new';
  // Bump on a selection-contract change so an old TV-only prepared list is
  // never served for another 12 hours.
  const cacheParams = { version: 2 };
  const cached = await getFromCache(cacheEndpoint, cacheParams);
  if (cached) return cached;

  const today = new Date();
  today.setUTCHours(23, 59, 59, 999);
  const start = sixMonthsAgo(today);
  const movieParams = { with_original_language: 'ru', 'primary_release_date.gte': dateOnly(start), 'primary_release_date.lte': dateOnly(today), sort_by: 'popularity.desc', include_adult: false, page: 1 };
  const tvParams = { with_original_language: 'ru', 'first_air_date.gte': dateOnly(start), 'first_air_date.lte': dateOnly(today), sort_by: 'popularity.desc', include_adult: false, page: 1 };
  try {
    const [movies, tv] = await Promise.all([
      tmdbRequest('/discover/movie', movieParams, { ttlHours: 12 }),
      tmdbRequest('/discover/tv', tvParams, { ttlHours: 12 }),
    ]);
    const movieResults = normalizeRussianNew(movies.results || [], 'movie', today, start).slice(0, 10);
    const tvResults = normalizeRussianNew(tv.results || [], 'tv', today, start).slice(0, 10);
    // Keep quality thresholds intact while preventing one TMDB media category
    // from occupying every slot in the mixed row.
    const results = [...movieResults, ...tvResults].sort((a, b) => b.score - a.score).slice(0, 20);
    const response = {
      results: results.map((item) => ({
        id: item.id, media_type: item.mediaType,
        title: item.titleRaw, name: item.nameRaw,
        original_title: item.originalTitleRaw, original_name: item.originalNameRaw,
        poster_path: item.posterPath, release_date: item.mediaType === 'movie' ? item.releaseDate : undefined,
        first_air_date: item.mediaType === 'tv' ? item.releaseDate : undefined,
        overview: item.overview, vote_average: item.voteAverage, vote_count: item.voteCount,
        popularity: item.popularity, score: item.score,
      })),
      generatedAt: new Date().toISOString(),
    };
    await saveToCache(cacheEndpoint, cacheParams, response, 12);
    return response;
  } catch (error) {
    // This survives a changed rolling date range: the prepared list has a
    // fixed cache key, so yesterday's successful list remains a fallback.
    const stale = await getFromCache(cacheEndpoint, cacheParams, { allowExpired: true });
    if (stale) return stale;
    throw error;
  }
}

// Детали фильма (возвращает raw TMDB JSON — совместимость с фронтом)
async function getMovieDetails(id) {
  // 1. Проверяем БД — если есть, отдаём data (JSONB)
  const cached = await getMediaMetadata(id, 'movie');
  if (cached) {
    const enriched = await ensureCachedImdbMetadata(cached, id, 'movie');
    return mergeImdbMetadata(enriched.data, enriched);
  }

  // 2. Нет в БД — качаем из TMDB
  try {
    const data = await tmdbRequest(`/movie/${id}`, { append_to_response: 'credits,similar,keywords,external_ids' });
    // Сохраняем навсегда (включая нормализованные поля)
    await saveMediaMetadata(id, 'movie', data);
    return mergeImdbMetadata(data, await getMediaMetadata(id, 'movie'));
  } catch (err) {
    // TMDB недоступен — пробуем отдать хоть что-то из кэша API
    const fallback = await getFromCache(`/movie/${id}`, localizedCacheParams({ append_to_response: 'credits,similar,keywords,external_ids' }));
    if (fallback) return fallback;
    throw err;
  }
}

// Детали сериала (возвращает raw TMDB JSON — совместимость с фронтом)
async function getTvDetails(id) {
  // 1. Проверяем БД — если есть, отдаём data (JSONB)
  const cached = await getMediaMetadata(id, 'tv');
  if (cached) {
    const enriched = await ensureCachedImdbMetadata(cached, id, 'tv');
    return mergeImdbMetadata(enriched.data, enriched);
  }

  // 2. Нет в БД — качаем из TMDB
  try {
    const data = await tmdbRequest(`/tv/${id}`, { append_to_response: 'credits,similar,keywords,external_ids' });
    // Сохраняем навсегда (включая нормализованные поля)
    await saveMediaMetadata(id, 'tv', data);
    return mergeImdbMetadata(data, await getMediaMetadata(id, 'tv'));
  } catch (err) {
    // TMDB недоступен — пробуем отдать хоть что-то из кэша API
    const fallback = await getFromCache(`/tv/${id}`, localizedCacheParams({ append_to_response: 'credits,similar,keywords,external_ids' }));
    if (fallback) return fallback;
    throw err;
  }
}

async function getReviews(mediaType, id) {
  if (!['movie', 'tv'].includes(mediaType)) throw new Error(`Неподдерживаемый тип медиа: ${mediaType}`);
  const endpoint = `/${mediaType}/${id}/reviews`;
  const localized = await tmdbRequest(endpoint, { page: 1 });
  if (localized?.results?.length) return { ...localized, language: TMDB_LOCALE };

  // TMDB often has no Russian review for a title. Fall back to the original
  // English reviews instead of rendering an empty section.
  const fallback = await tmdbRequest(endpoint, { page: 1, language: 'en-US' });
  return { ...fallback, language: 'en-US' };
}

async function ensureLocalizedMetadata(tmdbId, mediaType) {
  const existing = await getMediaMetadata(tmdbId, mediaType);
  if (existing) return existing.data;
  return mediaType === 'movie' ? getMovieDetails(tmdbId) : getTvDetails(tmdbId);
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
  return tmdbRequest(`/person/${id}`, { append_to_response: 'external_ids' });
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
  getRussianNew,
  getMovieDetails,
  getTvDetails,
  getReviews,
  ensureLocalizedMetadata,
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
  __test: { russianNewScore, normalizeRussianNew, sixMonthsAgo },
};
