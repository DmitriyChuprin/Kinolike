/**
 * GET /api/v1/search?q=...
 *
 * Search local media_metadata first, fall back to TMDB when the local
 * results are thin. Returns a flat list with media_type, title, year,
 * poster_url, overview, and tmdb_id.
 */
const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const tmdbService = require('../../services/tmdb');
const { apiTokenAuth } = require('../../middleware/apiTokenAuth');
const { ApiError, asyncRoute } = require('../../api/errors');

router.use(apiTokenAuth);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const IMAGE_BASE = String(process.env.TMDB_IMAGE_BASE_URL || 'https://image.tmdb.org/t/p/w500').replace(/\/$/, '');

function posterUrl(path) {
  return path ? `${IMAGE_BASE}${path.startsWith('/') ? '' : '/'}${path}` : null;
}

function integer(value, field, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null || value === '') return null;
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

function rowToMedia(row) {
  const data = row.data || row.details || {};
  const genres = Array.isArray(data.genres)
    ? data.genres.map(g => g.name || g).filter(Boolean)
    : (row.genre_names || []);
  const date = data.release_date || data.first_air_date || '';
  return {
    tmdb_id: Number(row.tmdb_id || data.id),
    media_type: row.media_type || data.media_type || 'movie',
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

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

router.get('/', asyncRoute(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) throw new ApiError(422, 'VALIDATION_ERROR', 'q must contain at least 2 characters');
  if (q.length > 200) throw new ApiError(422, 'VALIDATION_ERROR', 'q must contain at most 200 characters');

  const limit = integer(req.query.limit ?? 10, 'limit', { min: 1, max: 50 }) || 10;
  const type = mediaType(req.query.media_type);
  const year = integer(req.query.year, 'year', { min: 1880, max: 2200 });

  // ------------------------------------------------------------------
  // 1. Search local media_metadata
  // ------------------------------------------------------------------
  const params = [`%${q}%`, q];
  let typeSql = '';
  if (type) {
    params.push(type);
    typeSql = ` AND mm.media_type = $${params.length}`;
  }
  let yearSql = '';
  if (year) {
    params.push(year);
    yearSql = ` AND mm.release_year = $${params.length}`;
  }
  params.push(limit);

  const { rows: localRows } = await db.query(`
    SELECT mm.*,
           COALESCE(
             (SELECT json_agg(g.name ORDER BY g.name)
              FROM media_genres mg JOIN genres g ON g.id = mg.genre_id
              WHERE mg.media_metadata_id = mm.id),
             '[]'::json
           ) as genre_names
    FROM media_metadata mm
    WHERE (mm.title ILIKE $1 OR mm.data->>'original_title' ILIKE $1 OR mm.data->>'original_name' ILIKE $1)
      ${typeSql}
      ${yearSql}
    ORDER BY CASE WHEN LOWER(mm.title) = LOWER($2) THEN 0 ELSE 1 END,
             COALESCE(mm.data->>'popularity', '0')::float DESC,
             COALESCE(mm.data->>'vote_count', '0')::int DESC
    LIMIT $${params.length}
  `, params);

  let items = localRows.map(rowToMedia);
  let source = 'local';

  // ------------------------------------------------------------------
  // 2. Fall back to TMDB when local results are thin
  // ------------------------------------------------------------------
  if (items.length < Math.min(3, limit) && req.query.tmdb_fallback !== 'false') {
    const searchType = type || 'multi';
    const result = await tmdbService.search(q, searchType, 1);
    const tmdbItems = (result.results || [])
      .filter(item => ['movie', 'tv'].includes(item.media_type || searchType))
      .filter(item => {
        if (!year) return true;
        const date = item.release_date || item.first_air_date || '';
        return String(date).slice(0, 4) === String(year);
      })
      .slice(0, Math.min(limit, 50))
      .map(item => rowToMedia({
        tmdb_id: item.id,
        media_type: item.media_type || searchType,
        data: item,
      }));

    // Merge: keep local items first, append unique TMDB results
    const seen = new Set(items.map(i => `${i.media_type}:${i.tmdb_id}`));
    for (const item of tmdbItems) {
      const key = `${item.media_type}:${item.tmdb_id}`;
      if (!seen.has(key)) {
        items.push(item);
        seen.add(key);
      }
    }
    source = items.length > localRows.length ? 'tmdb' : 'local';
  }

  res.json({ items, source });
}));

module.exports = router;
