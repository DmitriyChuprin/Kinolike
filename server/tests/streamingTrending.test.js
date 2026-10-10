const assert = require('assert');
const { scoreMatch, __test } = require('../services/streamingTrending');

assert.strictEqual(__test.comparable('Слово пацана: Кровь!'), 'слово пацана кровь');
const exactTv = scoreMatch({ title: 'Слово пацана', year: 2023, mediaType: 'tv' }, { name: 'Слово пацана', first_air_date: '2023-11-09', media_type: 'tv', popularity: 10 });
const sameTitleMovie = scoreMatch({ title: 'Слово пацана', year: 2023, mediaType: 'tv' }, { title: 'Слово пацана', release_date: '2023-01-01', media_type: 'movie', popularity: 10 });
assert(exactTv >= 72, 'exact title/year/type is accepted');
assert(sameTitleMovie < 72, 'movie with same Russian title is rejected for a TV source');
console.log('Streaming trending scoring tests passed');
