const db = require('../db/database');
const ListItemModel = require('../models/listItem');
const RecommendationModel = require('../models/recommendation');
const tmdbService = require('./tmdb');
const tasteProfile = require('./tasteProfile');
const recommendationHistory = require('./recommendationHistory');
const { scheduleGeneration } = require('./backgroundRecommendations');
const { searchWithAI } = require('./aiSearch');
const { ApiError } = require('../api/errors');

const IMAGE_BASE = String(process.env.TMDB_IMAGE_BASE_URL || 'https://image.tmdb.org/t/p/w500').replace(/\/$/, '');
const GENRES = {
  action: { movie: 28, tv: 10759 }, adventure: { movie: 12, tv: 10759 }, animation: { movie: 16, tv: 16 },
  comedy: { movie: 35, tv: 35 }, crime: { movie: 80, tv: 80 }, documentary: { movie: 99, tv: 99 },
  drama: { movie: 18, tv: 18 }, family: { movie: 10751, tv: 10751 }, fantasy: { movie: 14, tv: 10765 },
  history: { movie: 36, tv: 18 }, horror: { movie: 27, tv: 9648 }, music: { movie: 10402, tv: 10767 },
  mystery: { movie: 9648, tv: 9648 }, romance: { movie: 10749, tv: 18 },
  'science-fiction': { movie: 878, tv: 10765 }, 'sci-fi': { movie: 878, tv: 10765 },
  thriller: { movie: 53, tv: 9648 }, war: { movie: 10752, tv: 10768 }, western: { movie: 37, tv: 37 },
};

function integer(value, field, { min = 1, max = Number.MAX_SAFE_INTEGER, optional = true } = {}) {
  if (value == null || value === '') {
    if (optional) return null;
    throw new ApiError(422, 'VALIDATION_ERROR', `${field} is required`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ApiError(422, 'VALIDATION_ERROR', `${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function numeric(value, field, { min = 0, max = 10 } = {}) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new ApiError(422, 'VALIDATION_ERROR', `${field} must be between ${min} and ${max}`);
  }
  return parsed;
}

function mediaType(value) {
  if (value == null || value === '') return null;
  if (!['movie', 'tv'].includes(value)) throw new ApiError(422, 'VALIDATION_ERROR', 'media_type must be movie or tv');
  return value;
}

function posterUrl(path) {
  return path ? `${IMAGE_BASE}${path.startsWith('/') ? '' : '/'}${path}` : null;
}

function rowToMedia(row) {
  const data = row.data || row.details || {};
  const genres = Array.isArray(data.genres) ? data.genres.map(item => item.name || item).filter(Boolean) : (row.genre_names || []);
  const date = data.release_date || data.first_air_date || '';
  return {
    id: (row.media_id ?? row.id) == null ? null : Number(row.media_id ?? row.id),
    tmdb_id: Number(row.tmdb_id || data.id),
    media_type: row.media_type || data.media_type,
    title: data.title || data.name || row.title || row.media_title || '',
    original_title: data.original_title || data.original_name || null,
    year: Number(row.release_year || String(date).slice(0, 4)) || null,
    overview: data.overview || row.overview || '',
    poster_url: posterUrl(data.poster_path || row.poster_path),
    rating: Number(data.vote_average) || null,
    vote_count: Number(data.vote_count) || 0,
    runtime: Number(data.runtime || (Array.isArray(data.episode_run_time) ? data.episode_run_time[0] : 0)) || null,
    genres,
  };
}

function normalizeTitle(value) {
  return String(value || '').trim().toLocaleLowerCase('ru-RU').replace(/[«»"']/g, '').replace(/\s+/g, ' ');
}

async function findLocalMedia(query, options = {}) {
  const q = String(query || '').trim();
  if (q.length < 2 || q.length > 200) throw new ApiError(422, 'VALIDATION_ERROR', 'q must contain 2 to 200 characters');
  const type = mediaType(options.media_type);
  const limit = integer(options.limit ?? 10, 'limit', { min: 1, max: 50, optional: false });
  const params = [`%${q}%`, q];
  let typeSql = '';
  if (type) { params.push(type); typeSql = ` AND mm.media_type = $${params.length}`; }
  let yearSql = '';
  const year = integer(options.year, 'year', { min: 1880, max: 2200 });
  if (year) { params.push(year); yearSql = ` AND mm.release_year = $${params.length}`; }
  params.push(limit);
  const { rows } = await db.query(`
    SELECT mm.*
    FROM media_metadata mm
    WHERE (mm.title ILIKE $1 OR mm.data->>'original_title' ILIKE $1 OR mm.data->>'original_name' ILIKE $1)
      ${typeSql}
      ${yearSql}
    ORDER BY CASE WHEN LOWER(mm.title) = LOWER($2) THEN 0 ELSE 1 END,
             COALESCE(mm.data->>'popularity', '0')::float DESC,
             COALESCE(mm.data->>'vote_count', '0')::int DESC
    LIMIT $${params.length}`, params);
  return rows.map(rowToMedia);
}

async function search(userId, query) { // eslint-disable-line no-unused-vars
  let items = await findLocalMedia(query.q, query);
  let source = 'local';
  if (items.length === 0 && query.tmdb_fallback !== 'false') {
    const type = mediaType(query.media_type) || 'multi';
    const result = await tmdbService.search(String(query.q).trim(), type, 1);
    items = (result.results || []).filter(item => ['movie', 'tv'].includes(item.media_type || type))
      .filter(item => !query.year || String(item.release_date || item.first_air_date || '').slice(0, 4) === String(query.year))
      .slice(0, Math.min(Number(query.limit) || 10, 50)).map(item => rowToMedia({
      id: null, tmdb_id: item.id, media_type: item.media_type || type, data: item,
    }));
    source = 'tmdb';
  }
  return { items, source };
}

async function getMetadataById(id) {
  const { rows } = await db.query('SELECT * FROM media_metadata WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getMetadataByTmdb(tmdbId, type) {
  const { rows } = await db.query('SELECT * FROM media_metadata WHERE tmdb_id = $1 AND media_type = $2', [tmdbId, type]);
  return rows[0] || null;
}

function chooseCandidate(candidates, title) {
  if (!candidates.length) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Media not found');
  const normalized = normalizeTitle(title);
  const exact = candidates.filter(item => normalizeTitle(item.title) === normalized || normalizeTitle(item.original_title) === normalized);
  const choices = exact.length ? exact : candidates;
  if (choices.length !== 1) {
    throw new ApiError(409, 'AMBIGUOUS_MEDIA', 'Several media items match the title; provide media_id or tmdb_id and media_type', { candidates: choices.slice(0, 10) });
  }
  return choices[0];
}

async function resolveMedia(input = {}) {
  const localId = integer(input.media_id, 'media_id');
  if (localId) {
    const row = await getMetadataById(localId);
    if (!row) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Media not found');
    return row;
  }

  const tmdbId = integer(input.tmdb_id, 'tmdb_id');
  const type = mediaType(input.media_type);
  if (tmdbId) {
    if (!type) throw new ApiError(422, 'VALIDATION_ERROR', 'tmdb_id and media_type must be provided together');
    let row = await getMetadataByTmdb(tmdbId, type);
    if (!row) {
      try {
        type === 'movie' ? await tmdbService.getMovieDetails(tmdbId) : await tmdbService.getTvDetails(tmdbId);
      } catch (error) {
        if (error.status === 404) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Media not found');
        throw error;
      }
      row = await getMetadataByTmdb(tmdbId, type);
    }
    if (!row) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Media not found');
    return row;
  }

  const title = String(input.title || input.query || '').trim();
  if (!title) throw new ApiError(422, 'VALIDATION_ERROR', 'Provide media_id, tmdb_id with media_type, or title');
  let candidates = await findLocalMedia(title, { media_type: type, year: input.year, limit: 10 });
  if (!candidates.length) {
    const result = await tmdbService.search(title, type || 'multi', 1);
    candidates = (result.results || []).filter(item => ['movie', 'tv'].includes(item.media_type || type))
      .filter(item => !input.year || String(item.release_date || item.first_air_date || '').slice(0, 4) === String(input.year))
      .slice(0, 10).map(item => rowToMedia({
      id: null, tmdb_id: item.id, media_type: item.media_type || type, data: item,
    }));
  }
  const selected = chooseCandidate(candidates, title);
  if (selected.id) return getMetadataById(selected.id);
  return resolveMedia({ tmdb_id: selected.tmdb_id, media_type: selected.media_type });
}

async function getMedia(userId, id) {
  const row = await getMetadataById(integer(id, 'id', { optional: false }));
  if (!row) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Media not found');
  const listItem = await ListItemModel.findByTmdb(userId, row.tmdb_id, row.media_type);
  return {
    ...rowToMedia(row),
    status: {
      watched: listItem?.status === 'watched',
      watchlist: listItem?.status === 'want_to_watch',
      rating: listItem?.rating == null ? null : Number(listItem.rating),
      watch_date: listItem?.watched_at || null,
    },
  };
}

async function getWatchlist(userId) {
  const items = await ListItemModel.findAllWithMetadata(userId, { status: 'want_to_watch' });
  return items.map(item => ({ ...rowToMedia({ ...item, data: item.details }), list_item_id: item.id, added_at: item.added_at }));
}

async function addWatchlist(userId, input) {
  const media = await resolveMedia(input);
  const existing = await ListItemModel.findByTmdb(userId, media.tmdb_id, media.media_type);
  if (existing?.status === 'watched') throw new ApiError(409, 'MEDIA_ALREADY_WATCHED', 'Media is already marked as watched');
  if (existing) await ListItemModel.update(existing.id, { status: 'want_to_watch' });
  else await ListItemModel.create(userId, { tmdb_id: media.tmdb_id, media_type: media.media_type, status: 'want_to_watch' });
  await Promise.all([RecommendationModel.clearCache(userId), tasteProfile.invalidate(userId)]);
  scheduleGeneration(userId);
  const item = await ListItemModel.findByTmdb(userId, media.tmdb_id, media.media_type);
  return { ...rowToMedia(media), list_item_id: item.id, added_at: item.added_at };
}

async function removeWatchlist(userId, mediaId) {
  const media = await getMetadataById(integer(mediaId, 'id', { optional: false }));
  if (!media) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Media not found');
  const item = await ListItemModel.findByTmdb(userId, media.tmdb_id, media.media_type);
  if (!item || item.status !== 'want_to_watch') throw new ApiError(404, 'WATCHLIST_ITEM_NOT_FOUND', 'Watchlist item not found');
  await ListItemModel.delete(item.id);
  await Promise.all([RecommendationModel.clearCache(userId), tasteProfile.invalidate(userId)]);
  scheduleGeneration(userId);
}

function validateWatchedAt(value) {
  if (value == null || value === '') return new Date().toISOString();
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(String(value)) || Number.isNaN(Date.parse(value))) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'watched_at must be an ISO date');
  }
  return value;
}

async function markWatched(userId, input) {
  const media = await resolveMedia(input);
  const rating = input.rating == null ? null : integer(input.rating, 'rating', { min: 1, max: 10, optional: false });
  let item = await ListItemModel.findByTmdb(userId, media.tmdb_id, media.media_type);
  const watchedAt = validateWatchedAt(input.watched_at ?? item?.watched_at);
  const update = { status: 'watched', watched_at: watchedAt };
  if (input.rating !== undefined) update.rating = rating;
  if (item) await ListItemModel.update(item.id, update);
  else {
    const created = await ListItemModel.create(userId, { tmdb_id: media.tmdb_id, media_type: media.media_type, status: 'watched' });
    await ListItemModel.update(created.lastInsertRowid, update);
  }
  item = await ListItemModel.findByTmdb(userId, media.tmdb_id, media.media_type);
  await db.query(`UPDATE recommendation_events SET watched_at=COALESCE(watched_at,$1), watched_rating=$2
    WHERE user_id=$3 AND tmdb_id=$4 AND media_type=$5`, [watchedAt, item.rating, userId, media.tmdb_id, media.media_type]);
  await Promise.all([RecommendationModel.clearCache(userId), tasteProfile.invalidate(userId)]);
  scheduleGeneration(userId);
  return { ...rowToMedia(media), rating: item.rating == null ? null : Number(item.rating), watched_at: item.watched_at };
}

function structuredFilters(input) {
  const type = mediaType(input.media_type);
  const genres = input.genres == null ? [] : input.genres;
  if (!Array.isArray(genres)) throw new ApiError(422, 'VALIDATION_ERROR', 'genres must be an array');
  const genreIds = genres.map(value => {
    if (/^\d+$/.test(String(value))) return Number(value);
    const definition = GENRES[String(value).toLowerCase()];
    if (!definition) throw new ApiError(422, 'VALIDATION_ERROR', `Unknown genre: ${value}`);
    return definition[type || 'movie'];
  });
  const context = input.context || {};
  if (context && (typeof context !== 'object' || Array.isArray(context))) throw new ApiError(422, 'VALIDATION_ERROR', 'context must be an object');
  const available = integer(context.available_minutes, 'context.available_minutes', { min: 1, max: 1440 });
  if (genreIds.length === 0 && String(context.watching_with || '').toLowerCase() === 'family') {
    genreIds.push(GENRES.family[type || 'movie']);
  }
  return {
    media_type: type,
    genres: genreIds.map(String),
    year_from: integer(input.year_from, 'year_from', { min: 1880, max: 2200 }),
    year_to: integer(input.year_to, 'year_to', { min: 1880, max: 2200 }),
    runtime_max: integer(input.max_runtime, 'max_runtime', { min: 1, max: 1440 }) || available,
    min_rating: numeric(input.min_rating, 'min_rating'),
    min_vote_count: integer(input.min_vote_count, 'min_vote_count', { min: 0 }),
    library_scope: input.watchlist_only === true || /(?:моего|своего)\s+списка\s+[«"]?хочу посмотреть|из\s+(?:watchlist|списка\s+[«"]?хочу посмотреть)/i.test(String(input.query || ''))
      ? 'watchlist' : input.exclude_watched === false ? 'exclude_rejected' : 'exclude_watched',
    mood: context.mood ? [String(context.mood)] : undefined,
    mini_series_only: Boolean(input.mini_series_only || (/мини[- ]?сериал/i.test(String(input.query || '')))),
    strict_filters: true,
  };
}

async function hydrateRecommendations(items) {
  if (!items.length) return [];
  const values = [];
  const tuples = items.map((item, index) => {
    values.push(item.tmdb_id, item.media_type);
    return `($${index * 2 + 1}, $${index * 2 + 2})`;
  });
  const { rows } = await db.query(`SELECT * FROM media_metadata WHERE (tmdb_id, media_type) IN (${tuples.join(',')})`, values);
  const metadata = new Map(rows.map(row => [`${row.media_type}:${row.tmdb_id}`, row]));
  return items.map(item => {
    const media = rowToMedia(metadata.get(`${item.media_type}:${item.tmdb_id}`) || { tmdb_id: item.tmdb_id, media_type: item.media_type, data: item });
    return {
      ...media,
      recommendation_score: Math.round(Math.max(0, Math.min(1, (Number(item.score) || 0) / 100)) * 1000) / 1000,
      reason: String(item.reason || 'Подобрано по вашим предпочтениям').slice(0, 400),
    };
  });
}

async function recommendations(userId, input = {}) {
  const query = String(input.query || 'Что посмотреть?').trim();
  if (!query || query.length > 500) throw new ApiError(422, 'VALIDATION_ERROR', 'query must contain up to 500 characters');
  const limit = integer(input.limit ?? 10, 'limit', { min: 1, max: 50, optional: false });
  const filters = structuredFilters(input);
  if (filters.year_from && filters.year_to && filters.year_from > filters.year_to) throw new ApiError(422, 'VALIDATION_ERROR', 'year_from must not exceed year_to');
  const result = await searchWithAI(userId, query, { limit, filters });
  const hydrated = await hydrateRecommendations(result.recommendations || []);
  await recommendationHistory.recordImpressions(userId, result.recommendations || [], { algorithm: 'hermes_v1', query });
  return { recommendations: hydrated };
}

async function preferences(userId) {
  const profile = await tasteProfile.getTasteProfile(userId);
  const { rows } = await db.query(`SELECT ul.rating, ul.tmdb_id, ul.media_type, mm.id, mm.title, mm.release_year
    FROM user_lists ul LEFT JOIN media_metadata mm ON mm.tmdb_id=ul.tmdb_id AND mm.media_type=ul.media_type
    WHERE ul.user_id=$1 AND ul.status='watched' AND ul.rating >= 8 ORDER BY ul.rating DESC, ul.watched_at DESC NULLS LAST LIMIT 40`, [userId]);
  const compact = row => ({ id: row.id == null ? null : Number(row.id), tmdb_id: row.tmdb_id, title: row.title, year: row.release_year, rating: Number(row.rating) });
  const decades = profile.favoriteDecades || [];
  const decadeValues = decades.map(item => Number(item.name)).filter(Number.isFinite);
  return {
    favorite_genres: profile.favoriteGenres || [],
    disliked_genres: profile.dislikedGenres || [],
    preferred_year_range: decadeValues.length ? { from: Math.min(...decadeValues), to: Math.max(...decadeValues) + 9 } : {},
    favorite_actors: profile.favoriteActors || [],
    favorite_directors: profile.favoriteDirectors || [],
    high_rated_movies: rows.filter(row => row.media_type === 'movie').map(compact),
    high_rated_tv: rows.filter(row => row.media_type === 'tv').map(compact),
  };
}

module.exports = {
  GENRES, integer, numeric, mediaType, rowToMedia, chooseCandidate, structuredFilters,
  search, getMedia, getWatchlist, addWatchlist, removeWatchlist, markWatched, recommendations, preferences,
};
