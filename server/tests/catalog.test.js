const assert = require('node:assert/strict');
const { createCatalogService } = require('../services/catalog');

async function run() {
  const calls = [];
  const service = createCatalogService(async (endpoint, params) => {
    calls.push({ endpoint, params });
    if (endpoint.startsWith('/discover/')) return { total_pages: 900, total_results: 18000, results: [{ id: 5 }] };
    if (endpoint === '/movie/popular') return { total_pages: 2, results: [{ id: 8 }] };
    if (endpoint === '/search/tv') return { total_pages: 1, results: [{ id: 1, name: 'TV', first_air_date: '2020-01-01', vote_average: 8, popularity: 20 }] };
    return { total_pages: 2, results: params.page === 1
      ? [{ id: 1, title: 'First page', release_date: '2020-01-01', vote_average: 3, popularity: 10 }]
      : [{ id: 2, title: 'Second page', release_date: '2020-10-01', vote_average: 9, popularity: 50 }, { id: 3, title: 'Wrong year', release_date: '2019-01-01', vote_average: 10 }] };
  });
  const result = await service.search({ query: 'test', type: 'multi', year: '2020', sort: 'rating' });
  assert.deepEqual(result.results.map(item => `${item.media_type}:${item.id}`), ['movie:2', 'tv:1', 'movie:1']);
  assert.equal(result.total_results, 3);
  assert(calls.some(call => call.endpoint === '/search/movie' && call.params.primary_release_year === '2020'));
  assert(calls.some(call => call.endpoint === '/search/tv' && call.params.first_air_date_year === '2020'));
  const callCount = calls.length;
  const byDate = await service.search({ query: 'test', type: 'multi', year: '2020', sort: 'year' });
  assert.equal(byDate.results[0].id, 2);
  assert.equal(calls.length, callCount, 'Changing sort reuses the complete cached set');
  const genre = await service.catalog({ type: 'tv', genre: '18', page: '2' });
  assert.equal(genre.results[0].media_type, 'tv');
  assert.equal(genre.total_pages, 500);
  assert.equal(calls.at(-1).endpoint, '/discover/tv');
  assert.equal(calls.at(-1).params.with_genres, '18');
  await service.catalog({ collection: 'popular' });
  assert.equal(calls.at(-1).endpoint, '/movie/popular');
  await assert.rejects(service.catalog({ collection: '__proto__' }), /Неизвестная/);
  await assert.rejects(service.search({ query: 'test', type: '../movie' }), /Неизвестный/);
  await assert.rejects(service.search({ query: 'test', year: '20' }), /четырёх/);
  await assert.rejects(service.search({ query: 'test', page: '-1' }), /страница/);

  const many = createCatalogService(async (_, params) => ({ total_pages: 3, results: Array.from({ length: 20 }, (_, i) => ({ id: (params.page - 1) * 20 + i, title: 'Movie', vote_average: params.page, popularity: params.page })) }));
  const first = await many.search({ query: 'test', type: 'movie', sort: 'rating' });
  const second = await many.search({ query: 'test', type: 'movie', sort: 'rating', page: 2 });
  assert.equal(first.total_results, 60);
  assert.equal(first.total_pages, 3);
  assert(first.results.every(item => item.vote_average === 3), 'Highest-rated page must come first');
  assert(second.results.every(item => item.vote_average === 2));
  assert(!second.results.some(item => first.results.some(other => item.id === other.id)));

  const excessive = createCatalogService(async () => ({ total_pages: 51, results: [] }));
  await assert.rejects(excessive.search({ query: 'test', sort: 'rating' }), error => error.status === 422);
  const failing = createCatalogService(async (_, params) => { if (params.page === 2) throw new Error('upstream unavailable'); return { total_pages: 2, results: [{ id: 1 }] }; });
  await assert.rejects(failing.search({ query: 'test', sort: 'rating' }), /upstream unavailable/, 'Never present partial results as globally sorted');
  console.log('Catalog and complete search pagination: OK');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
