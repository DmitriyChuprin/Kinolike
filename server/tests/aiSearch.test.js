/**
 * Tests for AI Search Service
 * Run: node server/tests/aiSearch.test.js
 */

const {
  validateSearchParams, fallback_parse, keywordRelevance,
  calculate_query_match, calculate_personal_match, calculate_positive_similarity,
  calculate_negative_similarity, calculate_quality_score,
  calculate_mainstream_score, calculate_vote_confidence, calculate_freshness_score,
  rank_candidates, apply_diversity, getPersonalWeight,
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

test('null optional arrays normalized to empty arrays', () => {
  const p = { genres: ['35'], excluded_genres: null, keywords: null, excluded_keywords: null, mood: ['light'], similar_to: null };
  assert(validateSearchParams(p));
  assertEq(p.similar_to.length, 0);
  assertEq(p.keywords.length, 0);
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

test('Russian word duration and five-year TV miniseries are parsed', () => {
  const p = fallback_parse('Хочу детективный мини-сериал последних пяти лет примерно на два часа');
  assertEq(p.media_type, 'tv');
  assertEq(p.runtime_max, 135);
  assertEq(p.year_to - p.year_from + 1, 5);
  assert(p.genres.includes('9648'));
});

test('family viewing is mapped to the family genre', () => {
  assert(fallback_parse('Что посмотреть с семьёй?').genres.includes('10751'));
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

// ─── Mainstream/era-aware ranking ──────────────────────────────────
console.log('\n=== Mainstream and era-aware ranking ===');

test('fallback parser detects mainstream context', () => {
  const p = fallback_parse('Посоветуй что-нибудь популярное посмотреть вечером');
  assert(p.prefer_mainstream === true);
  assert(p.prefer_hidden_gems === false);
});

test('fallback parser relaxes mainstream for hidden gems and classics', () => {
  const hidden = fallback_parse('Посоветуй малоизвестную хорошую фантастику');
  const classic = fallback_parse('Посоветуй классический фильм 70-х');
  assert(hidden.prefer_hidden_gems === true);
  assert(hidden.prefer_mainstream === false);
  assert(classic.prefer_classics === true);
  assert(classic.year_from === 1970);
  assert(classic.year_to === 1979);
});

test('vote confidence grows logarithmically', () => {
  const candidate = votes => ({ data: { vote_average: 7.5, vote_count: votes, popularity: 20 } });
  const low = calculate_vote_confidence(candidate(50));
  const acceptable = calculate_vote_confidence(candidate(500));
  const high = calculate_vote_confidence(candidate(5000));
  assert(low < acceptable && acceptable < high);
  assert(high - acceptable < acceptable - low || high - acceptable < 25, 'confidence should have diminishing returns');
});

test('popular modern title beats highly rated obscure old title', () => {
  const makeCandidate = (id, year, rating, votes, popularity) => ({
    tmdb_id: id, media_type: 'movie', title: `Movie ${id}`, genre_ids: [35],
    data: {
      id, title: `Movie ${id}`, genres: [{ id: 35, name: 'Comedy' }],
      overview: 'A complete movie overview for ranking tests.',
      keywords: { keywords: [{ id: 1, name: 'evening' }] },
      release_date: `${year}-01-01`, vote_average: rating, vote_count: votes, popularity,
      credits: { crew: [], cast: [] },
    },
  });
  const old = makeCandidate(401, 1973, 8.1, 70, 5);
  const modern = makeCandidate(402, 2018, 7.7, 15000, 80);
  assert(calculate_mainstream_score(modern) > calculate_mainstream_score(old));
  const params = { genres: ['35'], keywords: [], prefer_mainstream: true, prefer_hidden_gems: false, prefer_classics: false, prefer_recent: false };
  const userProfile = { ratedCount: 0, profile: { isSufficient: false } };
  const ranked = rank_candidates([old, modern], params, userProfile, null);
  assert(ranked[0].candidate.tmdb_id === 402);
  assert(ranked[0].components.vote_confidence > ranked[1].components.vote_confidence);
});

test('standard composition limits niche titles', () => {
  const makeCandidate = (id, mainstream) => ({
    tmdb_id: id, media_type: 'movie', title: `Movie ${id}`, genre_ids: [id],
    data: {
      id, title: `Movie ${id}`, genres: [{ id, name: `Genre ${id}` }],
      overview: 'A complete movie overview for composition tests.',
      keywords: { keywords: [{ id: 1, name: 'test' }] }, release_date: '2018-01-01',
      vote_average: mainstream ? 7.8 : 6.2, vote_count: mainstream ? 15000 : 300,
      popularity: mainstream ? 80 : 1, credits: { crew: [], cast: [] },
    },
  });
  const params = { genres: [], keywords: [], prefer_mainstream: true, prefer_hidden_gems: false, prefer_classics: false, prefer_recent: false };
  const userProfile = { ratedCount: 0, profile: { isSufficient: false } };
  const ranked = rank_candidates([
    ...Array.from({ length: 8 }, (_, i) => makeCandidate(500 + i, true)),
    ...Array.from({ length: 4 }, (_, i) => makeCandidate(600 + i, false)),
  ], params, userProfile, null);
  const selected = apply_diversity(ranked, 10, params);
  const niche = selected.filter(item => item.components.mainstream_score < config.MAINSTREAM_SCORE_MIN);
  assert(niche.length <= 2, `too many niche titles in standard top 10: ${niche.length}`);
  assert(selected.length >= 8, 'composition pass should keep a useful result set');
});

// ─── Summary ────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
