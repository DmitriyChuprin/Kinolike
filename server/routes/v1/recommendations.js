/**
 * POST /api/v1/recommendations
 *
 * Accept structured filters and optional context, score candidates using
 * the personal-recommendations engine (personalRecommendations.js), and
 * return ranked results with user-friendly reasons.
 */
const express = require('express');
const router = express.Router();
const db = require('../../db/database');
const ListItemModel = require('../../models/listItem');
const tmdbService = require('../../services/tmdb');
const tasteProfile = require('../../services/tasteProfile');
const { apiTokenAuth } = require('../../middleware/apiTokenAuth');
const { ApiError, asyncRoute } = require('../../api/errors');
const {
  build_user_profile,
  movie_data,
  calculate_movie_score,
  candidate_passes_thresholds,
  reason_for,
} = require('../../services/personalRecommendations');

router.use(apiTokenAuth);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const IMAGE_BASE = String(process.env.TMDB_IMAGE_BASE_URL || 'https://image.tmdb.org/t/p/w500').replace(/\/$/, '');

function posterUrl(path) {
  return path ? `${IMAGE_BASE}${path.startsWith('/') ? '' : '/'}${path}` : null;
}

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

/** Resolve TMDB genre names / IDs to numeric IDs. */
const GENRES = {
  action: { movie: 28, tv: 10759 }, adventure: { movie: 12, tv: 10759 }, animation: { movie: 16, tv: 16 },
  comedy: { movie: 35, tv: 35 }, crime: { movie: 80, tv: 80 }, documentary: { movie: 99, tv: 99 },
  drama: { movie: 18, tv: 18 }, family: { movie: 10751, tv: 10751 }, fantasy: { movie: 14, tv: 10765 },
  history: { movie: 36, tv: 18 }, horror: { movie: 27, tv: 9648 }, music: { movie: 10402, tv: 10767 },
  mystery: { movie: 9648, tv: 9648 }, romance: { movie: 10749, tv: 18 },
  'science-fiction': { movie: 878, tv: 10765 }, 'sci-fi': { movie: 878, tv: 10765 },
  thriller: { movie: 53, tv: 9648 }, war: { movie: 10752, tv: 10768 }, western: { movie: 37, tv: 37 },
};

function resolveGenreIds(genres, type) {
  if (!Array.isArray(genres)) throw new ApiError(422, 'VALIDATION_ERROR', 'genres must be an array');
  return genres.map(value => {
    if (/^\d+$/.test(String(value))) return Number(value);
    const def = GENRES[String(value).toLowerCase()];
    if (!def) throw new ApiError(422, 'VALIDATION_ERROR', `Unknown genre: ${value}`);
    return def[type || 'movie'];
  });
}

/**
 * Build TMDB Discover params from the structured filters supplied by the
 * caller, then fetch candidates for both movie and TV (or one type).
 */
async function fetchCandidates(filters, excludeIds) {
  const discoverParams = {
    page: 1,
    'vote_count.gte': filters.min_vote_count || 300,
    sort_by: 'popularity.desc',
  };
  if (filters.genres.length) discoverParams.with_genres = filters.genres.join(',');
  if (filters.year_from) discoverParams['primary_release_date.gte'] = `${filters.year_from}-01-01`;
  if (filters.year_to) discoverParams['primary_release_date.lte'] = `${filters.year_to}-12-31`;
  if (filters.min_rating) discoverParams['vote_average.gte'] = filters.min_rating;
  if (filters.max_runtime) discoverParams['with_runtime.lte'] = filters.max_runtime;

  const types = filters.media_type ? [filters.media_type] : ['movie', 'tv'];
  const results = [];

  for (const type of types) {
    const discover = type === 'tv' ? tmdbService.discoverTv : tmdbService.discoverMovies;
    try {
      const data = await discover(discoverParams);
      for (const r of (data.results || [])) {
        if (excludeIds.has(r.id)) continue;
        const genres = (r.genre_ids || []).map(id => ({ id, name: undefined })); // names resolved later if needed
        results.push({
          tmdb_id: r.id,
          media_type: type,
          details: { ...r, genres, title: r.title || r.name },
        });
      }
    } catch (err) {
      console.error(`[v1/recommendations] Discover ${type} failed:`, err.message);
    }
  }

  // Fetch a second page for variety
  for (const type of types) {
    const discover = type === 'tv' ? tmdbService.discoverTv : tmdbService.discoverMovies;
    try {
      const data = await discover({ ...discoverParams, page: 2 });
      for (const r of (data.results || [])) {
        if (excludeIds.has(r.id)) continue;
        const genres = (r.genre_ids || []).map(id => ({ id, name: undefined }));
        results.push({
          tmdb_id: r.id,
          media_type: type,
          details: { ...r, genres, title: r.title || r.name },
        });
      }
    } catch (err) {
      console.error(`[v1/recommendations] Discover ${type} page 2 failed:`, err.message);
    }
  }

  return results;
}

/** Fetch full details for a batch of candidates (for scoring). */
async function enrichCandidates(candidates) {
  const enriched = [];
  // Process in batches of 5 to avoid hammering TMDB
  for (let i = 0; i < candidates.length; i += 5) {
    const batch = candidates.slice(i, i + 5);
    const results = await Promise.allSettled(
      batch.map(async (c) => {
        const getDetails = c.media_type === 'tv' ? tmdbService.getTvDetails : tmdbService.getMovieDetails;
        const details = await getDetails(c.tmdb_id);
        return { ...c, details };
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled') enriched.push(r.value);
    }
  }
  return enriched;
}

/**
 * Translate a raw personal-recommendation score into a user-friendly reason
 * string that mentions genres, similar titles, or other signals.
 */
function friendlyReason(rawReason, tasteProfile) {
  if (!rawReason) return 'Подобрано по вашим предпочтениям';
  // The reason_for() function already produces a Russian-language string.
  return String(rawReason).slice(0, 400);
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

router.post('/', asyncRoute(async (req, res) => {
  const userId = req.user.id;
  const input = req.body || {};

  // Validate query
  const query = String(input.query || '').trim();
  if (query.length > 500) throw new ApiError(422, 'VALIDATION_ERROR', 'query must contain up to 500 characters');

  const limit = integer(input.limit ?? 10, 'limit', { min: 1, max: 50, optional: false });
  const type = mediaType(input.media_type);

  // Parse genre filter
  const genreIds = input.genres ? resolveGenreIds(input.genres, type) : [];

  const yearFrom = integer(input.year_from, 'year_from', { min: 1880, max: 2200 });
  const yearTo = integer(input.year_to, 'year_to', { min: 1880, max: 2200 });
  if (yearFrom && yearTo && yearFrom > yearTo) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'year_from must not exceed year_to');
  }

  const maxRuntime = integer(input.max_runtime, 'max_runtime', { min: 1, max: 1440 });
  const minRating = input.min_rating == null ? null : Number(input.min_rating);
  const minVoteCount = integer(input.min_vote_count, 'min_vote_count', { min: 0 });
  const watchlistOnly = Boolean(input.watchlist_only);
  const excludeWatched = input.exclude_watched !== false; // default true

  const context = input.context && typeof input.context === 'object' && !Array.isArray(input.context)
    ? input.context
    : {};

  // ------------------------------------------------------------------
  // 1. Determine exclusion set (watched / want_to_watch / not_interested)
  // ------------------------------------------------------------------
  const [watchedRaw, wantToWatch, notInterested] = await Promise.all([
    ListItemModel.findAllWithMetadata(userId, { status: 'watched' }),
    ListItemModel.findAll(userId, { status: 'want_to_watch' }),
    ListItemModel.findAll(userId, { status: 'not_interested' }),
  ]);

  const watched = watchedRaw.filter(i => i.details);
  const excludeIds = new Set([
    ...watchedRaw.map(i => i.tmdb_id),
    ...wantToWatch.map(i => i.tmdb_id),
    ...notInterested.map(i => i.tmdb_id),
  ]);

  // ------------------------------------------------------------------
  // 2. Build user taste profile
  // ------------------------------------------------------------------
  const profile = build_user_profile(watched);
  const hasProfile = profile.isSufficient;

  // ------------------------------------------------------------------
  // 3. Fetch candidates from TMDB Discover
  // ------------------------------------------------------------------
  let candidates = await fetchCandidates(
    {
      media_type: type,
      genres: genreIds,
      year_from: yearFrom,
      year_to: yearTo,
      min_rating: minRating || undefined,
      min_vote_count: minVoteCount || undefined,
      max_runtime: maxRuntime,
    },
    excludeIds
  );

  // ------------------------------------------------------------------
  // 4. Enrich candidates with full metadata (for scoring)
  // ------------------------------------------------------------------
  if (hasProfile && candidates.length > 0) {
    candidates = await enrichCandidates(candidates);
  }

  // ------------------------------------------------------------------
  // 5. Filter by structured filters that Discover didn't handle
  // ------------------------------------------------------------------
  candidates = candidates.filter(c => {
    const data = c.details || {};
    const runtime = Number(data.runtime || (Array.isArray(data.episode_run_time) ? data.episode_run_time[0] : 0));
    if (maxRuntime && runtime > 0 && runtime > maxRuntime) return false;
    if (watchlistOnly) {
      // Only include items the user has in their want_to_watch list
      if (!wantToWatch.some(w => w.tmdb_id === c.tmdb_id)) return false;
    }
    return true;
  });

  // ------------------------------------------------------------------
  // 6. Score and rank
  // ------------------------------------------------------------------
  let scored = [];
  if (hasProfile) {
    scored = candidates.map(c => {
      const candidate = movie_data(c);
      if (!candidate_passes_thresholds(candidate, {})) return null;
      const { score, components } = calculate_movie_score(candidate, profile, context);
      const reasonData = reason_for(candidate, profile);
      return {
        candidate,
        score,
        components,
        ...reasonData,
      };
    }).filter(Boolean);

    scored.sort((a, b) => (b.score || 0) - (a.score || 0));
  } else {
    // No profile — fall back to popularity-based ranking
    scored = candidates.map(c => {
      const data = c.details || {};
      const popularity = Number(data.popularity) || 0;
      const rating = Number(data.vote_average) || 0;
      const votes = Number(data.vote_count) || 0;
      const score = Math.round(Math.min(100, (rating * 5) + (Math.log1p(votes) / Math.log1p(10000) * 30) + (Math.log1p(popularity) / Math.log1p(100) * 20)));
      return {
        candidate: movie_data(c),
        score,
        reason: 'Популярный выбор',
        matched_movies: [],
        structured_reasons: {},
      };
    });
    scored.sort((a, b) => b.score - a.score);
  }

  // ------------------------------------------------------------------
  // 7. Apply diversity (limit per genre, vary directors)
  // ------------------------------------------------------------------
  const selected = [];
  const genreCount = new Map();
  const directors = new Set();
  for (const item of scored) {
    const genres = [...(item.candidate.genres || [])];
    const primaryGenre = genres[0];
    const director = [...(item.candidate.directors || [])][0];
    const crowded = primaryGenre && (genreCount.get(primaryGenre) || 0) >= 3;
    if ((crowded || (director && directors.has(director))) && selected.length >= Math.ceil(limit / 2)) continue;
    selected.push(item);
    if (primaryGenre) genreCount.set(primaryGenre, (genreCount.get(primaryGenre) || 0) + 1);
    if (director) directors.add(director);
    if (selected.length >= limit) break;
  }

  // ------------------------------------------------------------------
  // 8. Format response
  // ------------------------------------------------------------------
  const recommendations = selected.map(item => {
    const c = item.candidate;
    const data = c.raw || c.details || {};
    const date = data.release_date || data.first_air_date || '';
    const year = Number(c.year || String(date).slice(0, 4)) || null;
    const genres = Array.isArray(data.genres)
      ? data.genres.map(g => g.name || g).filter(Boolean)
      : (c.genreNames ? [...c.genreNames.values()] : []);

    return {
      tmdb_id: c.movie_id || c.tmdb_id,
      title: c.title || data.title || data.name || '',
      year,
      overview: data.overview || '',
      poster_url: posterUrl(data.poster_path),
      rating: Number(data.vote_average) || null,
      vote_count: Number(data.vote_count) || 0,
      runtime: Number(data.runtime || (Array.isArray(data.episode_run_time) ? data.episode_run_time[0] : 0)) || null,
      media_type: c.media_type || 'movie',
      genres,
      recommendation_score: Math.round(Math.max(0, Math.min(1, (item.score || 0) / 100)) * 1000) / 1000,
      reason: friendlyReason(item.reason, null),
    };
  });

  res.json({ recommendations });
}));

module.exports = router;
