const express = require('express');
const router = express.Router();
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
  params.push(limit);
  const { rows } = await require('../../db/database').query(`
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

async function getMetadataById(id) {
  const { rows } = await require('../../db/database').query('SELECT * FROM media_metadata WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getMetadataByTmdb(tmdbId, type) {
  const { rows } = await require('../../db/database').query('SELECT * FROM media_metadata WHERE tmdb_id = $1 AND media_type = $2', [tmdbId, type]);
  return rows[0] || null;
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

// GET /api/v1/watchlist — list all want_to_watch items with media metadata
router.get('/', asyncRoute(async (req, res) => {
  const items = await ListItemModel.findAllWithMetadata(req.user.id, { status: 'want_to_watch' });
  const mapped = items.map(item => ({ ...rowToMedia({ ...item, data: item.details }), list_item_id: item.id, added_at: item.added_at }));
  res.json({ items: mapped });
}));

// POST /api/v1/watchlist — add item (accept tmdb_id or title for search)
router.post('/', asyncRoute(async (req, res) => {
  const { tmdb_id, media_type, title, media_id } = req.body;

  // Resolve media — by tmdb_id, media_id, or title search
  let media;
  if (tmdb_id || media_id) {
    media = await resolveMedia({ tmdb_id: tmdb_id ? Number(tmdb_id) : undefined, media_type, media_id: media_id ? Number(media_id) : undefined });
  } else if (title) {
    media = await resolveMedia({ title, media_type });
  } else {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Provide tmdb_id with media_type, media_id, or title');
  }

  // Check for duplicates — 409 if already want_to_watch
  const existing = await ListItemModel.findByTmdb(req.user.id, media.tmdb_id, media.media_type);
  if (existing && existing.status === 'want_to_watch') {
    throw new ApiError(409, 'ALREADY_IN_WATCHLIST', 'Item is already in your watchlist');
  }

  // If watched, move back to want_to_watch
  if (existing && existing.status === 'watched') {
    await ListItemModel.update(existing.id, { status: 'want_to_watch' });
  } else if (!existing) {
    await ListItemModel.create(req.user.id, { tmdb_id: media.tmdb_id, media_type: media.media_type, status: 'want_to_watch' });
  }

  await Promise.all([
    ListItemModel.invalidateRecommendations(req.user.id),
    tasteProfile.invalidate(req.user.id),
  ]);
  scheduleGeneration(req.user.id);

  const item = await ListItemModel.findByTmdb(req.user.id, media.tmdb_id, media.media_type);
  res.status(201).json({ item: { ...rowToMedia(media), list_item_id: item.id, added_at: item.added_at } });
}));

// DELETE /api/v1/watchlist/:id — remove from list
router.delete('/:id', asyncRoute(async (req, res) => {
  const itemId = integer(req.params.id, 'id', { optional: false });
  const item = await ListItemModel.findById(itemId);
  if (!item || item.user_id !== req.user.id) {
    throw new ApiError(404, 'WATCHLIST_ITEM_NOT_FOUND', 'Watchlist item not found');
  }
  if (item.status !== 'want_to_watch') {
    throw new ApiError(404, 'WATCHLIST_ITEM_NOT_FOUND', 'Watchlist item not found');
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
