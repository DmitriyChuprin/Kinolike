const assert = require('assert');
const { __test } = require('../services/tmdb');

const today = new Date('2026-09-30T23:59:59.999Z');
const start = __test.sixMonthsAgo(today);
const items = __test.normalizeRussianNew([
  { id: 1, title: 'Свежий и заметный', original_title: 'Свежий и заметный', poster_path: '/fresh.jpg', release_date: '2026-09-20', popularity: 12, vote_average: 0, vote_count: 0 },
  { id: 2, title: 'Старый', poster_path: '/old.jpg', release_date: '2025-09-20', popularity: 100, vote_average: 9, vote_count: 1000 },
  { id: 3, title: 'Без постера', poster_path: null, release_date: '2026-09-20', popularity: 100, vote_average: 9, vote_count: 1000 },
  { id: 4, title: 'Малоизвестный', poster_path: '/quiet.jpg', release_date: '2026-06-20', popularity: 1, vote_average: 9, vote_count: 1 },
], 'movie', today, start);

assert.deepStrictEqual(items.map((item) => item.id), [1], 'fresh popular releases remain; old, posterless and low-signal items are rejected');
assert(items[0].score > 0, 'the selected item receives a normalized score');
console.log('Russian new releases ranking tests passed');
