const assert = require('assert');
const path = require('path');
const {
  calculate_imdb_quality_score,
  calculate_imdb_vote_confidence,
  calculate_mainstream_score,
  candidate_passes_thresholds,
  movie_data,
} = require('../services/personalRecommendations');
const { fallback_parse, rank_candidates } = require('../services/aiSearch');
const { parseRatingRow } = require('../services/imdbRatingsImporter');
const { DATASETS, streamTsv } = require('../services/imdbImporter');
const { parseArgs } = require('../cli/update-imdb-ratings');

function candidate(id, imdbRating, imdbVotes, year = 2020) {
  return {
    tmdb_id: id,
    media_type: 'movie',
    title: `Movie ${id}`,
    release_year: year,
    imdb_id: imdbRating == null ? null : `tt${String(id).padStart(7, '0')}`,
    imdb_rating: imdbRating,
    imdb_votes: imdbVotes,
    genre_ids: [18],
    data: {
      id,
      title: `Movie ${id}`,
      genres: [{ id: 18, name: 'Drama' }],
      overview: 'A sufficiently detailed overview.',
      release_date: `${year}-01-01`,
      vote_average: 7.5,
      vote_count: 20000,
      popularity: 60,
      credits: { cast: [], crew: [] },
      keywords: { keywords: [] },
    },
  };
}

async function run() {
  assert.deepStrictEqual(parseRatingRow(['tt0111161', '9.3', '3100000']), {
    imdbId: 'tt0111161', rating: 9.3, votes: 3100000,
  });
  assert.strictEqual(parseRatingRow(['bad', '9.3', '100']), null);
  assert.strictEqual(parseRatingRow(['tt0111161', '11', '100']), null);
  assert.strictEqual(parseRatingRow(['tt0111161', '8.1', '-1']), null);

  const parsed = [];
  const fixture = path.join(__dirname, 'fixtures', 'imdb', 'title.ratings.tsv');
  const count = await streamTsv(fixture, DATASETS.ratings, (values) => parsed.push(parseRatingRow(values)));
  assert.strictEqual(count, 4);
  assert.strictEqual(parsed.filter(Boolean).length, 4);

  const lowVotes = candidate(1, 8.2, 800);
  const highVotes = candidate(2, 7.8, 250000);
  assert(calculate_imdb_vote_confidence(lowVotes) < calculate_imdb_vote_confidence(highVotes));
  assert(calculate_imdb_quality_score(lowVotes) < calculate_imdb_quality_score(highVotes));

  const params = {
    genres: [], keywords: [], mood: [], excluded_keywords: [],
    prefer_mainstream: true, prefer_hidden_gems: false,
    prefer_classics: false, prefer_recent: false,
  };
  const coldProfile = { ratedCount: 0, profile: { isSufficient: false } };
  const ranked = rank_candidates([lowVotes, highVotes], params, coldProfile, null);
  assert.strictEqual(ranked[0].candidate.tmdb_id, 2,
    '8.2/800 must not automatically outrank 7.8/250000 when other signals are equal');

  const withoutImdb = candidate(3, null, null);
  assert.strictEqual(calculate_imdb_vote_confidence(withoutImdb), 0);
  assert.strictEqual(calculate_imdb_quality_score(withoutImdb), 0);
  assert(candidate_passes_thresholds(withoutImdb), 'missing IMDb must not exclude a valid TMDB candidate');
  assert(Number.isFinite(rank_candidates([withoutImdb], params, coldProfile, null)[0].score));

  const oldClassic = movie_data(candidate(4, 8.2, 600000, 1968));
  const sameSignalsModern = movie_data(candidate(5, 8.2, 600000, 2022));
  assert.strictEqual(calculate_mainstream_score(oldClassic), calculate_mainstream_score(sameSignalsModern),
    'age alone must not affect mainstream score');

  const rare = fallback_parse('Посоветуй редкие фильмы');
  assert.strictEqual(rare.prefer_hidden_gems, true);
  assert.strictEqual(rare.prefer_mainstream, false);

  assert.deepStrictEqual(parseArgs(['--skip-download', '--batch-size=250']), {
    skipDownload: true, batchSize: 250,
  });

  console.log('IMDb ratings importer/recommendation signals: OK');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

