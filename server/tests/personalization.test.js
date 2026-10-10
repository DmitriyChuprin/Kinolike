const assert = require('assert');
const { buildTasteProfile, validatePreferences, deterministicSummary } = require('../services/tasteProfile');
const { adjustmentFor } = require('../services/recommendationHistory');
const { build_user_profile, movie_data, reason_for, candidate_passes_thresholds, generate_recommendations } = require('../services/personalRecommendations');

const item = (id, rating, genre, year = 2020) => ({
  tmdb_id: id, media_type: id % 2 ? 'movie' : 'tv', rating, watched_at: '2026-02-01',
  details: { id, title: `Title ${id}`, genres: [{ id: genre, name: genre === 878 ? 'Фантастика' : 'Ужасы' }],
    release_date: `${year}-01-01`, original_language: 'en', runtime: 110, popularity: 50, vote_average: 8, vote_count: 5000,
    production_countries: [{ iso_3166_1: 'US', name: 'США' }], credits: { crew: [{ id: 1, name: 'Director', job: 'Director' }], cast: [{ id: 2, name: 'Actor' }] }, keywords: { keywords: [] } },
});

const profile = buildTasteProfile([item(1, 10, 878), item(2, 2, 27)]);
assert.strictEqual(profile.sampleSize, 2);
assert.strictEqual(profile.mediaBalance.movies, 1);
assert.strictEqual(profile.mediaBalance.tv, 1);
assert.strictEqual(profile.favoriteGenres[0].name, 'Фантастика');
assert.strictEqual(profile.dislikedGenres[0].name, 'Ужасы');
assert(profile.summary.includes('фантастик'));
assert(deterministicSummary({ sampleSize: 0 }).includes('Добавляйте'));
assert.strictEqual(buildTasteProfile([]).sampleSize, 0, 'new user gets a valid empty profile');
assert.strictEqual(buildTasteProfile(Array.from({ length: 120 }, (_, index) => item(index + 10, 7 + index % 4, 878))).sampleSize, 120, 'large histories aggregate without truncation');

const preferences = validatePreferences({ genre_preferences: { 878: 'love', 27: 'dislike', 35: 'invalid' }, min_year: 2000, runtime_max: 120 });
assert.deepStrictEqual(preferences.genre_preferences, { 27: 'dislike', 878: 'love' });
assert.throws(() => validatePreferences({ min_year: 2030, max_year: 2000 }));

const feedback = adjustmentFor(item(4, null, 27).details, { genres: new Map([['27', -8]]), actors: new Map(), directors: new Map(), oldPenalty: 0, unknownPenalty: 0 });
assert(feedback.adjustment < 0);
assert(feedback.signals.includes('rejected_genre'));

const oldClassic = item(3, null, 878, 1970); oldClassic.imdb_rating = 8.2; oldClassic.imdb_votes = 50000; oldClassic.details.vote_count = 80; oldClassic.details.popularity = 1;
assert(candidate_passes_thresholds(oldClassic), 'recognized IMDb classic passes dynamic quality gate');
const obscure = item(5, null, 878, 1970); obscure.details.vote_count = 80; obscure.details.popularity = 1;
assert(!candidate_passes_thresholds(obscure), 'obscure low-confidence title fails default gate');

const watched = [item(1, 10, 878), item(7, 9, 878)];
const taste = build_user_profile(watched); const candidate = movie_data(item(9, null, 878));
const reasons = reason_for(candidate, taste);
assert(Array.isArray(reasons.structured_reasons.genres));
assert(Array.isArray(reasons.structured_reasons.similarTo));
const generated = generate_recommendations({ watched, candidates: [item(9, null, 878)] });
assert(generated.recommendations.every(rec => rec.structured_reasons && rec.score_components));

console.log('Personalization platform: OK');
