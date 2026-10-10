const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const ListItemModel = require('../../models/listItem');
const tmdbService = require('../../services/tmdb');
const tasteProfile = require('../../services/tasteProfile');
const { scheduleGeneration } = require('../../services/backgroundRecommendations');
const { ApiError, asyncRoute } = require('../../api/errors');

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

function mediaType(value) {
  if (value == null || value === '') return null;
  if (!['movie', 'tv'].includes(value)) throw new ApiError(422, 'VALIDATION_ERROR', 'media_type must be movie or tv');
  return value;
}

function normalizeTitle(value) {
  return String(value || '').trim().toLocaleLowerCase('ru-RU').replace(/[«»"']/g, '').replace(/\s+/g, ' ');
}

const IMAGE_BASE = String(process.env.TMDB_IMAGE_BASE_URL || 'https://image.tmdb.org/t/p/w500').replace(/\/$/, '');

function posterUrl(path) {
  return path ? `${IMAGE_BASE}${path.startsWith('/') ? '' : '/'}${path}` : null;
}

function rowToMedia(row) {
  const data = row.data || row.details || {};
  const genres = Array.isArray(data.genres) ? data.genres.map(g => g.name || g).filter(Boolean) : (row.genre_names || []);
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

async function getMetadataById(id) {
  const { rows } = await db.query('SELECT * FROM media_metadata WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getMetadataByTmdb(tmdbId, type) {
  const { rows } = await db.query('SELECT * FROM media_metadata WHERE tmdb_id = $1 AND media_type = $2', [tmdbId, type]);
  return rows[0] || null;
}

async function findLocalMedia(query, options = {}) {
  const q = String(query || '').trim();
  if (q.length < 2 || q.length > 200) throw new ApiError(422, 'VALIDATION_ERROR', 'q must contain 2 to 200 characters');
  const type = mediaType(options.media_type);
  const limit = integer(options.limit ?? 10, 'limit', { min: 1, max: 50, optional: false });
  const params = [`%${q}%`, q];
  let typeSql = '';
  if (type) { params.push(type); typeSql = ` AND mm.media_type = $${params.length}`; }
  params.push(limit);
  const { rows } = await db.query(`
    SELECT mm.*
    FROM media_metadata mm
    WHERE (mm.title ILIKE $1 OR mm.data->>'original_title' ILIKE $1 OR mm.data->>'original_name' ILIKE $1)
      ${typeSql}
    ORDER BY CASE WHEN LOWER(mm.title) = LOWER($2) THEN 0 ELSE 1 END,
             COALESCE(mm.data->>'popularity', '0')::float DESC,
             COALESCE(mm.data->>'vote_count', '0')::int DESC
    LIMIT $${params.length}`, params);
  return rows.map(rowToMedia);
}

function chooseCandidate(candidates, title) {
  if (!candidates.length) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Media not found');
  const normalized = normalizeTitle(title);
  const exact = candidates.filter(c => normalizeTitle(c.title) === normalized || normalizeTitle(c.original_title) === normalized);
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
  let candidates = await findLocalMedia(title, { media_type: type, limit: 10 });
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

function validateWatchedAt(value) {
  if (value == null || value === '') return new Date().toISOString();
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(String(value)) || Number.isNaN(Date.parse(value))) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'watched_at must be an ISO date');
  }
  return value;
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

// GET /api/v1/watched — list all watched items with ratings
router.get('/', asyncRoute(async (req, res) => {
  const rows = await loadWatchedItems(req.user.id, req.query);
  const items = rows.map(item => ({
    ...rowToMedia({ ...item, data: item.details }),
    list_item_id: item.id,
    user_rating: item.rating == null ? null : Number(item.rating),
    notes: item.notes || null,
    watched_at: item.watched_at || null,
    added_at: item.added_at,
  }));
  res.json({ items });
}));

// POST /api/v1/watched — mark as watched with rating
router.post('/', asyncRoute(async (req, res) => {
  const { tmdb_id, media_id, media_type, rating, watched_at, notes } = req.body;

  // Resolve media
  const media = await resolveMedia({ tmdb_id: tmdb_id ? Number(tmdb_id) : undefined, media_id: media_id ? Number(media_id) : undefined, media_type, title: req.body.title });

  // Validate rating
  const userRating = rating == null ? null : integer(rating, 'rating', { min: 1, max: 10, optional: false });
  const watchedAt = validateWatchedAt(watched_at);

  // Check if item exists in list
  let item = await ListItemModel.findByTmdb(req.user.id, media.tmdb_id, media.media_type);

  const updateFields = { status: 'watched', watched_at: watchedAt };
  if (rating !== undefined) updateFields.rating = userRating;
  if (notes !== undefined) updateFields.notes = notes;

  if (item) {
    // Update existing entry
    await ListItemModel.update(item.id, updateFields);
  } else {
    // Create new entry
    const created = await ListItemModel.create(req.user.id, { tmdb_id: media.tmdb_id, media_type: media.media_type, status: 'watched' });
    await ListItemModel.update(created.lastInsertRowid, updateFields);
  }

  // Refresh the item
  item = await ListItemModel.findByTmdb(req.user.id, media.tmdb_id, media.media_type);

  // Update recommendation events
  await db.query(`UPDATE recommendation_events SET watched_at=COALESCE(watched_at,$1), watched_rating=$2
    WHERE user_id=$3 AND tmdb_id=$4 AND media_type=$5`, [watchedAt, item.rating, req.user.id, media.tmdb_id, media.media_type]);

  await Promise.all([
    ListItemModel.invalidateRecommendations(req.user.id),
    tasteProfile.invalidate(req.user.id),
  ]);
  scheduleGeneration(req.user.id);

  res.status(201).json({
    item: {
      ...rowToMedia(media),
      list_item_id: item.id,
      user_rating: item.rating == null ? null : Number(item.rating),
      notes: item.notes || null,
      watched_at: item.watched_at || null,
    },
  });
}));

// PUT /api/v1/watched/:id — update rating/notes
router.put('/:id', asyncRoute(async (req, res) => {
  const itemId = integer(req.params.id, 'id', { optional: false });
  const item = await ListItemModel.findById(itemId);
  if (!item || item.user_id !== req.user.id) {
    throw new ApiError(404, 'WATCHED_ITEM_NOT_FOUND', 'Watched item not found');
  }

  const { rating, notes, watched_at } = req.body;
  const updateFields = {};
  if (rating !== undefined) updateFields.rating = rating == null ? null : integer(rating, 'rating', { min: 1, max: 10, optional: false });
  if (notes !== undefined) updateFields.notes = notes;
  if (watched_at !== undefined) updateFields.watched_at = watched_at ? validateWatchedAt(watched_at) : null;

  if (Object.keys(updateFields).length > 0) {
    await ListItemModel.update(itemId, updateFields);
  }

  // If rating changed, update recommendation events and invalidate cache
  if (rating !== undefined) {
    const refreshed = await ListItemModel.findById(itemId);
    await db.query(`UPDATE recommendation_events SET watched_rating=$1
      WHERE user_id=$2 AND tmdb_id=$3 AND media_type=$4`, [refreshed.rating, req.user.id, item.tmdb_id, item.media_type]);
    await Promise.all([
      ListItemModel.invalidateRecommendations(req.user.id),
      tasteProfile.invalidate(req.user.id),
    ]);
    scheduleGeneration(req.user.id);
  }

  const updated = await ListItemModel.findById(itemId);
  res.json({
    item: {
      id: updated.id,
      tmdb_id: updated.tmdb_id,
      media_type: updated.media_type,
      user_rating: updated.rating == null ? null : Number(updated.rating),
      notes: updated.notes || null,
      watched_at: updated.watched_at || null,
      updated_at: updated.updated_at,
    },
  });
}));

// DELETE /api/v1/watched/:id — remove from list
router.delete('/:id', asyncRoute(async (req, res) => {
  const itemId = integer(req.params.id, 'id', { optional: false });
  const item = await ListItemModel.findById(itemId);
  if (!item || item.user_id !== req.user.id) {
    throw new ApiError(404, 'WATCHED_ITEM_NOT_FOUND', 'Watched item not found');
  }

  await ListItemModel.delete(itemId);
  await Promise.all([
    ListItemModel.invalidateRecommendations(req.user.id),
    tasteProfile.invalidate(req.user.id),
  ]);
  scheduleGeneration(req.user.id);

  res.status(204).end();
}));

module.exports = router;
