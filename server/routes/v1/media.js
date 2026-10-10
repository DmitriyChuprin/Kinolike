/**
 * GET /api/v1/media/:id
 *
 * Full media details from media_metadata, including the current user's
 * list status (watched, rating, watched_at).
 */
const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const ListItemModel = require('../../models/listItem');
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

function mediaType(value) {
  if (value == null || value === '') return null;
  if (!['movie', 'tv'].includes(value)) throw new ApiError(422, 'VALIDATION_ERROR', 'media_type must be movie or tv');
  return value;
}

async function getMetadataByTmdb(tmdbId, type) {
  const params = [tmdbId];
  let sql = 'SELECT * FROM media_metadata WHERE tmdb_id = $1';
  if (type) {
    params.push(type);
    sql += ' AND media_type = $2';
  }
  const { rows } = await db.query(sql, params);
  return rows;
}

// tmdbService throws plain Error('TMDB API ошибка: 404') — no .status property
function isTmdbNotFound(err) {
  return /TMDB API.*404/.test(err && err.message ? err.message : '');
}

// Fetch media from TMDB (movie first when type unknown), map 404 → ApiError
async function fetchFromTmdb(tmdbId, type) {
  try {
    if (type === 'movie') {
      await tmdbService.getMovieDetails(tmdbId);
    } else if (type === 'tv') {
      await tmdbService.getTvDetails(tmdbId);
    } else {
      try {
        await tmdbService.getMovieDetails(tmdbId);
      } catch (err) {
        if (!isTmdbNotFound(err)) throw err;
        await tmdbService.getTvDetails(tmdbId);
      }
    }
  } catch (err) {
    if (isTmdbNotFound(err)) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Media not found');
    throw err;
  }
}

function rowToMedia(row) {
  const data = row.data || {};
  const genres = Array.isArray(data.genres)
    ? data.genres.map(g => g.name || g).filter(Boolean)
    : [];
  const directors = row.directors || [];
  const actors = row.actors || [];
  const date = data.release_date || data.first_air_date || '';
  return {
    tmdb_id: Number(row.tmdb_id || data.id),
    media_type: row.media_type || data.media_type || 'movie',
    title: data.title || data.name || row.title || '',
    original_title: data.original_title || data.original_name || null,
    year: Number(row.release_year || String(date).slice(0, 4)) || null,
    overview: data.overview || row.overview || '',
    poster_url: posterUrl(data.poster_path || row.poster_path),
    backdrop_url: data.backdrop_path ? posterUrl(data.backdrop_path) : null,
    rating: Number(data.vote_average) || null,
    vote_count: Number(data.vote_count) || 0,
    popularity: Number(data.popularity) || 0,
    runtime: Number(data.runtime || (Array.isArray(data.episode_run_time) ? data.episode_run_time[0] : 0)) || null,
    genres,
    directors: directors.map(d => d.name || d),
    actors: actors.slice(0, 15).map(a => ({
      name: a.name,
      character: a.character_name || null,
      order: a.sort_order ?? 0,
    })),
    imdb_id: row.imdb_id || null,
    imdb_rating: row.imdb_rating == null ? null : Number(row.imdb_rating),
    imdb_votes: row.imdb_votes == null ? null : Number(row.imdb_votes),
    // Additional raw data for the client
    tagline: data.tagline || null,
    status: data.status || null,
    number_of_seasons: data.number_of_seasons || null,
    number_of_episodes: data.number_of_episodes || null,
    seasons: Array.isArray(data.seasons) ? data.seasons.map(s => ({
      season_number: s.season_number,
      name: s.name,
      air_date: s.air_date,
      episode_count: s.episode_count,
    })) : null,
    networks: Array.isArray(data.networks) ? data.networks.map(n => n.name).filter(Boolean) : null,
    production_countries: Array.isArray(data.production_countries)
      ? data.production_countries.map(c => c.iso_3166_1 || c.name).filter(Boolean)
      : null,
    spoken_languages: Array.isArray(data.spoken_languages)
      ? data.spoken_languages.map(l => l.english_name || l.name).filter(Boolean)
      : null,
  };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

// Shared response builder: metadata row → full media payload with user status
async function buildMediaResponse(row, userId) {
  const { rows } = await db.query(`
    SELECT mm.*,
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
    WHERE mm.id = $1
  `, [row.id]);

  const full = rows[0] || row;
  const listItem = await ListItemModel.findByTmdb(userId, full.tmdb_id, full.media_type);
  const media = rowToMedia(full);
  return {
    ...media,
    list_status: listItem
      ? {
          status: listItem.status,
          rating: listItem.rating == null ? null : Number(listItem.rating),
          watched_at: listItem.watched_at || null,
          added_at: listItem.added_at || null,
          notes: listItem.notes || null,
        }
      : null,
  };
}

// GET /api/v1/media/by-tmdb/:tmdbId?media_type=movie|tv
// Lookup by TMDB id (what agents actually have after search). media_type is
// optional: when omitted, a unique local match is used, otherwise 409.
router.get('/by-tmdb/:tmdbId', asyncRoute(async (req, res) => {
  const userId = req.user.id;
  const tmdbId = Number(req.params.tmdbId);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'tmdbId must be a positive integer');
  }
  const type = mediaType(req.query.media_type);

  let rows = await getMetadataByTmdb(tmdbId, type);
  if (rows.length > 1) {
    throw new ApiError(409, 'AMBIGUOUS_MEDIA',
      'Several media items match this TMDB id; provide media_type',
      { candidates: rows.map(r => ({ tmdb_id: r.tmdb_id, media_type: r.media_type, title: r.title })) });
  }
  if (!rows.length) {
    await fetchFromTmdb(tmdbId, type);
    rows = await getMetadataByTmdb(tmdbId, type);
    if (rows.length > 1) {
      throw new ApiError(409, 'AMBIGUOUS_MEDIA',
        'Several media items match this TMDB id; provide media_type',
        { candidates: rows.map(r => ({ tmdb_id: r.tmdb_id, media_type: r.media_type, title: r.title })) });
    }
  }
  if (!rows.length) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Media not found');

  res.json(await buildMediaResponse(rows[0], userId));
}));

router.get('/:id', asyncRoute(async (req, res) => {
  const userId = req.user.id;
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'id must be a positive integer');
  }

  // Local id only — no TMDB fallback here (we don't know media_type from id)
  const { rows } = await db.query('SELECT * FROM media_metadata WHERE id = $1', [id]);
  const row = rows[0] || null;
  if (!row) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Media not found');

  res.json(await buildMediaResponse(row, userId));
}));

module.exports = router;
