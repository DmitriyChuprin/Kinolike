/**
 * TMDB Catalog Sync Service
 *
 * Discovers new/changed movies and TV shows from TMDB and upserts them
 * into the KinoLike database via the existing saveMediaMetadata().
 *
 * Endpoints used:
 *   - /discover/movie, /discover/tv (released since last sync)
 *   - /trending/movie/week, /trending/tv/week
 *   - /movie/upcoming, /tv/on_the_air
 *
 * For each discovered title, full details are fetched with
 * append_to_response=credits,similar,keywords,external_ids and saved.
 */

const db = require('../db/database');
const { tmdbRequest, saveMediaMetadata } = require('./tmdb');

// ── Configuration ──────────────────────────────────────────────────────────────

const OVERLAP_DAYS = 3;           // overlap window between syncs
const DETAIL_APPEND = 'credits,similar,keywords,external_ids';
const RATE_LIMIT_MAX = 40;        // max requests per window
const RATE_LIMIT_WINDOW_MS = 10_000; // 10 seconds
const MAX_CONCURRENT = 3;         // parallel API requests
const MAX_DETAIL_RETRIES = 3;     // retries per detail fetch (exponential backoff)
const DETAIL_RETRY_BASE_MS = 1000;

const LOG_PREFIX = '[TMDB Sync]';

// ── Rate Limiter (sliding window) ──────────────────────────────────────────────

const requestTimestamps = [];

function recordRequest() {
  requestTimestamps.push(Date.now());
}

function trimWindow() {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  while (requestTimestamps.length > 0 && requestTimestamps[0] < cutoff) {
    requestTimestamps.shift();
  }
}

function waitIfOverLimit() {
  trimWindow();
  if (requestTimestamps.length < RATE_LIMIT_MAX) return Promise.resolve();

  // Wait until the oldest request falls out of the window
  const waitMs = requestTimestamps[0] + RATE_LIMIT_WINDOW_MS - Date.now() + 50;
  return new Promise(resolve => setTimeout(resolve, Math.max(waitMs, 50)));
}

// ── Concurrency Pool ───────────────────────────────────────────────────────────

let activeCount = 0;
const waitQueue = [];

function acquireSlot() {
  return new Promise(resolve => {
    if (activeCount < MAX_CONCURRENT) {
      activeCount++;
      resolve();
    } else {
      waitQueue.push(resolve);
    }
  });
}

function releaseSlot() {
  if (waitQueue.length > 0) {
    // hand slot to next waiter
    const next = waitQueue.shift();
    // activeCount stays the same
    next();
  } else {
    activeCount--;
  }
}

// ── Date Helpers ───────────────────────────────────────────────────────────────

function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

// ── Sync History / State ───────────────────────────────────────────────────────

async function ensureTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS tmdb_sync_history (
      id SERIAL PRIMARY KEY,
      started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed')),
      stats JSONB NOT NULL DEFAULT '{}'::jsonb,
      error TEXT
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS tmdb_sync_state (
      key TEXT PRIMARY KEY,
      value TIMESTAMPTZ NOT NULL
    )
  `);
}

async function createSyncRun() {
  const { rows } = await db.query(
    `INSERT INTO tmdb_sync_history (status, stats) VALUES ('running', '{}'::jsonb) RETURNING id`
  );
  return rows[0].id;
}

async function finishSyncRun(runId, stats, error = null) {
  const status = error ? 'failed' : 'completed';
  await db.query(
    `UPDATE tmdb_sync_history
     SET completed_at = CURRENT_TIMESTAMP, status = $2, stats = $3, error = $4
     WHERE id = $1`,
    [runId, status, JSON.stringify(stats), error]
  );
}

async function getLastSyncTime() {
  await ensureTable();
  const { rows } = await db.query(
    `SELECT value FROM tmdb_sync_state WHERE key = 'last_successful_tmdb_sync'`
  );
  return rows.length > 0 ? rows[0].value : null;
}

async function setLastSyncTime(ts) {
  await db.query(
    `INSERT INTO tmdb_sync_state (key, value)
     VALUES ('last_successful_tmdb_sync', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [ts]
  );
}

// ── Rate-limited TMDB Request with 429 Handling ────────────────────────────────

async function rateLimitedRequest(endpoint, params = {}, opts = {}) {
  await waitIfOverLimit();
  recordRequest();
  try {
    return await tmdbRequest(endpoint, params, opts);
  } catch (err) {
    // Retry on 429 or network-ish errors (tmdbRequest already retries network errors
    // but does not handle 429, which comes as "TMDB API ошибка: 429")
    const msg = err.message || '';
    const is429 = msg.includes('429');
    if (!is429) throw err;

    // Exponential backoff for 429
    for (let attempt = 1; attempt <= MAX_DETAIL_RETRIES; attempt++) {
      const backoff = DETAIL_RETRY_BASE_MS * Math.pow(2, attempt);
      log(`429 rate limit hit on ${endpoint}, retry ${attempt}/${MAX_DETAIL_RETRIES} in ${backoff}ms`);
      await new Promise(r => setTimeout(r, backoff));
      try {
        await waitIfOverLimit();
        recordRequest();
        return await tmdbRequest(endpoint, params, opts);
      } catch (retryErr) {
        const retryMsg = retryErr.message || '';
        if (retryMsg.includes('429') && attempt < MAX_DETAIL_RETRIES) continue;
        throw retryErr;
      }
    }
    throw err;
  }
}

// ── Discovery: Collect TMDB IDs from multiple sources ──────────────────────────

async function discoverFromEndpoint(endpoint, params) {
  try {
    const data = await rateLimitedRequest(endpoint, params);
    return (data.results || []).map(item => item.id);
  } catch (err) {
    log(`WARN: Discovery failed for ${endpoint}: ${err.message}`);
    return [];
  }
}

async function discoverIds(lastSyncDate) {
  const since = daysAgo(OVERLAP_DAYS); // 3-day overlap
  const sinceStr = toDateStr(since);
  const movieIds = new Set();
  const tvIds = new Set();

  log(`Discovering content since ${sinceStr} (last sync: ${lastSyncDate ? lastSyncDate.toISOString() : 'never'})`);

  // 1. Discover movies by release date
  const movieIds1 = await discoverFromEndpoint('/discover/movie', {
    'primary_release_date.gte': sinceStr,
    sort_by: 'primary_release_date.desc',
    page: 1,
  });
  movieIds1.forEach(id => movieIds.add(id));

  // Also page 2 if first page is full
  const movieIds2 = await discoverFromEndpoint('/discover/movie', {
    'primary_release_date.gte': sinceStr,
    sort_by: 'primary_release_date.desc',
    page: 2,
  });
  movieIds2.forEach(id => movieIds.add(id));

  // 2. Discover TV by first air date
  const tvIds1 = await discoverFromEndpoint('/discover/tv', {
    'first_air_date.gte': sinceStr,
    sort_by: 'first_air_date.desc',
    page: 1,
  });
  tvIds1.forEach(id => tvIds.add(id));

  const tvIds2 = await discoverFromEndpoint('/discover/tv', {
    'first_air_date.gte': sinceStr,
    sort_by: 'first_air_date.desc',
    page: 2,
  });
  tvIds2.forEach(id => tvIds.add(id));

  // 3. Trending movies this week
  const trendingMovieIds = await discoverFromEndpoint('/trending/movie/week', {});
  trendingMovieIds.forEach(id => movieIds.add(id));

  // 4. Trending TV this week
  const trendingTvIds = await discoverFromEndpoint('/trending/tv/week', {});
  trendingTvIds.forEach(id => tvIds.add(id));

  // 5. Upcoming movies
  const upcomingIds = await discoverFromEndpoint('/movie/upcoming', { page: 1 });
  upcomingIds.forEach(id => movieIds.add(id));

  // 6. On the air TV
  const onAirIds = await discoverFromEndpoint('/tv/on_the_air', { page: 1 });
  onAirIds.forEach(id => tvIds.add(id));

  log(`Discovered: ${movieIds.size} movies, ${tvIds.size} TV shows`);

  return {
    movies: [...movieIds].map(id => ({ tmdb_id: id, media_type: 'movie' })),
    tv: [...tvIds].map(id => ({ tmdb_id: id, media_type: 'tv' })),
  };
}

// ── Fetch Details & Save ───────────────────────────────────────────────────────

async function fetchAndSave(tmdbId, mediaType) {
  const endpoint = `/${mediaType}/${tmdbId}`;
  const data = await rateLimitedRequest(endpoint, {
    append_to_response: DETAIL_APPEND,
  });
  if (!data || data.success === false) {
    throw new Error(`No data for ${mediaType}/${tmdbId}`);
  }
  await saveMediaMetadata(tmdbId, mediaType, data);
  return true;
}

// ── Structured Logging ─────────────────────────────────────────────────────────

function log(msg, extra = {}) {
  const ts = new Date().toISOString();
  if (Object.keys(extra).length > 0) {
    console.log(`${ts} ${LOG_PREFIX} ${msg}`, JSON.stringify(extra));
  } else {
    console.log(`${ts} ${LOG_PREFIX} ${msg}`);
  }
}

// ── Main Entry Point ───────────────────────────────────────────────────────────

async function runSync() {
  await ensureTable();

  const runId = await createSyncRun();
  const startedAt = Date.now();
  log('Sync started', { runId });

  const stats = {
    discovered: 0,
    saved: 0,
    skipped: 0,
    failed: 0,
    failedTitles: [],
  };

  try {
    const lastSync = await getLastSyncTime();
    const { movies, tv } = await discoverIds(lastSync);
    const allItems = [...movies, ...tv];
    stats.discovered = allItems.length;

    if (allItems.length === 0) {
      log('No new items discovered');
      await finishSyncRun(runId, stats);
      return stats;
    }

    // Process items with concurrency control
    const results = await Promise.allSettled(
      allItems.map(item =>
        (async () => {
          await acquireSlot();
          try {
            await fetchAndSave(item.tmdb_id, item.media_type);
            stats.saved++;
            return { success: true, ...item };
          } catch (err) {
            stats.failed++;
            stats.failedTitles.push({
              tmdb_id: item.tmdb_id,
              media_type: item.media_type,
              error: err.message,
            });
            log(`FAIL: ${item.media_type}/${item.tmdb_id}: ${err.message}`);
            return { success: false, ...item, error: err.message };
          } finally {
            releaseSlot();
          }
        })()
      )
    );

    // Count successes/failures from Promise.allSettled
    // (our internal counters are more reliable since we track in the try/catch)

    const durationMs = Date.now() - startedAt;
    stats.duration_seconds = Math.round(durationMs / 1000);

    await finishSyncRun(runId, stats);
    await setLastSyncTime(new Date());

    log('Sync completed', {
      saved: stats.saved,
      failed: stats.failed,
      discovered: stats.discovered,
      duration_s: stats.duration_seconds,
    });

    return stats;
  } catch (err) {
    stats.error = err.message;
    await finishSyncRun(runId, stats, err.message);
    log(`Sync FAILED: ${err.message}`);
    throw err;
  }
}

// ── Exports ────────────────────────────────────────────────────────────────────

module.exports = {
  runSync,
  getLastSyncTime,
};
