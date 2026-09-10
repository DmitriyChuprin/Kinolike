/**
 * Tests for AI Search Service
 * Run: node server/tests/aiSearch.test.js
 */

const {
  validateSearchParams, fallback_parse, keywordRelevance,
  calculate_query_match, calculate_personal_match, calculate_positive_similarity,
  calculate_negative_similarity, calculate_quality_score,
  apply_diversity, getPersonalWeight,
} = require('../services/aiSearch');
const config = require('../services/recommendationConfig');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }
function assertEq(a, b, m) { if (a !== b) throw new Error(`${m || ''}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

// ─── validateSearchParams ───────────────────────────────────────────
console.log('\n=== validateSearchParams ===');

test('valid params pass', () => {
  assert(validateSearchParams({ genres: ['35'], excluded_genres: [], keywords: [], excluded_keywords: [], mood: [], similar_to: [] }));
});

test('invalid genre IDs removed', () => {
  const p = { genres: ['35', '999', '878'], excluded_genres: [], keywords: [], excluded_keywords: [], mood: [], similar_to: [] };
  validateSearchParams(p);
  assertEq(p.genres.length, 2);
});

test('similar_to string normalized to array', () => {
  const p = { genres: [], excluded_genres: [], keywords: [], excluded_keywords: [], mood: [], similar_to: 'Interstellar' };
  validateSearchParams(p);
  assert(Array.isArray(p.similar_to));
  assertEq(p.similar_to.length, 1);
});

test('year swap when from > to', () => {
  const p = { genres: [], excluded_genres: [], keywords: [], excluded_keywords: [], mood: [], similar_to: [], year_from: 2025, year_to: 2020 };
  validateSearchParams(p);
  assertEq(p.year_from, 2020);
  assertEq(p.year_to, 2025);
});

test('invalid request_type corrected', () => {
  const p = { genres: [], excluded_genres: [], keywords: [], excluded_keywords: [], mood: [], similar_to: [], request_type: 'invalid' };
  validateSearchParams(p);
  assertEq(p.request_type, 'recommendation');
});

// ─── fallback_parse ─────────────────────────────────────────────────
console.log('\n=== fallback_parse ===');

test('romantic comedy detected', () => {
  const p = fallback_parse('Посоветуй романтическую комедию');
  assert(p.genres.includes('10749'));
  assert(p.genres.includes('35'));
});

test('thriller without horror', () => {
  const p = fallback_parse('Триллер без ужасов');
  assert(p.genres.includes('53'));
  assert(p.excluded_genres.includes('27'));
});

test('similar to detected', () => {
  const p = fallback_parse('Что-нибудь похожее на Интерстеллар');
  assertEq(p.request_type, 'similar');
  assert(p.similar_to[0].includes('нтерстеллар'));
});

test('year detection', () => {
  const p = fallback_parse('Фильм после 2020 года');
  assert(p.year_from >= 2020);
});

test('mood detection', () => {
  const p = fallback_parse('Что-нибудь лёгкое на вечер');
  assert(p.mood.includes('light'));
});

// ─── keywordRelevance ───────────────────────────────────────────────
console.log('\n=== keywordRelevance ===');

test('zero keywords returns 0', () => assertEq(keywordRelevance(['a'], [], []), 0));
test('all match returns 1', () => assertEq(keywordRelevance(['space', 'travel'], ['space', 'travel'], []), 1));
test('partial match returns fraction', () => assertEq(keywordRelevance(['space'], ['space', 'travel'], []), 0.5));
test('excluded keyword returns negative', () => assert(keywordRelevance(['horror'], ['movie'], ['horror']) < 0));

// ─── Scoring Components ─────────────────────────────────────────────
console.log('\n=== Scoring Components ===');

test('calculate_query_match: genre overlap', () => {
  const c = { data: { genres: [{ id: 35 }, { id: 18 }] }, keywordOverlap: 0, genre_ids: [35, 18] };
  assert(calculate_query_match(c, { genres: ['35'], keywords: [] }, null) > 0);
});

test('calculate_quality_score: high rating', () => {
  const c = { data: { vote_average: 8.5, vote_count: 1000 } };
  assert(calculate_quality_score(c) > 50);
});

test('calculate_quality_score: low rating', () => {
  const c = { data: { vote_average: 3.0, vote_count: 10 } };
  assert(calculate_quality_score(c) < 30);
});

test('calculate_personal_match: no profile returns 0', () => {
  assertEq(calculate_personal_match({ data: {}, tmdb_id: 1, media_type: 'movie', title: 'x' }, null), 0);
});

test('calculate_positive_similarity: no profile returns 0', () => {
  assertEq(calculate_positive_similarity({ data: {}, tmdb_id: 1, media_type: 'movie', title: 'x' }, null), 0);
});

// ─── Adaptive Weights ───────────────────────────────────────────────
console.log('\n=== Adaptive Weights ===');

test('few ratings → low personal weight', () => {
  assert(getPersonalWeight(2) <= 0.05);
});

test('many ratings → high personal weight', () => {
  assert(getPersonalWeight(50) >= 0.30);
});

test('medium ratings → medium weight', () => {
  const w = getPersonalWeight(15);
  assert(w >= 0.20 && w <= 0.40);
});

// ─── apply_diversity ────────────────────────────────────────────────
console.log('\n=== apply_diversity ===');

test('limits results per genre', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({
    score: 90 - i,
    candidate: { data: { genres: [{ id: 35 }] }, tmdb_id: i },
  }));
  assert(apply_diversity(items, 5).length <= 5);
});

test('mixed genres pass through', () => {
  const items = [
    { score: 90, candidate: { data: { genres: [{ id: 35 }] }, tmdb_id: 1 } },
    { score: 85, candidate: { data: { genres: [{ id: 28 }] }, tmdb_id: 2 } },
    { score: 80, candidate: { data: { genres: [{ id: 18 }] }, tmdb_id: 3 } },
  ];
  assertEq(apply_diversity(items, 10).length, 3);
});

// ─── Config Weights ─────────────────────────────────────────────────
console.log('\n=== Config Weights ===');

test('AI_SEARCH_WEIGHTS exist', () => {
  assert(config.AI_SEARCH_WEIGHTS);
  assert(typeof config.AI_SEARCH_WEIGHTS.query_match === 'number');
  assert(typeof config.AI_SEARCH_WEIGHTS.personal_match === 'number');
});

test('AI_SEARCH_ADAPTIVE exist', () => {
  assert(config.AI_SEARCH_ADAPTIVE);
  assert(config.AI_SEARCH_ADAPTIVE.personal_match_high > config.AI_SEARCH_ADAPTIVE.personal_match_min);
});

test('AI_RERANK constants exist', () => {
  assert(config.AI_RERANK_TOP_N > 0);
  assert(config.AI_RERANK_FINAL_N > 0);
});

// ─── Summary ────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
