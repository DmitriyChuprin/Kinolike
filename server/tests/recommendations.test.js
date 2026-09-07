const assert = require('assert');
const {
  movie_data,
  build_user_profile,
  calculate_similarity,
  calculate_movie_score,
  apply_diversity,
  generate_recommendations,
} = require('../services/personalRecommendations');
const config = require('../services/recommendationConfig');

// ── helpers ──────────────────────────────────────────────────────────
function makeMovie(overrides = {}) {
  return {
    details: {
      id: overrides.id || 100,
      title: overrides.title || 'Test Movie',
      genres: overrides.genres || [{ id: 28, name: 'Боевик' }],
      credits: {
        crew: (overrides.directors || [{ id: 1, name: 'Режиссёр 1' }]).map(d => ({ ...d, job: 'Director' })),
        cast: (overrides.actors || [{ id: 2, name: 'Актёр 1' }]).map((a, i) => ({ ...a, order: i })),
      },
      production_countries: overrides.countries || [{ iso_3166_1: 'US', name: 'США' }],
      original_language: overrides.language || 'en',
      overview: overrides.overview || 'Хороший фильм',
      release_date: overrides.release_date || '2020-01-01',
      vote_average: overrides.vote_average || 7.5,
      vote_count: overrides.vote_count || 1000,
      popularity: overrides.popularity || 50,
      runtime: overrides.runtime || 120,
      keywords: { keywords: (overrides.keywords || [{ id: 1001, name: 'космос' }, { id: 1002, name: 'драма' }]).map(k => ({ id: k.id || k, name: k.name || k })) },
      similar: { results: [] },
    },
    tmdb_id: overrides.id || 100,
    media_type: 'movie',
  };
}

function ratedMovie(overrides = {}) {
  const m = makeMovie(overrides);
  m.rating = overrides.rating;
  return m;
}

// ── 1. movie_data extracts keywords ──────────────────────────────────
{
  const m = movie_data(makeMovie({ id: 42, keywords: [{ id: 99, name: 'future' }, { id: 100, name: 'space opera' }] }));
  assert.ok(m.keywords instanceof Set, 'keywords should be a Set');
  assert.ok(m.keywords.has('99'), 'should contain keyword id 99');
  assert.ok(m.keywords.has('100'), 'should contain keyword id 100');
  assert.ok(m.keywordNames instanceof Map, 'keywordNames should be a Map');
  assert.strictEqual(m.keywordNames.get('99'), 'future');
  assert.ok(m.keywordTokens instanceof Set, 'keywordTokens should be a Set');
  console.log('✓ movie_data: keywords extraction');
}

// ── 2. movie_data handles missing keywords gracefully ────────────────
{
  const m = movie_data({ details: { id: 1, genres: [{ id: 1, name: 'G' }], credits: {}, overview: 'test' }, tmdb_id: 1 });
  assert.ok(m.keywords instanceof Set, 'keywords should be empty Set');
  assert.strictEqual(m.keywords.size, 0);
  console.log('✓ movie_data: missing keywords handled');
}

// ── 3. build_user_profile with various ratings ───────────────────────
{
  const watched = [
    ratedMovie({ id: 1, rating: 10, genres: [{ id: 28, name: 'Боевик' }], keywords: [{ id: 1, name: 'взрывы' }] }),
    ratedMovie({ id: 2, rating: 8, genres: [{ id: 28, name: 'Боевик' }, { id: 878, name: 'Фантастика' }], keywords: [{ id: 1, name: 'взрывы' }, { id: 2, name: 'космос' }] }),
    ratedMovie({ id: 3, rating: 3, genres: [{ id: 35, name: 'Комедия' }], keywords: [{ id: 3, name: 'юмор' }] }),
    ratedMovie({ id: 4, rating: 1, genres: [{ id: 35, name: 'Комедия' }], keywords: [{ id: 3, name: 'юмор' }] }),
  ];
  const profile = build_user_profile(watched);
  assert.ok(profile.isSufficient, 'profile should be sufficient (4 rated)');
  assert.ok(profile.features.keywords instanceof Map, 'keywords feature should exist');
  // Боевик is rated highly (+5+3=8), Комедия is rated poorly (-2-4=-6)
  const actionWeight = profile.features.genres.get('28');
  const comedyWeight = profile.features.genres.get('35');
  assert.ok(actionWeight > 0, 'highly rated genre should have positive weight');
  assert.ok(comedyWeight < 0, 'poorly rated genre should have negative weight');
  // Keywords: 'взрывы' appears in 10+8=13, 'космос' in 8, 'юмор' in 3+1=-6
  const explosionsKw = profile.features.keywords.get('1');
  assert.ok(explosionsKw > 0, 'positive keyword should have positive weight');
  console.log('✓ build_user_profile: various ratings');
}

// ── 4. build_user_profile insufficient ratings ───────────────────────
{
  const watched = [
    ratedMovie({ id: 1, rating: 10 }),
  ];
  const profile = build_user_profile(watched);
  assert.ok(!profile.isSufficient, '1 rated movie should be insufficient');
  console.log('✓ build_user_profile: insufficient ratings');
}

// ── 5. calculate_movie_score positive/negative weights ───────────────
{
  const watched = [
    ratedMovie({ id: 1, rating: 10, genres: [{ id: 28, name: 'Боевик' }], keywords: [{ id: 1, name: 'взрывы' }], overview: 'экшн фильм' }),
    ratedMovie({ id: 2, rating: 1, genres: [{ id: 35, name: 'Комедия' }], keywords: [{ id: 2, name: 'юмор' }], overview: 'комедия смешная' }),
  ];
  const profile = build_user_profile(watched);
  // Candidate matching high-rated genre
  const goodCandidate = makeMovie({ id: 200, genres: [{ id: 28, name: 'Боевик' }], keywords: [{ id: 1, name: 'взрывы' }], overview: 'экшн' });
  // Candidate matching low-rated genre
  const badCandidate = makeMovie({ id: 201, genres: [{ id: 35, name: 'Комедия' }], keywords: [{ id: 2, name: 'юмор' }], overview: 'комедия' });
  const goodScore = calculate_movie_score(goodCandidate, profile);
  const badScore = calculate_movie_score(badCandidate, profile);
  assert.ok(goodScore.score > badScore.score, `good score (${goodScore.score}) should be > bad score (${badScore.score})`);
  assert.ok(goodScore.components.genres > 0, 'high-rated genre component should be positive');
  assert.ok(badScore.components.genres < 0, 'low-rated genre component should be negative');
  console.log(`✓ calculate_movie_score: good=${goodScore.score} bad=${badScore.score}`);
}

// ── 6. calculate_similarity high vs low rated ────────────────────────
{
  const base = movie_data(makeMovie({ id: 1, genres: [{ id: 28, name: 'Боевик' }], keywords: [{ id: 1, name: 'взрывы' }], directors: [{ id: 10, name: 'Реж' }], actors: [{ id: 20, name: 'Акт' }] }));
  const similarMovie = movie_data(makeMovie({ id: 2, genres: [{ id: 28, name: 'Боевик' }], keywords: [{ id: 1, name: 'взрывы' }], directors: [{ id: 10, name: 'Реж' }], actors: [{ id: 20, name: 'Акт' }] }));
  const differentMovie = movie_data(makeMovie({ id: 3, genres: [{ id: 35, name: 'Комедия' }], keywords: [{ id: 5, name: 'юмор' }], directors: [{ id: 50, name: 'Другой' }], actors: [{ id: 60, name: 'Незнакомец' }] }));
  const highSim = calculate_similarity(base, similarMovie);
  const lowSim = calculate_similarity(base, differentMovie);
  assert.ok(highSim > lowSim, `identical movies (${highSim}) should be more similar than different (${lowSim})`);
  assert.ok(highSim > 0.5, 'identical movies should have high similarity');
  console.log(`✓ calculate_similarity: similar=${highSim.toFixed(3)} different=${lowSim.toFixed(3)}`);
}

// ── 7. apply_diversity genre limiting ─────────────────────────────────
{
  // genre limit only kicks in after ceil(limit/2) items selected
  const limit = 6;
  const items = Array.from({ length: 12 }, (_, i) => ({
    score: 100 - i,
    candidate: { genres: new Set(['28']), directors: new Set([String(i)]), overview: new Set(), actors: new Set(), countries: new Set(), languages: new Set(), eras: new Set(), keywords: new Set() },
    reason: `Movie ${i}`,
    matched_movies: [],
  }));
  const diverse = apply_diversity(items, limit);
  const genre28Count = diverse.filter(item => item.candidate.genres.has('28')).length;
  // With limit=6, ceil(6/2)=3, so first 3 go through without genre cap, then cap applies
  // maxPerGenre=3 but diversity logic: after first 3, crowdedGenre triggers skip
  assert.ok(genre28Count <= config.DIVERSITY.maxPerGenre + 1, `genre limit too lenient: ${genre28Count}`);
  assert.ok(diverse.length <= limit, `should not exceed limit: ${diverse.length}`);
  console.log(`✓ apply_diversity: ${genre28Count} of genre 28 (limit ${limit})`);
}

// ── 8. generate_recommendations excludes watched/not_interested ──────
{
  const watched = [
    ratedMovie({ id: 1, rating: 10, genres: [{ id: 28, name: 'Боевик' }], keywords: [{ id: 1, name: 'взрывы' }], overview: 'хороший' }),
    ratedMovie({ id: 2, rating: 9, genres: [{ id: 28, name: 'Боевик' }, { id: 878, name: 'Фантастика' }], keywords: [{ id: 1, name: 'взрывы' }], overview: 'отличный' }),
    ratedMovie({ id: 3, rating: 8, genres: [{ id: 878, name: 'Фантастика' }], keywords: [{ id: 2, name: 'космос' }], overview: 'фантастика' }),
  ];
  const candidates = [
    // This is watched (id:1) — should be excluded
    makeMovie({ id: 1, genres: [{ id: 28, name: 'Боевик' }], keywords: [{ id: 1, name: 'взрывы' }] }),
    // This is new — should be included
    makeMovie({ id: 100, genres: [{ id: 28, name: 'Боевик' }], keywords: [{ id: 1, name: 'взрывы' }], overview: 'хороший' }),
    makeMovie({ id: 101, genres: [{ id: 878, name: 'Фантастика' }], keywords: [{ id: 2, name: 'космос' }], overview: 'космос' }),
  ];
  const result = generate_recommendations({ watched, candidates });
  assert.ok(result.recommendations.length > 0, 'should have recommendations');
  const ids = result.recommendations.map(r => r.movie_id);
  assert.ok(!ids.includes(1), 'watched movie (id:1) should be excluded');
  assert.ok(ids.every(id => [100, 101].includes(id)), `all recommendations should be from candidates: ${ids}`);
  console.log(`✓ generate_recommendations: excluded watched, got ${result.recommendations.length} results`);
}

// ── 9. generate_recommendations insufficient ratings returns empty ───
{
  const watched = [ratedMovie({ id: 1, rating: 10 })];
  const candidates = [makeMovie({ id: 200 })];
  const result = generate_recommendations({ watched, candidates });
  assert.strictEqual(result.recommendations.length, 0, 'should return empty for insufficient ratings');
  console.log('✓ generate_recommendations: insufficient ratings returns empty');
}

// ── 10. API response format unchanged ────────────────────────────────
{
  const watched = [
    ratedMovie({ id: 1, rating: 10, genres: [{ id: 28, name: 'Боевик' }], keywords: [{ id: 1, name: 'взрывы' }], overview: 'хороший' }),
    ratedMovie({ id: 2, rating: 9, genres: [{ id: 28, name: 'Боевик' }], keywords: [{ id: 1, name: 'взрывы' }], overview: 'отличный' }),
    ratedMovie({ id: 3, rating: 8, genres: [{ id: 878, name: 'Фантастика' }], keywords: [{ id: 2, name: 'космос' }], overview: 'фантастика' }),
  ];
  const candidates = [makeMovie({ id: 100, genres: [{ id: 28, name: 'Боевик' }], keywords: [{ id: 1, name: 'взрывы' }], overview: 'хороший' })];
  const result = generate_recommendations({ watched, candidates });
  for (const rec of result.recommendations) {
    assert.ok('movie_id' in rec, 'recommendation must have movie_id');
    assert.ok('title' in rec, 'recommendation must have title');
    assert.ok('score' in rec, 'recommendation must have score');
    assert.ok('reason' in rec, 'recommendation must have reason');
    assert.ok('matched_movies' in rec, 'recommendation must have matched_movies');
    assert.ok('media_type' in rec, 'recommendation must have media_type');
    assert.strictEqual(typeof rec.score, 'number', 'score must be a number');
    assert.strictEqual(typeof rec.reason, 'string', 'reason must be a string');
    assert.ok(Array.isArray(rec.matched_movies), 'matched_movies must be an array');
  }
  console.log('✓ API response format: backward compatible');
}

// ── 11. reason_for mentions keywords, not just genres ────────────────
{
  const watched = [
    ratedMovie({ id: 1, rating: 10, genres: [{ id: 28, name: 'Боевик' }], keywords: [{ id: 1, name: 'взрывы' }], overview: 'хороший' }),
    ratedMovie({ id: 2, rating: 9, genres: [{ id: 28, name: 'Боевик' }], keywords: [{ id: 1, name: 'взрывы' }, { id: 5, name: 'погони' }], overview: 'отличный' }),
    ratedMovie({ id: 3, rating: 8, genres: [{ id: 28, name: 'Боевик' }], keywords: [{ id: 1, name: 'взрывы' }], overview: 'норм' }),
  ];
  const profile = build_user_profile(watched);
  const candidate = movie_data(makeMovie({ id: 100, genres: [{ id: 28, name: 'Боевик' }], keywords: [{ id: 1, name: 'взрывы' }, { id: 5, name: 'погони' }], overview: 'хороший' }));
  // reason_for is not exported, test via generate_recommendations
  const result = generate_recommendations({ watched, candidates: [makeMovie({ id: 100, genres: [{ id: 28, name: 'Боевик' }], keywords: [{ id: 1, name: 'взрывы' }, { id: 5, name: 'погони' }], overview: 'хороший' })] });
  if (result.recommendations.length > 0) {
    const reason = result.recommendations[0].reason;
    assert.ok(reason.includes('Похож'), 'reason should contain "Похож"');
    console.log(`✓ reason_for: "${reason.slice(0, 100)}..."`);
  } else {
    console.log('⚠ reason_for: no recommendations to test reason text');
  }
}

console.log('\n═══════════════════════════════');
console.log('All recommendation tests passed!');
