const assert = require('assert');

process.env.KINOLIKE_API_TOKEN = 'test-token-with-enough-entropy-0123456789';
process.env.KINOLIKE_API_USER_ID = '7';
process.env.KINOLIKE_API_RATE_LIMIT = '20';
process.env.KINOLIKE_API_RATE_WINDOW_MS = '60000';
process.env.RECOMMENDATIONS_DEBOUNCE_MS = '60000';

const db = require('../db/database');
const ListItemModel = require('../models/listItem');
const RecommendationModel = require('../models/recommendation');
const tasteProfile = require('../services/tasteProfile');
const service = require('../services/hermesApi');
const { ApiError } = require('../api/errors');
const { tokensEqual } = require('../middleware/apiTokenAuth');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}: ${error.stack || error.message}`); throw error; }
}

function responseDouble() {
  return {
    statusCode: 200, payload: null, ended: false, headers: {},
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; },
    end() { this.ended = true; return this; },
    setHeader(name, value) { this.headers[name] = value; },
  };
}

(async () => {
  console.log('\n=== Hermes API ===');

  await test('constant-time token comparison accepts only the configured token', () => {
    assert.strictEqual(tokensEqual('abc', 'abc'), true);
    assert.strictEqual(tokensEqual('abc', 'abd'), false);
  });

  await test('recommendation filters validate and normalize structured input/context', () => {
    const filters = service.structuredFilters({
      media_type: 'movie', genres: ['science-fiction'], year_from: 2020, year_to: 2026,
      max_runtime: 150, min_rating: 6.5, min_vote_count: 500, exclude_watched: true,
      context: { mood: 'relaxed', available_minutes: 120 },
    });
    assert.deepStrictEqual(filters.genres, ['878']);
    assert.strictEqual(filters.runtime_max, 150);
    assert.strictEqual(filters.library_scope, 'exclude_watched');
    assert.strictEqual(filters.strict_filters, true);
  });

  await test('ambiguous title selection returns 409 and candidates', () => {
    assert.throws(() => service.chooseCandidate([
      { id: 1, title: 'Дюна', year: 1984 }, { id: 2, title: 'Дюна', year: 2021 },
    ], 'Дюна'), error => error instanceof ApiError && error.status === 409 && error.code === 'AMBIGUOUS_MEDIA');
  });

  const original = {
    dbQuery: db.query,
    findByTmdb: ListItemModel.findByTmdb,
    findById: ListItemModel.findById,
    create: ListItemModel.create,
    update: ListItemModel.update,
    clearCache: RecommendationModel.clearCache,
    invalidate: tasteProfile.invalidate,
  };
  let saved = null;
  db.query = async (sql) => {
    if (String(sql).includes('FROM media_metadata WHERE id')) return { rows: [{ id: 33, tmdb_id: 693134, media_type: 'movie', title: 'Дюна: Часть вторая', release_year: 2024, data: { id: 693134, title: 'Дюна: Часть вторая', vote_average: 8.1, vote_count: 7000, runtime: 166, genres: [{ id: 878, name: 'Фантастика' }] } }] };
    return { rows: [] };
  };
  ListItemModel.findByTmdb = async () => saved;
  ListItemModel.create = async (userId, item) => { saved = { id: 91, user_id: userId, ...item, rating: null, watched_at: null }; return { lastInsertRowid: 91 }; };
  ListItemModel.update = async (id, patchValue) => { saved = { ...saved, ...patchValue, id }; };
  RecommendationModel.clearCache = async () => {};
  tasteProfile.invalidate = async () => {};

  await test('watched media and subsequent rating changes are persisted through the existing list model', async () => {
    const first = await service.markWatched(7, { media_id: 33, rating: 8, watched_at: '2026-09-20' });
    assert.strictEqual(first.rating, 8);
    assert.strictEqual(saved.status, 'watched');
    const updated = await service.markWatched(7, { media_id: 33, rating: 9, watched_at: '2026-09-20' });
    assert.strictEqual(updated.rating, 9);
    assert.strictEqual(saved.rating, 9);
  });

  Object.assign(ListItemModel, { findByTmdb: original.findByTmdb, findById: original.findById, create: original.create, update: original.update });
  RecommendationModel.clearCache = original.clearCache;
  tasteProfile.invalidate = original.invalidate;

  // Route-level contract tests use deterministic service doubles; the service
  // pipeline itself is covered above and by recommendations.test.js/aiSearch.test.js.
  let watchlist = [];
  let watchedRating = null;
  Object.assign(service, {
    recommendations: async () => ({ recommendations: [{ id: 33, tmdb_id: 693134, media_type: 'movie', title: 'Дюна: Часть вторая', genres: ['Science Fiction'], recommendation_score: 0.91, reason: 'Совпадает с любимой фантастикой.' }] }),
    preferences: async () => ({ favorite_genres: [], preferred_year_range: {}, favorite_actors: [], favorite_directors: [], high_rated_movies: [], high_rated_tv: [] }),
    search: async () => ({ items: [{ id: 33, tmdb_id: 693134, media_type: 'movie', title: 'Дюна: Часть вторая', genres: [] }], source: 'local' }),
    getMedia: async (userId, id) => { if (String(id) === '404') throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Media not found'); return { id: Number(id), status: { watched: false, watchlist: false, rating: null, watch_date: null } }; },
    getWatchlist: async () => watchlist,
    addWatchlist: async (userId, input) => {
      if (input.title === 'Дюна') throw new ApiError(409, 'AMBIGUOUS_MEDIA', 'Several media items match the title', { candidates: [{ id: 1 }, { id: 2 }] });
      const item = { id: input.media_id || 33, title: input.title || 'Дюна: Часть вторая' };
      watchlist = [item]; return item;
    },
    removeWatchlist: async () => { watchlist = []; },
    markWatched: async (userId, input) => { watchedRating = input.rating; return { id: input.media_id, rating: watchedRating, watched_at: input.watched_at }; },
  });
  db.query = async sql => String(sql).includes('SELECT id, username FROM users') ? { rows: [{ id: 7, username: 'hermes' }] } : { rows: [] };

  const apiRouter = require('../routes/apiV1');
  const handlers = apiRouter.handlers;
  const auth = require('../middleware/apiTokenAuth').apiTokenAuth;
  async function invoke(handler, req = {}) {
    const res = responseDouble();
    try { await handler({ user: { id: 7 }, body: {}, query: {}, params: {}, ...req }, res); }
    catch (error) { require('../api/errors').errorHandler(error, req, res, () => {}); }
    return { status: res.statusCode, body: res.payload };
  }

    await test('authorization rejects missing and invalid bearer tokens', async () => {
      for (const authorization of ['', 'Bearer wrong']) {
        const res = responseDouble();
        await auth({ headers: { authorization } }, res, () => { throw new Error('must not authorize'); });
        assert.strictEqual(res.statusCode, 401);
      }
      const res = responseDouble(); let authorized = false;
      await auth({ headers: { authorization: `Bearer ${process.env.KINOLIKE_API_TOKEN}` } }, res, () => { authorized = true; });
      assert.strictEqual(authorized, true);
    });
    await test('recommendations endpoint returns structured ranked items', async () => {
      const result = await invoke(handlers.recommendations, { body: { query: 'фантастика' } });
      assert.strictEqual(result.status, 200); assert.strictEqual(result.body.recommendations[0].recommendation_score, 0.91);
    });
    await test('search endpoint returns local results', async () => {
      const result = await invoke(handlers.search, { query: { q: 'dune' } });
      assert.strictEqual(result.status, 200); assert.strictEqual(result.body.source, 'local');
    });
    await test('watchlist add/list/delete persists state', async () => {
      assert.strictEqual((await invoke(handlers.addWatchlist, { body: { media_id: 33 } })).status, 201);
      assert.strictEqual((await invoke(handlers.watchlist)).body.items.length, 1);
      assert.strictEqual((await invoke(handlers.removeWatchlist, { params: { id: 33 } })).status, 204);
      assert.strictEqual((await invoke(handlers.watchlist)).body.items.length, 0);
    });
    await test('watched endpoint supports rating updates', async () => {
      assert.strictEqual((await invoke(handlers.watched, { body: { media_id: 33, rating: 8 } })).body.item.rating, 8);
      assert.strictEqual((await invoke(handlers.watched, { body: { media_id: 33, rating: 9 } })).body.item.rating, 9);
    });
    await test('ambiguous and missing media use unified errors', async () => {
      const ambiguous = await invoke(handlers.addWatchlist, { body: { title: 'Дюна' } });
      assert.strictEqual(ambiguous.status, 409); assert.strictEqual(ambiguous.body.error.code, 'AMBIGUOUS_MEDIA');
      const missing = await invoke(handlers.media, { params: { id: 404 } });
      assert.strictEqual(missing.status, 404); assert.strictEqual(missing.body.error.code, 'MEDIA_NOT_FOUND');
    });
    await test('rate limiting returns the unified 429 error', async () => {
      const res = responseDouble();
      apiRouter.rateLimitHandler({}, res);
      assert.strictEqual(res.statusCode, 429); assert.strictEqual(res.payload.error.code, 'RATE_LIMITED');
    });
  db.query = original.dbQuery;

  console.log(`Hermes API tests passed: ${passed}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
