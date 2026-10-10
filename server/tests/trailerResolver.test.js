const assert = require('assert');
const { TrailerResolver, scoreCandidate } = require('../services/trailerResolver');

const context = { tmdbId: 1, mediaType: 'movie', title: 'Интерстеллар', originalTitle: 'Interstellar', year: 2014 };
const candidate = (overrides) => ({ source: 'youtube', videoId: Math.random().toString(36), url: 'https://example.test/watch', embedUrl: 'https://example.test/embed', language: 'en', type: 'Trailer', official: false, title: 'Interstellar Trailer 2014', ...overrides });

async function run() {
  assert(scoreCandidate(candidate({ language: 'ru', official: true, title: 'Интерстеллар — официальный трейлер (2014)' }), context) > scoreCandidate(candidate({ language: 'en', official: true }), context));
  assert(scoreCandidate(candidate({ language: 'ru', title: 'Интерстеллар обзор' }), context) < 0);
  const saved = []; const cache = { findBest: async () => null, asTrailer: (row) => row, save: async (_, __, value) => { saved.push(value); return value; }, markUnavailable: async () => 1 };
  const provider = { constructor: { name: 'FakeProvider' }, search: async () => [candidate({ videoId: 'bad', language: 'ru', title: 'Интерстеллар обзор' }), candidate({ videoId: 'original', official: true }), candidate({ source: 'vk', videoId: 'ru', language: 'ru', official: true, title: 'Интерстеллар официальный трейлер 2014' })] };
  const resolver = new TrailerResolver({ providers: [provider], cache });
  const selected = await resolver.resolve(context);
  assert.equal(selected.trailer.videoId, 'original');
  const fallback = await resolver.unavailable({ ...context, source: 'youtube', videoId: 'original' });
  assert.equal(fallback.trailer.source, 'vk');
  assert.equal(saved.length, 2);
  const rutube = { constructor: { name: 'RutubeProvider' }, search: async () => [candidate({ source: 'rutube', videoId: 'rutube', language: 'ru', title: 'Интерстеллар трейлер' })] };
  const youtube = { constructor: { name: 'YouTubeProvider' }, search: async () => [candidate({ source: 'youtube', videoId: 'youtube', language: 'ru', official: true, title: 'Интерстеллар официальный трейлер 2014' })] };
  const priorityResolver = new TrailerResolver({ providers: [rutube, youtube], cache: { ...cache, findBest: async () => null } });
  const prioritized = await priorityResolver.resolve(context);
  assert.equal(prioritized.trailer.source, 'rutube');
  console.log('trailerResolver tests passed');
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
