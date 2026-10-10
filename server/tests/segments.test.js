const assert = require('assert');
const segments = require('../services/segments');

const input = { imdbId: 'tt0903747', mediaType: 'tv', season: 1, episode: 1, duration: 3500 };
assert.match(segments.introDbUrl(input), /imdb_id=tt0903747/);
assert.match(segments.introDbUrl(input), /season=1/);
assert.deepStrictEqual(segments.validSegment({ start_ms: 61000, end_ms: 91000 }, 100), { start: 61, end: 91 });
assert.strictEqual(segments.validSegment({ start_ms: 1000, end_ms: 1000 }, 100), null);
assert.strictEqual(segments.validSegment({ start_ms: 120000, end_ms: 130000 }, 100), null);

async function run() {
  const introResponse = { intro: null, outro: { start_sec: 3431, end_sec: 3500 } };
  const result = await segments.fetchSegments(input, async () => ({ ok: true, json: async () => introResponse }));
  assert.deepStrictEqual(result, { intro: null, credits: { start: 3431, end: 3500 }, source: 'introdb' });

  let calls = 0;
  const fallback = await segments.fetchSegments(input, async () => {
    calls += 1;
    return { ok: true, json: async () => calls === 1 ? { intro: null, outro: null } : { segments: { intro: { start_ms: 61000, end_ms: 91000 }, outro: null } } };
  });
  assert.deepStrictEqual(fallback, { intro: { start: 61, end: 91 }, credits: null, source: 'skipdb' });
  assert.strictEqual(calls, 2, 'SkipDB is only called after IntroDB has no usable segments');
  console.log('✓ Streaming segment providers normalize IntroDB/SkipDB and fall back safely');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
