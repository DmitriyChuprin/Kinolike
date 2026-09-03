#!/usr/bin/env node
/**
 * Kinolike MCP Server
 * 
 * Wraps the Kinolike REST API (localhost:3001) as MCP tools
 * so Hermes Agent can search, add, rate, and analyze movies/TV.
 * 
 * Env vars:
 *   KINOLIKE_URL       — base URL (default: http://localhost:3001)
 *   KINOLIKE_EMAIL     — login email
 *   KINOLIKE_PASSWORD  — login password
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// ── Config ──────────────────────────────────────────────────────────────
const BASE_URL = process.env.KINOLIKE_URL || 'http://localhost:3001';
const EMAIL    = process.env.KINOLIKE_EMAIL || '';
const PASSWORD = process.env.KINOLIKE_PASSWORD || '';

let authToken = null;

// ── HTTP helpers ────────────────────────────────────────────────────────
async function apiGet(path, params = {}) {
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const res = await fetch(url.toString(), { headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function apiPost(path, body = {}) {
  const url = new URL(path, BASE_URL);
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function apiPut(path, body = {}) {
  const url = new URL(path, BASE_URL);
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const res = await fetch(url.toString(), {
    method: 'PUT',
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function apiDelete(path) {
  const url = new URL(path, BASE_URL);
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const res = await fetch(url.toString(), { method: 'DELETE', headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── Auth ────────────────────────────────────────────────────────────────
async function ensureAuth() {
  if (authToken) return;
  if (!EMAIL || !PASSWORD) {
    throw new Error('Set KINOLIKE_EMAIL and KINOLIKE_PASSWORD env vars, or provide a token');
  }
  const data = await apiPost('/api/auth/login', { email: EMAIL, password: PASSWORD });
  authToken = data.token;
}

// ── Formatting helpers ──────────────────────────────────────────────────
function fmtMovie(item) {
  const title = item.title || item.name || `TMDB #${item.id}`;
  const year = (item.release_date || item.first_air_date || '').slice(0, 4);
  const rating = item.vote_average ? item.vote_average.toFixed(1) : '—';
  const genres = (item.genres || []).map(g => g.name || g).join(', ');
  const overview = item.overview || '';
  return [
    `**${title}** (${year})`,
    `TMDB ID: ${item.id} | Type: ${item.media_type || 'movie'}`,
    `Rating: ${rating} | Genres: ${genres || '—'}`,
    overview ? `Overview: ${overview.slice(0, 300)}` : '',
  ].filter(Boolean).join('\n');
}

function fmtListItem(item) {
  const title = item.details?.title || item.details?.name || `TMDB #${item.tmdb_id}`;
  const year = (item.details?.release_date || item.details?.first_air_date || '').slice(0, 4);
  const rating = item.rating ? `${item.rating}/10` : '—';
  const status = item.status || '—';
  return `• ${title} (${year}) — status: ${status}, rating: ${rating}, id: ${item.id}`;
}

// ── MCP Server ──────────────────────────────────────────────────────────
const server = new McpServer({
  name: 'kinolike',
  version: '1.0.0',
});

// ── Tool: search ────────────────────────────────────────────────────────
server.tool(
  'search',
  'Search for movies and TV shows on TMDB via Kinolike',
  {
    query: z.string().describe('Search query (movie/show title, actor, etc.)'),
    type: z.enum(['movie', 'tv', 'multi']).optional().default('multi').describe('Content type filter'),
    page: z.number().optional().default(1).describe('Page number for pagination'),
  },
  async ({ query, type, page }) => {
    try {
      await ensureAuth();
      const data = await apiGet('/api/tmdb/search', { query, type, page });
      const results = (data.results || []).map(fmtMovie).join('\n\n');
      const total = data.total_results || 0;
      return {
        content: [{ type: 'text', text: `Found ${total} results (page ${page}):\n\n${results || 'No results found.'}` }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ── Tool: movie_details ─────────────────────────────────────────────────
server.tool(
  'movie_details',
  'Get detailed information about a movie by TMDB ID',
  {
    tmdb_id: z.number().describe('TMDB movie ID'),
  },
  async ({ tmdb_id }) => {
    try {
      await ensureAuth();
      const data = await apiGet(`/api/tmdb/movie/${tmdb_id}`);
      const text = fmtMovie(data);
      const details = [
        text,
        data.runtime ? `Runtime: ${data.runtime} min` : '',
        data.budget ? `Budget: $${(data.budget / 1e6).toFixed(0)}M` : '',
        data.revenue ? `Revenue: $${(data.revenue / 1e6).toFixed(0)}M` : '',
        data.tagline ? `Tagline: "${data.tagline}"` : '',
      ].filter(Boolean).join('\n');
      return { content: [{ type: 'text', text: details }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ── Tool: tv_details ────────────────────────────────────────────────────
server.tool(
  'tv_details',
  'Get detailed information about a TV show by TMDB ID',
  {
    tmdb_id: z.number().describe('TMDB TV show ID'),
  },
  async ({ tmdb_id }) => {
    try {
      await ensureAuth();
      const data = await apiGet(`/api/tmdb/tv/${tmdb_id}`);
      const title = data.name || `TMDB #${tmdb_id}`;
      const year = (data.first_air_date || '').slice(0, 4);
      const rating = data.vote_average ? data.vote_average.toFixed(1) : '—';
      const genres = (data.genres || []).map(g => g.name || g).join(', ');
      const seasons = data.number_of_seasons || '—';
      const episodes = data.number_of_episodes || '—';
      const text = [
        `**${title}** (${year})`,
        `TMDB ID: ${tmdb_id} | Type: tv`,
        `Rating: ${rating} | Genres: ${genres || '—'}`,
        `Seasons: ${seasons} | Episodes: ${episodes}`,
        data.overview ? `Overview: ${data.overview.slice(0, 300)}` : '',
      ].filter(Boolean).join('\n');
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ── Tool: add_to_list ───────────────────────────────────────────────────
server.tool(
  'add_to_list',
  'Add a movie or TV show to your Kinolike list (default: "want to watch")',
  {
    tmdb_id: z.number().describe('TMDB ID of the movie/show'),
    media_type: z.enum(['movie', 'tv']).describe('Type: movie or tv'),
    status: z.enum(['want_to_watch', 'watched', 'watching', 'on_hold']).optional().default('want_to_watch').describe('List status'),
  },
  async ({ tmdb_id, media_type, status }) => {
    try {
      await ensureAuth();
      const data = await apiPost('/api/lists', { tmdb_id, media_type, status });
      const item = data.item;
      const title = item?.details?.title || item?.details?.name || `TMDB #${tmdb_id}`;
      return {
        content: [{ type: 'text', text: `Added "${title}" to list with status "${status}". Item ID: ${item?.id}` }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ── Tool: get_list ──────────────────────────────────────────────────────
server.tool(
  'get_list',
  'Get your Kinolike movie/TV list with optional filters',
  {
    status: z.enum(['want_to_watch', 'watched', 'watching', 'on_hold']).optional().describe('Filter by status'),
    media_type: z.enum(['movie', 'tv']).optional().describe('Filter by type'),
    sort: z.string().optional().describe('Sort: rating, added_at, watched_at, etc.'),
  },
  async ({ status, media_type, sort }) => {
    try {
      await ensureAuth();
      const data = await apiGet('/api/lists', { status, media_type, sort });
      const items = data.items || [];
      const counts = data.statusCounts || {};
      const header = `List${status ? ` (${status})` : ''} — ${items.length} items. Counts: ${JSON.stringify(counts)}`;
      const list = items.map(fmtListItem).join('\n');
      return { content: [{ type: 'text', text: `${header}\n\n${list || '(empty)'}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ── Tool: get_watched ───────────────────────────────────────────────────
server.tool(
  'get_watched',
  'Get watched movies/TV with optional filters',
  {
    sort: z.string().optional().default('watched_at').describe('Sort: rating, rating_asc, watched_at, added_at'),
    media_type: z.enum(['movie', 'tv']).optional().describe('Filter by type'),
    min_rating: z.number().optional().describe('Minimum rating (1-10)'),
    max_rating: z.number().optional().describe('Maximum rating (1-10)'),
  },
  async ({ sort, media_type, min_rating, max_rating }) => {
    try {
      await ensureAuth();
      const data = await apiGet('/api/watched', { sort, media_type, min_rating, max_rating });
      const items = data.items || [];
      const list = items.map(fmtListItem).join('\n');
      return { content: [{ type: 'text', text: `Watched — ${items.length} items:\n\n${list || '(empty)'}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ── Tool: rate ──────────────────────────────────────────────────────────
server.tool(
  'rate',
  'Rate a watched movie/TV show (1-10)',
  {
    list_item_id: z.number().describe('The list item ID (from get_list or get_watched)'),
    rating: z.number().min(1).max(10).describe('Rating from 1 to 10'),
    notes: z.string().optional().describe('Optional notes/review'),
  },
  async ({ list_item_id, rating, notes }) => {
    try {
      await ensureAuth();
      const data = await apiPut(`/api/lists/${list_item_id}`, { rating, notes });
      const item = data.item;
      const title = item?.details?.title || item?.details?.name || `Item #${list_item_id}`;
      return {
        content: [{ type: 'text', text: `Rated "${title}" ${rating}/10${notes ? `. Notes: ${notes}` : ''}` }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ── Tool: mark_watched ──────────────────────────────────────────────────
server.tool(
  'mark_watched',
  'Mark a list item as watched with optional rating',
  {
    list_item_id: z.number().describe('The list item ID'),
    rating: z.number().min(1).max(10).optional().describe('Rating from 1 to 10'),
    notes: z.string().optional().describe('Optional notes'),
  },
  async ({ list_item_id, rating, notes }) => {
    try {
      await ensureAuth();
      const data = await apiPut(`/api/lists/${list_item_id}`, { status: 'watched', rating, notes });
      const item = data.item;
      const title = item?.details?.title || item?.details?.name || `Item #${list_item_id}`;
      return {
        content: [{ type: 'text', text: `Marked "${title}" as watched${rating ? ` with rating ${rating}/10` : ''}` }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ── Tool: remove_from_list ──────────────────────────────────────────────
server.tool(
  'remove_from_list',
  'Remove an item from your list',
  {
    list_item_id: z.number().describe('The list item ID to remove'),
  },
  async ({ list_item_id }) => {
    try {
      await ensureAuth();
      await apiDelete(`/api/lists/${list_item_id}`);
      return { content: [{ type: 'text', text: `Removed item #${list_item_id} from list.` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ── Tool: discover ──────────────────────────────────────────────────────
server.tool(
  'discover',
  'Discover movies/TV using TMDB Discover API with filters. Excludes items already in your lists.',
  {
    media_type: z.enum(['movie', 'tv']).optional().describe('Content type (movie or tv)'),
    genre: z.number().optional().describe('TMDB genre ID'),
    country: z.string().optional().describe('ISO country code (RU, US, etc.). Prefix with ! to exclude (e.g. !RU)'),
    year_from: z.number().optional().describe('Minimum release year'),
    year_to: z.number().optional().describe('Maximum release year'),
    rating_from: z.number().optional().describe('Minimum TMDB rating'),
    sort_by: z.enum(['popularity.desc', 'vote_average.desc', 'primary_release_date.desc', 'primary_release_date.asc']).optional().default('popularity.desc').describe('Sort order'),
    page: z.number().optional().default(1).describe('Page number'),
  },
  async ({ media_type, genre, country, year_from, year_to, rating_from, sort_by, page }) => {
    try {
      await ensureAuth();
      const data = await apiGet('/api/recommendations/discover', {
        media_type, genre, country, year_from, year_to, rating_from, sort_by, page,
      });
      const items = (data.items || []).map(fmtMovie).join('\n\n');
      return {
        content: [{ type: 'text', text: `Discover results (page ${page}):\n\n${items || 'No results found.'}` }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ── Tool: get_recommendations ───────────────────────────────────────────
server.tool(
  'get_recommendations',
  'Get personalized AI movie recommendations based on your watch history',
  {
    refresh: z.boolean().optional().default(false).describe('Force regeneration (bypass cache)'),
  },
  async ({ refresh }) => {
    try {
      await ensureAuth();
      const data = await apiGet('/api/recommendations', { refresh: refresh ? 'true' : undefined });
      const items = data.items || [];
      const list = items.map(fmtMovie).join('\n\n');
      return {
        content: [{ type: 'text', text: `Recommendations (${items.length} items${data.fromCache ? ', from cache' : ''}):\n\n${list || data.message || 'No recommendations available.'}` }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ── Tool: get_genres ────────────────────────────────────────────────────
server.tool(
  'get_genres',
  'Get all TMDB genres for movies and TV shows',
  {},
  async () => {
    try {
      await ensureAuth();
      const data = await apiGet('/api/tmdb/genres');
      const movieGenres = (data.movie || []).map(g => `${g.id}: ${g.name}`).join(', ');
      const tvGenres = (data.tv || []).map(g => `${g.id}: ${g.name}`).join(', ');
      return {
        content: [{ type: 'text', text: `Movie genres:\n${movieGenres}\n\nTV genres:\n${tvGenres}` }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ── Tool: get_stats ─────────────────────────────────────────────────────
server.tool(
  'get_stats',
  'Get statistics overview of your Kinolike lists',
  {},
  async () => {
    try {
      await ensureAuth();
      const data = await apiGet('/api/stats/overview');
      const text = [
        `Total items: ${data.total || 0}`,
        `By status: ${JSON.stringify(data.counts || {})}`,
        `Average rating: ${data.avgRating || '—'}`,
        `Rating distribution: ${(data.ratingDistribution || []).map(r => `${r.rating}: ${r.count}`).join(', ') || 'none'}`,
      ].join('\n');
      return { content: [{ type: 'text', text: text }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ── Tool: similar ───────────────────────────────────────────────────────
server.tool(
  'similar',
  'Find movies or TV shows similar to a given TMDB ID',
  {
    tmdb_id: z.number().describe('TMDB ID of the movie/show'),
    media_type: z.enum(['movie', 'tv']).describe('Type: movie or tv'),
  },
  async ({ tmdb_id, media_type }) => {
    try {
      await ensureAuth();
      const endpoint = media_type === 'tv' ? `/api/tmdb/tv/${tmdb_id}/similar` : `/api/tmdb/movie/${tmdb_id}/similar`;
      const data = await apiGet(endpoint);
      const items = (data.results || []).map(fmtMovie).join('\n\n');
      return {
        content: [{ type: 'text', text: `Similar to TMDB #${tmdb_id}:\n\n${items || 'No similar titles found.'}` }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ── Tool: trending ──────────────────────────────────────────────────────
server.tool(
  'trending',
  'Get trending movies or TV shows for the current week',
  {
    media_type: z.enum(['movie', 'tv']).optional().default('movie').describe('Content type'),
  },
  async ({ media_type }) => {
    try {
      await ensureAuth();
      const endpoint = media_type === 'tv' ? '/api/tmdb/trending/tv/week' : '/api/tmdb/trending/movie/week';
      const data = await apiGet(endpoint);
      const items = (data.results || []).map(fmtMovie).join('\n\n');
      return {
        content: [{ type: 'text', text: `Trending ${media_type} this week:\n\n${items || 'No results.'}` }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ── Start ───────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[Kinolike MCP] Server started');
}

main().catch((err) => {
  console.error('[Kinolike MCP] Fatal error:', err);
  process.exit(1);
});
