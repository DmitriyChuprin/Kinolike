#!/usr/bin/env node
/**
 * Kinolike MCP Server v2.1
 *
 * Wraps the Kinolike REST API v1 as MCP tools for Hermes Agent.
 * Uses API token authentication (no login required).
 *
 * Env vars:
 *   KINOLIKE_URL   — base URL (default: http://localhost:3001)
 *   KINOLIKE_TOKEN — API bearer token (required)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// ── Config ──────────────────────────────────────────────────────────────
const BASE_URL = process.env.KINOLIKE_URL || 'http://localhost:3001';
const TOKEN    = process.env.KINOLIKE_TOKEN || '';

if (!TOKEN) {
  console.error('[Kinolike MCP] KINOLIKE_TOKEN env var is required');
  process.exit(1);
}

// ── HTTP helpers ────────────────────────────────────────────────────────
const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${TOKEN}`,
};

/** API error carrying the v1 error code (VALIDATION_ERROR, ALREADY_IN_WATCHLIST, ...) */
class ApiError extends Error {
  constructor(code, message, details, status) {
    super(message);
    this.name = 'ApiError';
    this.code = code || 'UNKNOWN';
    this.details = details;
    this.status = status;
  }
}

async function apiRequest(path, { method = 'GET', body } = {}) {
  const url = new URL(path, BASE_URL);
  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data && data.error ? data.error : {};
    throw new ApiError(err.code || `HTTP_${res.status}`, err.message || `HTTP ${res.status}`, err.details, res.status);
  }
  return data;
}

const apiGet    = (path) => apiRequest(path);
const apiPost   = (path, body) => apiRequest(path, { method: 'POST', body });
const apiPut    = (path, body) => apiRequest(path, { method: 'PUT', body });
const apiDelete = (path) => apiRequest(path, { method: 'DELETE' });

// ── Media resolution helpers ────────────────────────────────────────────
/**
 * Resolve full media info by TMDB id via /api/v1/media/by-tmdb/:id.
 * media_type optional — server resolves it (409 AMBIGUOUS_MEDIA if collision).
 * Returns the media object (includes media_type and list_status).
 */
async function resolveByTmdb(tmdbId, mediaType) {
  const qs = mediaType ? `?media_type=${encodeURIComponent(mediaType)}` : '';
  return apiGet(`/api/v1/media/by-tmdb/${tmdbId}${qs}`);
}

/** Format 409 AMBIGUOUS_MEDIA candidates for the agent. */
function ambiguousText(e) {
  const candidates = (e.details && e.details.candidates) || [];
  const list = candidates.map((c, i) =>
    `${i + 1}. ${c.title || `TMDB #${c.tmdb_id}`} — TMDB #${c.tmdb_id} [${c.media_type}]`
  ).join('\n');
  return `Several media items match. Which one?\n\n${list}\n\nReply with the number or TMDB ID + media_type.`;
}

/**
 * Resolve {tmdb_id, media_type} from tool args before calling POST endpoints.
 * Accepts: tmdb_id (+optional media_type), or title (+optional media_type).
 */
async function resolveMediaArgs({ tmdb_id, title, media_type }) {
  if (tmdb_id) {
    const media = await resolveByTmdb(tmdb_id, media_type);
    return { tmdb_id: media.tmdb_id, media_type: media.media_type, media };
  }
  // Title path: search local+TMDB via v1 search
  const qs = new URLSearchParams({ q: title, limit: '5' });
  if (media_type) qs.set('media_type', media_type);
  const search = await apiGet(`/api/v1/search?${qs.toString()}`);
  const items = search.items || [];
  if (items.length === 0) return { notFound: title };
  if (items.length > 1) return { ambiguous: items };
  return { tmdb_id: items[0].tmdb_id, media_type: items[0].media_type };
}

function candidatesText(items) {
  const list = items.map((m, i) =>
    `${i + 1}. ${m.title} (${m.year || '?'}) — TMDB #${m.tmdb_id} [${m.media_type}]`
  ).join('\n');
  return `Found multiple matches. Which one?\n\n${list}\n\nReply with the number or TMDB ID + media_type.`;
}

// ── Formatting helpers ──────────────────────────────────────────────────
function fmtMedia(item) {
  const title = item.title || item.name || `TMDB #${item.tmdb_id}`;
  const year = item.year || '';
  const rating = item.rating ? `${item.rating}` : item.vote_average ? item.vote_average.toFixed(1) : '—';
  const genres = (item.genres || []).map(g => typeof g === 'string' ? g : g.name).join(', ');
  const overview = item.overview || '';
  return [
    `**${title}**${year ? ` (${year})` : ''}`,
    `TMDB ID: ${item.tmdb_id} | Type: ${item.media_type || 'movie'}`,
    `Rating: ${rating} | Genres: ${genres || '—'}`,
    item.recommendation_score ? `Score: ${(item.recommendation_score * 100).toFixed(0)}%` : '',
    item.reason ? `Reason: ${item.reason}` : '',
    overview ? `Overview: ${overview.slice(0, 300)}` : '',
  ].filter(Boolean).join('\n');
}

function fmtListItem(item, { status } = {}) {
  const title = item.title || item.details?.title || item.details?.name || `TMDB #${item.tmdb_id}`;
  const year = item.year || (item.details?.release_date || item.details?.first_air_date || '').slice(0, 4);
  const myRating = item.user_rating != null ? `${item.user_rating}/10` : '—';
  const st = status || item.status || '—';
  const id = item.list_item_id ?? item.id;
  const type = item.media_type ? ` [${item.media_type}]` : '';
  return `• ${title}${year ? ` (${year})` : ''}${type} — status: ${st}, my rating: ${myRating}, item_id: ${id}`;
}

/** Format a tool-level error result (never throws). */
function errorResult(e) {
  if (e instanceof ApiError) {
    if (e.code === 'ALREADY_IN_WATCHLIST') {
      return { content: [{ type: 'text', text: 'Already in your watchlist.' }], isError: true };
    }
    if (e.code === 'AMBIGUOUS_MEDIA') {
      return { content: [{ type: 'text', text: ambiguousText(e) }] };
    }
    if (e.code === 'MEDIA_NOT_FOUND') {
      return { content: [{ type: 'text', text: 'Media not found — check the TMDB ID and media_type.' }], isError: true };
    }
    return { content: [{ type: 'text', text: `API error [${e.code}]: ${e.message}` }], isError: true };
  }
  return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
}

// ── MCP Server ──────────────────────────────────────────────────────────
const server = new McpServer({
  name: 'kinolike',
  version: '2.1.0',
});

// ── Tool: search ────────────────────────────────────────────────────────
server.tool(
  'search',
  'Search for movies and TV shows in the KinoLike database (with TMDB fallback). Returns TMDB ID and media_type for each result.',
  {
    query: z.string().describe('Search query (title, etc.)'),
    limit: z.number().optional().default(10).describe('Max results to return'),
    media_type: z.enum(['movie', 'tv']).optional().describe('Filter by type'),
  },
  async ({ query, limit, media_type }) => {
    try {
      const qs = new URLSearchParams({ q: query, limit: String(limit) });
      if (media_type) qs.set('media_type', media_type);
      const data = await apiGet(`/api/v1/search?${qs.toString()}`);
      const items = data.items || [];
      if (items.length === 0) {
        return { content: [{ type: 'text', text: `No results found for "${query}".` }] };
      }
      const list = items.map(fmtMedia).join('\n\n');
      return { content: [{ type: 'text', text: `Found ${items.length} results:\n\n${list}` }] };
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ── Tool: movie_details ─────────────────────────────────────────────────
server.tool(
  'movie_details',
  'Get detailed information about a movie or TV show by TMDB ID (includes your list status and rating)',
  {
    tmdb_id: z.number().describe('TMDB ID'),
    media_type: z.enum(['movie', 'tv']).optional().describe('movie or tv — needed only if the TMDB ID exists as both'),
  },
  async ({ tmdb_id, media_type }) => {
    try {
      const d = await resolveByTmdb(tmdb_id, media_type);
      const title = d.title || d.name || `TMDB #${tmdb_id}`;
      const year = d.year || '';
      const rating = d.rating || d.vote_average || '—';
      const genres = (d.genres || []).map(g => typeof g === 'string' ? g : g.name).join(', ');
      const status = d.list_status?.status ? `\nMy status: ${d.list_status.status}` : '';
      const myRating = d.list_status?.rating != null ? `\nMy rating: ${d.list_status.rating}/10` : '';
      const text = [
        `**${title}**${year ? ` (${year})` : ''}`,
        `TMDB ID: ${d.tmdb_id} | Type: ${d.media_type}`,
        `TMDB Rating: ${rating} | Genres: ${genres || '—'}`,
        d.runtime ? `Runtime: ${d.runtime} min` : '',
        d.number_of_seasons ? `Seasons: ${d.number_of_seasons} | Episodes: ${d.number_of_episodes}` : '',
        d.imdb_id ? `IMDb: ${d.imdb_id} (${d.imdb_rating || '—'})` : '',
        d.tagline ? `Tagline: "${d.tagline}"` : '',
        d.overview ? `\n${d.overview}` : '',
        status,
        myRating,
      ].filter(Boolean).join('\n');
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ── Tool: add_to_watchlist ──────────────────────────────────────────────
server.tool(
  'add_to_watchlist',
  'Add a movie or TV show to your "Want to watch" list. Provide tmdb_id (+optional media_type) OR title (+optional media_type).',
  {
    tmdb_id: z.number().optional().describe('TMDB ID (if known)'),
    media_type: z.enum(['movie', 'tv']).optional().describe('movie or tv — auto-detected from TMDB if omitted'),
    title: z.string().optional().describe('Title to search (if tmdb_id not provided)'),
  },
  async ({ tmdb_id, media_type, title }) => {
    try {
      if (!tmdb_id && !title) {
        return { content: [{ type: 'text', text: 'Provide either tmdb_id or title.' }], isError: true };
      }

      const resolved = await resolveMediaArgs({ tmdb_id, title, media_type });
      if (resolved.notFound) {
        return { content: [{ type: 'text', text: `No results found for "${resolved.notFound}".` }], isError: true };
      }
      if (resolved.ambiguous) {
        return { content: [{ type: 'text', text: candidatesText(resolved.ambiguous) }] };
      }

      const data = await apiPost('/api/v1/watchlist', {
        tmdb_id: resolved.tmdb_id,
        media_type: resolved.media_type,
      });
      const item = data.item || data;
      return {
        content: [{ type: 'text', text: `Added "${item.title || title || `TMDB #${resolved.tmdb_id}`}" (${item.year || ''}) [${item.media_type}] to "Хочу посмотреть".` }],
      };
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ── Tool: get_watchlist ─────────────────────────────────────────────────
server.tool(
  'get_watchlist',
  'Get your "Want to watch" list',
  {
    media_type: z.enum(['movie', 'tv']).optional().describe('Filter by type'),
  },
  async ({ media_type }) => {
    try {
      const data = await apiGet('/api/v1/watchlist');
      let items = data.items || [];
      if (media_type) items = items.filter(i => i.media_type === media_type);
      if (items.length === 0) {
        return { content: [{ type: 'text', text: media_type ? `No ${media_type} items in your watchlist.` : 'Your watchlist is empty.' }] };
      }
      const list = items.map(i => fmtListItem(i, { status: 'want_to_watch' })).join('\n');
      return { content: [{ type: 'text', text: `Watchlist (${items.length} items):\n\n${list}` }] };
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ── Tool: remove_from_watchlist ─────────────────────────────────────────
server.tool(
  'remove_from_watchlist',
  'Remove an item from your watchlist by list item ID (item_id from get_watchlist)',
  {
    item_id: z.number().describe('List item ID (item_id from get_watchlist)'),
  },
  async ({ item_id }) => {
    try {
      await apiDelete(`/api/v1/watchlist/${item_id}`);
      return { content: [{ type: 'text', text: `Removed item #${item_id} from watchlist.` }] };
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ── Tool: mark_watched ──────────────────────────────────────────────────
server.tool(
  'mark_watched',
  'Mark a movie/TV show as watched with optional rating. Provide tmdb_id (+optional media_type) OR title.',
  {
    tmdb_id: z.number().optional().describe('TMDB ID'),
    media_type: z.enum(['movie', 'tv']).optional().describe('movie or tv — auto-detected from TMDB if omitted'),
    title: z.string().optional().describe('Title to search (if tmdb_id not provided)'),
    rating: z.number().min(1).max(10).optional().describe('Rating 1-10'),
    notes: z.string().optional().describe('Personal notes'),
    watched_at: z.string().optional().describe('Date (YYYY-MM-DD), defaults to today'),
  },
  async ({ tmdb_id, media_type, title, rating, notes, watched_at }) => {
    try {
      if (!tmdb_id && !title) {
        return { content: [{ type: 'text', text: 'Provide either tmdb_id or title.' }], isError: true };
      }

      const resolved = await resolveMediaArgs({ tmdb_id, title, media_type });
      if (resolved.notFound) {
        return { content: [{ type: 'text', text: `No results found for "${resolved.notFound}".` }], isError: true };
      }
      if (resolved.ambiguous) {
        return { content: [{ type: 'text', text: candidatesText(resolved.ambiguous) }] };
      }

      const body = { tmdb_id: resolved.tmdb_id, media_type: resolved.media_type };
      if (rating) body.rating = rating;
      if (notes) body.notes = notes;
      if (watched_at) body.watched_at = watched_at;

      const data = await apiPost('/api/v1/watched', body);
      const item = data.item || data;
      const rText = rating ? ` with rating ${rating}/10` : '';
      return {
        content: [{ type: 'text', text: `Marked "${item.title || title || `TMDB #${resolved.tmdb_id}`}" as watched${rText}.` }],
      };
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ── Tool: get_watched ───────────────────────────────────────────────────
server.tool(
  'get_watched',
  'Get your watched movies/TV shows with ratings',
  {
    media_type: z.enum(['movie', 'tv']).optional().describe('Filter by type'),
    sort: z.enum(['rating', 'rating_asc', 'watched_at', 'added_at']).optional().default('watched_at').describe('Sort order'),
    min_rating: z.number().optional().describe('Minimum rating (1-10)'),
    limit: z.number().optional().default(20).describe('Max results'),
  },
  async ({ media_type, sort, min_rating, limit }) => {
    try {
      const qs = new URLSearchParams({ sort });
      if (media_type) qs.set('media_type', media_type);
      if (min_rating != null) qs.set('min_rating', String(min_rating));
      const data = await apiGet(`/api/v1/watched?${qs.toString()}`);
      // API has no LIMIT param — slice client-side
      const all = data.items || [];
      const items = all.slice(0, limit);
      if (items.length === 0) {
        return { content: [{ type: 'text', text: 'No watched items found.' }] };
      }
      const list = items.map(i => fmtListItem(i, { status: 'watched' })).join('\n');
      const note = all.length > items.length ? `\n\n(showing first ${items.length} of ${all.length})` : '';
      return { content: [{ type: 'text', text: `Watched (${items.length} items):\n\n${list}${note}` }] };
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ── Tool: rate ──────────────────────────────────────────────────────────
server.tool(
  'rate',
  'Rate a watched movie/TV show (1-10) or update existing rating',
  {
    item_id: z.number().describe('List item ID (item_id from get_watched)'),
    rating: z.number().min(1).max(10).describe('Rating 1-10'),
    notes: z.string().optional().describe('Personal notes'),
  },
  async ({ item_id, rating, notes }) => {
    try {
      const body = { rating };
      if (notes) body.notes = notes;
      await apiPut(`/api/v1/watched/${item_id}`, body);
      return { content: [{ type: 'text', text: `Rated item #${item_id} → ${rating}/10` }] };
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ── Tool: recommendations ──────────────────────────────────────────────
server.tool(
  'recommendations',
  'Get personalized movie/TV recommendations based on your taste profile',
  {
    query: z.string().optional().describe('Natural language request (e.g. "good sci-fi movie for evening")'),
    media_type: z.enum(['movie', 'tv']).optional().describe('Filter by type'),
    genres: z.array(z.string()).optional().describe('Genre names (e.g. ["sci-fi", "drama"])'),
    year_from: z.number().optional().describe('Minimum year'),
    year_to: z.number().optional().describe('Maximum year'),
    min_rating: z.number().optional().describe('Minimum TMDB rating'),
    limit: z.number().optional().default(10).describe('Max results'),
    exclude_watched: z.boolean().optional().default(true).describe('Exclude already watched'),
    context: z.object({
      mood: z.string().optional().describe('Mood (relaxed, excited, etc.)'),
      watching_with: z.string().optional().describe('alone, family, date, friends'),
      available_minutes: z.number().optional().describe('Time available in minutes'),
    }).optional().describe('Additional context for better recommendations'),
  },
  async (params) => {
    try {
      const body = {};
      if (params.query) body.query = params.query;
      if (params.media_type) body.media_type = params.media_type;
      if (params.genres) body.genres = params.genres;
      if (params.year_from) body.year_from = params.year_from;
      if (params.year_to) body.year_to = params.year_to;
      if (params.min_rating) body.min_rating = params.min_rating;
      if (params.limit) body.limit = params.limit;
      if (params.exclude_watched !== undefined) body.exclude_watched = params.exclude_watched;
      if (params.context) body.context = params.context;

      const data = await apiPost('/api/v1/recommendations', body);
      const items = data.recommendations || [];
      if (items.length === 0) {
        return { content: [{ type: 'text', text: 'No recommendations found. Try different filters.' }] };
      }
      const list = items.map(fmtMedia).join('\n\n');
      return { content: [{ type: 'text', text: `Recommendations (${items.length}):\n\n${list}` }] };
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ── Tool: profile ──────────────────────────────────────────────────────
server.tool(
  'profile',
  'Get your taste profile: favorite genres, actors, directors, and high-rated titles',
  {},
  async () => {
    try {
      const data = await apiGet('/api/v1/profile/preferences');
      const genres = (data.favorite_genres || []).map(g => `  ${g.name}: score ${g.score} (${g.count} films)`).join('\n');
      const actors = (data.favorite_actors || []).slice(0, 10).map(a => `  ${a.name}`).join('\n');
      const directors = (data.favorite_directors || []).slice(0, 10).map(d => `  ${d.name}`).join('\n');
      const highMovies = (data.high_rated_movies || []).slice(0, 5).map(m => `  ${m.title || m.name} (${m.vote_average || '?'})`).join('\n');
      const highTv = (data.high_rated_tv || []).slice(0, 5).map(t => `  ${t.title || t.name} (${t.vote_average || '?'})`).join('\n');
      const yearRange = data.preferred_year_range || {};
      const text = [
        `**Taste Profile**`,
        ``,
        `Favorite genres:`,
        genres || '  (none yet)',
        ``,
        `Preferred years: ${yearRange.from || '?'}–${yearRange.to || '?'}`,
        ``,
        `Top actors:`,
        actors || '  (none yet)',
        ``,
        `Top directors:`,
        directors || '  (none yet)',
        ``,
        `High-rated movies:`,
        highMovies || '  (none yet)',
        ``,
        `High-rated TV:`,
        highTv || '  (none yet)',
      ].join('\n');
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ── Start ──────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[Kinolike MCP] Server v2.1 started (API token auth)');
}

main().catch((err) => {
  console.error('[Kinolike MCP] Fatal error:', err);
  process.exit(1);
});
