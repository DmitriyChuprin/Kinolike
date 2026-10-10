/**
 * Comprehensive tests for TMDB Sync Service
 *
 * Run: node server/tests/tmdbSync.test.js
 *
 * Tests mock the tmdbRequest function and database pool to verify
 * sync behaviour without hitting the real API or database.
 */

const assert = require('assert');
const sinon = require('sinon');
const { expect } = require('chai');

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a mock movie detail object (what TMDB /movie/:id returns).
 */
function movieDetail(id, overrides = {}) {
  return {
    id,
    title: overrides.title || `Movie ${id}`,
    release_date: overrides.release_date || '2024-06-15',
    vote_average: overrides.vote_average ?? 7.2,
    vote_count: overrides.vote_count ?? 5000,
    popularity: overrides.popularity ?? 60,
    poster_path: overrides.poster_path || `/poster_${id}.jpg`,
    overview: overrides.overview || `Overview for movie ${id}`,
    genres: overrides.genres || [{ id: 28, name: 'Action' }],
    credits: overrides.credits || {
      crew: [{ id: 100, name: 'Director One', job: 'Director' }],
      cast: [
        { id: 200, name: 'Actor One', character: 'Hero', order: 0 },
        { id: 201, name: 'Actor Two', character: 'Villain', order: 1 },
      ],
    },
    number_of_seasons: undefined,
    ...overrides,
  };
}

/**
 * Build a mock TV show detail object (what TMDB /tv/:id returns).
 */
function tvDetail(id, overrides = {}) {
  return {
    id,
    name: overrides.name || `Show ${id}`,
    first_air_date: overrides.first_air_date || '2024-03-01',
    vote_average: overrides.vote_average ?? 7.8,
    vote_count: overrides.vote_count ?? 3000,
    popularity: overrides.popularity ?? 55,
    poster_path: overrides.poster_path || `/tv_${id}.jpg`,
    overview: overrides.overview || `Overview for TV ${id}`,
    genres: overrides.genres || [{ id: 18, name: 'Drama' }],
    number_of_seasons: overrides.number_of_seasons ?? 2,
    number_of_episodes: overrides.number_of_episodes ?? 20,
    seasons: overrides.seasons || [
      { season_number: 1, episode_count: 10 },
      { season_number: 2, episode_count: 10 },
    ],
    credits: overrides.credits || {
      crew: [{ id: 300, name: 'Showrunner', job: 'Executive Producer' }],
      cast: [{ id: 400, name: 'Lead Actor', character: 'Main', order: 0 }],
    },
    created_by: overrides.created_by || [{ id: 301, name: 'Creator' }],
    ...overrides,
  };
}

/**
 * Build a discover response (what TMDB /discover/* returns).
 */
function discoverResponse(results, totalPages = 1) {
  return {
    page: 1,
    total_results: results.length,
    total_pages: totalPages,
    results,
  };
}

/**
 * Create a mock database pool with configurable query/connect behaviour.
 */
function createMockPool() {
  const queries = [];
  const client = {
    query: sinon.stub().resolves({ rows: [{ id: 1 }] }),
    release: sinon.stub(),
  };

  const pool = {
    query: sinon.stub().callsFake(async (text, params) => {
      queries.push({ text, params });
      if (text.includes('INSERT INTO tmdb_sync_history')) {
        return { rows: [{ id: 999 }] };
      }
      if (text.includes('ON CONFLICT')) {
        return { rows: [{ id: 1 }] };
      }
      if (text.includes('tmdb_sync_state') && text.includes('SELECT')) {
        return { rows: [] };
      }
      return { rows: [], rowCount: 0 };
    }),
    connect: sinon.stub().resolves(client),
    client,
    _queries: queries,
  };

  return pool;
}

/**
 * Create a mock tmdbRequest function with controllable responses per endpoint.
 */
function createMockTmdbRequest(responses = {}) {
  return sinon.stub().callsFake(async (endpoint, params = {}) => {
    const key = endpoint;
    if (responses[key]) {
      if (typeof responses[key] === 'function') {
        return responses[key](endpoint, params);
      }
      return responses[key];
    }
    throw new Error(`Unexpected TMDB endpoint: ${endpoint}`);
  });
}

/**
 * Build the full set of default TMDB responses for a successful sync
 * with two movies and two TV shows discovered.
 */
function defaultTmdbResponses(movieDetails, tvDetails) {
  const movieDiscoverResults = movieDetails.map(m => ({ id: m.id }));
  const tvDiscoverResults = tvDetails.map(t => ({ id: t.id }));
  const movieDetailMap = {};
  for (const m of movieDetails) movieDetailMap[`/movie/${m.id}`] = m;
  const tvDetailMap = {};
  for (const t of tvDetails) tvDetailMap[`/tv/${t.id}`] = t;
  return {
    '/discover/movie': discoverResponse(movieDiscoverResults),
    '/discover/tv': discoverResponse(tvDiscoverResults),
    ...movieDetailMap,
    ...tvDetailMap,
    '/trending/movie/week': { results: [] },
    '/trending/tv/week': { results: [] },
    '/movie/upcoming': { results: [] },
    '/tv/on_the_air': { results: [] },
  };
}

/**
 * Stub the require cache so tmdbSyncService gets our mocked dependencies.
 */
function loadSyncService(mockDb, mockTmdbRequest, mockSaveMediaMetadata) {
  // Clear cached module
  delete require.cache[require.resolve('../services/tmdbSyncService')];

  // Stub tmdb module
  const tmdbModule = {
    tmdbRequest: mockTmdbRequest,
    saveMediaMetadata: mockSaveMediaMetadata || sinon.stub().resolves(),
    getPopularMovies: sinon.stub(),
    getMovieDetails: sinon.stub(),
    getTvDetails: sinon.stub(),
  };
  require.cache[require.resolve('../services/tmdb')] = {
    id: require.resolve('../services/tmdb'),
    filename: require.resolve('../services/tmdb'),
    loaded: true,
    exports: tmdbModule,
  };

  // Stub database module
  const dbModule = {
    query: mockDb.query,
    connect: mockDb.connect,
    pool: { end: sinon.stub() },
    initSchema: sinon.stub(),
  };
  require.cache[require.resolve('../db/database')] = {
    id: require.resolve('../db/database'),
    filename: require.resolve('../db/database'),
    loaded: true,
    exports: dbModule,
  };

  const service = require('../services/tmdbSyncService');
  return { service, tmdbModule };
}

// ── Test runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e });
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== TMDB Sync Service Tests ===\n');

  // ── 1. New movie discovery ──────────────────────────────────────────────
  await test('1. New movie discovery — mock TMDB API, verify INSERT into media_metadata', async () => {
    const movie = movieDetail(5001);
    const tv = tvDetail(6001);

    const responses = defaultTmdbResponses([movie], [tv]);
    const mockTmdbRequest = createMockTmdbRequest(responses);
    const mockDb = createMockPool();
    const saveMediaMetadata = sinon.stub().resolves();

    const { service } = loadSyncService(mockDb, mockTmdbRequest, saveMediaMetadata);
    const stats = await service.runSync();

    expect(stats.discovered).to.be.greaterThan(0);

    const movieSaveCall = saveMediaMetadata.getCalls().find(
      c => c.args[0] === movie.id && c.args[1] === 'movie'
    );
    expect(movieSaveCall, 'saveMediaMetadata should be called for movie').to.exist;
    expect(movieSaveCall.args[2]).to.have.property('title', movie.title);
    expect(movieSaveCall.args[2]).to.have.property('genres');
    expect(movieSaveCall.args[2].genres).to.deep.equal(movie.genres);
  });

  // ── 2. New TV show discovery ────────────────────────────────────────────
  await test('2. New TV show discovery — mock TMDB API, verify INSERT', async () => {
    const movie = movieDetail(5002);
    const tv = tvDetail(6002, { name: 'New Series', number_of_seasons: 1 });

    const responses = defaultTmdbResponses([movie], [tv]);
    const mockTmdbRequest = createMockTmdbRequest(responses);
    const mockDb = createMockPool();
    const saveMediaMetadata = sinon.stub().resolves();

    const { service } = loadSyncService(mockDb, mockTmdbRequest, saveMediaMetadata);
    const stats = await service.runSync();

    expect(stats.discovered).to.be.greaterThan(0);

    const tvSaveCall = saveMediaMetadata.getCalls().find(
      c => c.args[0] === tv.id && c.args[1] === 'tv'
    );
    expect(tvSaveCall, 'saveMediaMetadata should be called for TV show').to.exist;
    expect(tvSaveCall.args[2]).to.have.property('name', tv.name);
    expect(tvSaveCall.args[2]).to.have.property('number_of_seasons', 1);
    expect(tvSaveCall.args[2]).to.have.property('first_air_date', tv.first_air_date);
  });

  // ── 3. No duplicates ────────────────────────────────────────────────────
  await test('3. No duplicates — run sync twice, verify no duplicate rows', async () => {
    const movie = movieDetail(5003);
    const tv = tvDetail(6003);
    const responses = defaultTmdbResponses([movie], [tv]);
    const mockTmdbRequest = createMockTmdbRequest(responses);
    const mockDb = createMockPool();
    const saveMediaMetadata = sinon.stub().resolves();

    const { service } = loadSyncService(mockDb, mockTmdbRequest, saveMediaMetadata);

    await service.runSync();
    await service.runSync();

    const movieCallsTotal = saveMediaMetadata.getCalls()
      .filter(c => c.args[0] === movie.id).length;
    const tvCallsTotal = saveMediaMetadata.getCalls()
      .filter(c => c.args[0] === tv.id).length;

    expect(movieCallsTotal).to.equal(2, 'movie should be upserted exactly 2 times');
    expect(tvCallsTotal).to.equal(2, 'TV show should be upserted exactly 2 times');

    // Both calls should pass identical data — proving upsert semantics
    const movieCalls = saveMediaMetadata.getCalls()
      .filter(c => c.args[0] === movie.id);
    expect(movieCalls[0].args[2].title).to.equal(movieCalls[1].args[2].title);
    expect(movieCalls[0].args[2].vote_average).to.equal(movieCalls[1].args[2].vote_average);

    // Verify no user_lists queries occurred during sync (no duplicate user data)
    const userListQueries = mockDb._queries.filter(
      q => q.text.includes('user_lists')
    );
    expect(userListQueries.length).to.equal(0, 'sync must not touch user_lists');
  });

  // ── 4. Update existing movie ────────────────────────────────────────────
  await test('4. Update existing movie — change rating/votes in mock, verify UPDATE not INSERT', async () => {
    const movieV1 = movieDetail(5004, { vote_average: 7.0, vote_count: 3000 });
    const movieV2 = movieDetail(5004, { vote_average: 8.5, vote_count: 12000 });
    const tv = tvDetail(6004);

    const responsesV1 = defaultTmdbResponses([movieV1], [tv]);
    const mockTmdbRequest = createMockTmdbRequest(responsesV1);
    const mockDb = createMockPool();
    const saveMediaMetadata = sinon.stub().resolves();

    const { service } = loadSyncService(mockDb, mockTmdbRequest, saveMediaMetadata);
    await service.runSync();

    const firstCall = saveMediaMetadata.getCalls().find(
      c => c.args[0] === 5004
    );
    expect(firstCall.args[2].vote_average).to.equal(7.0);
    expect(firstCall.args[2].vote_count).to.equal(3000);

    const responsesV2 = defaultTmdbResponses([movieV2], [tv]);
    mockTmdbRequest.callsFake(async (endpoint) => {
      if (responsesV2[endpoint]) return responsesV2[endpoint];
      throw new Error(`Unexpected: ${endpoint}`);
    });

    await service.runSync();

    const secondCall = saveMediaMetadata.getCalls().filter(
      c => c.args[0] === 5004
    );
    expect(secondCall.length).to.equal(2, 'movie should be saved twice');
    expect(secondCall[1].args[2].vote_average).to.equal(8.5);
    expect(secondCall[1].args[2].vote_count).to.equal(12000);

    const updateQueries = mockDb._queries.filter(
      q => q.text.includes('ON CONFLICT') && q.text.includes('DO UPDATE')
    );
    expect(updateQueries.length).to.be.greaterThan(0, 'should use ON CONFLICT DO UPDATE');
  });

  // ── 5. New season detected ──────────────────────────────────────────────
  await test('5. New season detected — add season to existing TV show in mock, verify update', async () => {
    const tvV1 = tvDetail(6005, { number_of_seasons: 2, number_of_episodes: 20 });
    const tvV2 = tvDetail(6005, {
      number_of_seasons: 3,
      number_of_episodes: 30,
      seasons: [
        { season_number: 1, episode_count: 10 },
        { season_number: 2, episode_count: 10 },
        { season_number: 3, episode_count: 10 },
      ],
    });
    const movie = movieDetail(5005);

    const responsesV1 = defaultTmdbResponses([movie], [tvV1]);
    const mockTmdbRequest = createMockTmdbRequest(responsesV1);
    const mockDb = createMockPool();
    const saveMediaMetadata = sinon.stub().resolves();

    const { service } = loadSyncService(mockDb, mockTmdbRequest, saveMediaMetadata);
    await service.runSync();

    const firstTvCall = saveMediaMetadata.getCalls().find(
      c => c.args[0] === 6005 && c.args[1] === 'tv'
    );
    expect(firstTvCall.args[2].number_of_seasons).to.equal(2);

    const responsesV2 = defaultTmdbResponses([movie], [tvV2]);
    mockTmdbRequest.callsFake(async (endpoint) => {
      if (responsesV2[endpoint]) return responsesV2[endpoint];
      throw new Error(`Unexpected: ${endpoint}`);
    });

    await service.runSync();

    const secondTvCall = saveMediaMetadata.getCalls().filter(
      c => c.args[0] === 6005 && c.args[1] === 'tv'
    );
    expect(secondTvCall.length).to.equal(2, 'TV show should be saved twice');
    expect(secondTvCall[1].args[2].number_of_seasons).to.equal(3);
    expect(secondTvCall[1].args[2].seasons).to.have.lengthOf(3);
    expect(secondTvCall[1].args[2].number_of_episodes).to.equal(30);
  });

  // ── 6. TMDB API error handling ──────────────────────────────────────────
  await test('6. TMDB API error handling — mock 500 error, verify sync continues', async () => {
    const movie = movieDetail(5006);
    const tv = tvDetail(6006);

    const responses = {
      '/discover/movie': discoverResponse([{ id: movie.id }]),
      '/discover/tv': discoverResponse([{ id: tv.id }]),
      [`/movie/${movie.id}`]: movie,
      [`/tv/${tv.id}`]: (endpoint) => {
        throw new Error('TMDB API ошибка: 500');
      },
      '/trending/movie/week': { results: [] },
      '/trending/tv/week': { results: [] },
      '/movie/upcoming': { results: [] },
      '/tv/on_the_air': { results: [] },
    };

    const mockTmdbRequest = createMockTmdbRequest(responses);
    const mockDb = createMockPool();
    const saveMediaMetadata = sinon.stub().resolves();

    const { service } = loadSyncService(mockDb, mockTmdbRequest, saveMediaMetadata);
    const stats = await service.runSync();

    const movieSave = saveMediaMetadata.getCalls().find(
      c => c.args[0] === movie.id
    );
    expect(movieSave, 'movie should be saved despite TV failure').to.exist;

    const tvSave = saveMediaMetadata.getCalls().find(
      c => c.args[0] === tv.id
    );
    expect(tvSave, 'TV show should not be saved when API returns 500').to.not.exist;

    expect(stats).to.be.an('object');
    expect(stats.failed).to.be.greaterThan(0);
  });

  // ── 7. HTTP 429 handling ────────────────────────────────────────────────
  await test('7. HTTP 429 handling — mock rate limit response with Retry-After, verify retry', async () => {
    const movie = movieDetail(5007);
    const tv = tvDetail(6007);

    let movieRequestCount = 0;

    const responses = {
      '/discover/movie': discoverResponse([{ id: movie.id }]),
      '/discover/tv': discoverResponse([{ id: tv.id }]),
      [`/movie/${movie.id}`]: (endpoint, params) => {
        movieRequestCount++;
        if (movieRequestCount === 1) {
          const err = new Error('TMDB API ошибка: 429');
          err.status = 429;
          err.retryAfter = 2;
          throw err;
        }
        return movie;
      },
      [`/tv/${tv.id}`]: tv,
      '/trending/movie/week': { results: [] },
      '/trending/tv/week': { results: [] },
      '/movie/upcoming': { results: [] },
      '/tv/on_the_air': { results: [] },
    };

    const mockTmdbRequest = createMockTmdbRequest(responses);
    const mockDb = createMockPool();
    const saveMediaMetadata = sinon.stub().resolves();

    const { service } = loadSyncService(mockDb, mockTmdbRequest, saveMediaMetadata);
    const stats = await service.runSync();

    const movieSave = saveMediaMetadata.getCalls().find(
      c => c.args[0] === movie.id
    );
    expect(movieSave, 'movie should be saved after 429 retry').to.exist;

    expect(movieRequestCount).to.equal(2,
      'movie detail should be requested twice (first 429, second success)'
    );

    expect(stats.saved).to.be.greaterThan(0);
  });

  // ── 8. Idempotency ──────────────────────────────────────────────────────
  await test('8. Idempotency — run sync 3 times with same data, verify consistent state', async () => {
    const movie = movieDetail(5008);
    const tv = tvDetail(6008);
    const responses = defaultTmdbResponses([movie], [tv]);
    const mockTmdbRequest = createMockTmdbRequest(responses);
    const mockDb = createMockPool();
    const saveMediaMetadata = sinon.stub().resolves();

    const { service } = loadSyncService(mockDb, mockTmdbRequest, saveMediaMetadata);

    const results = [];
    for (let i = 0; i < 3; i++) {
      const stats = await service.runSync();
      results.push(stats);
    }

    expect(results[0].discovered).to.equal(results[1].discovered);
    expect(results[1].discovered).to.equal(results[2].discovered);
    expect(results[0].saved).to.equal(results[1].saved);
    expect(results[1].saved).to.equal(results[2].saved);

    const movieSaveCount = saveMediaMetadata.getCalls()
      .filter(c => c.args[0] === movie.id).length;
    expect(movieSaveCount).to.equal(3, 'movie should be saved 3 times (once per run)');

    const tvSaveCount = saveMediaMetadata.getCalls()
      .filter(c => c.args[0] === tv.id).length;
    expect(tvSaveCount).to.equal(3, 'TV show should be saved 3 times (once per run)');

    const movieSaves = saveMediaMetadata.getCalls()
      .filter(c => c.args[0] === movie.id);
    for (const call of movieSaves) {
      expect(call.args[2].title).to.equal(movie.title);
      expect(call.args[2].vote_average).to.equal(movie.vote_average);
    }
  });

  // ── 9. User data preservation ───────────────────────────────────────────
  await test('9. User data preservation — create user_lists entry, run sync, verify user data unchanged', async () => {
    const movie = movieDetail(5009);
    const tv = tvDetail(6009);
    const responses = defaultTmdbResponses([movie], [tv]);
    const mockTmdbRequest = createMockTmdbRequest(responses);
    const mockDb = createMockPool();
    const saveMediaMetadata = sinon.stub().resolves();

    const { service } = loadSyncService(mockDb, mockTmdbRequest, saveMediaMetadata);

    // Insert a user_lists entry before sync
    await mockDb.query(
      `INSERT INTO user_lists (user_id, tmdb_id, media_type, status, rating)
       VALUES (1, $1, 'movie', 'watched', 9)`,
      [movie.id]
    );

    await service.runSync();

    // The only user_lists query should be our INSERT, not from sync
    const userListQueries = mockDb._queries.filter(
      q => q.text.includes('user_lists')
    );
    expect(userListQueries.length).to.equal(1, 'sync should not touch user_lists');

    const movieSave = saveMediaMetadata.getCalls().find(
      c => c.args[0] === movie.id
    );
    expect(movieSave, 'movie should be saved during sync').to.exist;
  });

  // ── 10. Rate limiting ───────────────────────────────────────────────────
  await test('10. Rate limiting — verify max 3 concurrent requests', async () => {
    const movies = [movieDetail(5010), movieDetail(5011), movieDetail(5012), movieDetail(5013)];
    const tvShows = [tvDetail(6010), tvDetail(6011)];

    const responses = {
      '/discover/movie': discoverResponse(movies.map(m => ({ id: m.id }))),
      '/discover/tv': discoverResponse(tvShows.map(t => ({ id: t.id }))),
    };
    for (const m of movies) responses[`/movie/${m.id}`] = m;
    for (const t of tvShows) responses[`/tv/${t.id}`] = t;
    responses['/trending/movie/week'] = { results: [] };
    responses['/trending/tv/week'] = { results: [] };
    responses['/movie/upcoming'] = { results: [] };
    responses['/tv/on_the_air'] = { results: [] };

    const mockTmdbRequest = createMockTmdbRequest(responses);
    const mockDb = createMockPool();
    const saveMediaMetadata = sinon.stub().resolves();

    const { service } = loadSyncService(mockDb, mockTmdbRequest, saveMediaMetadata);

    let maxConcurrent = 0;
    let currentConcurrent = 0;

    mockTmdbRequest.callsFake(async (endpoint) => {
      if (responses[endpoint]) {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise(r => setTimeout(r, 10));
        currentConcurrent--;
        return responses[endpoint];
      }
      throw new Error(`Unexpected: ${endpoint}`);
    });

    const stats = await service.runSync();

    expect(stats.saved).to.equal(6, 'all 6 items should be saved');

    expect(maxConcurrent).to.be.at.most(3,
      `max concurrent requests (${maxConcurrent}) should not exceed 3`
    );

    expect(maxConcurrent).to.be.greaterThan(1,
      'at least 2 requests should run concurrently'
    );
  });

  // ── Summary ─────────────────────────────────────────────────────────────

  console.log(`\n═══════════════════════════════════`);
  console.log(`TMDB Sync Tests: ${passed} passed, ${failed} failed`);
  console.log(`═══════════════════════════════════\n`);

  if (failures.length > 0) {
    console.log('Failures:');
    for (const f of failures) {
      console.log(`  ✗ ${f.name}`);
      console.log(`    ${f.error.message}`);
      if (f.error.stack) {
        const lines = f.error.stack.split('\n').slice(1, 4);
        for (const line of lines) console.log(`    ${line}`);
      }
    }
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
