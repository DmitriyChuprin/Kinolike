const assert = require('assert');
const path = require('path');
const {
  DATASETS,
  EXPECTED_HEADERS,
  SUPPORTED_TITLE_TYPES,
  nullValue,
  streamTsv,
  validateHeader,
} = require('../services/imdbImporter');
const {
  calculateWorkScore,
  titleTypeToMediaType,
  validImdbPersonId,
  validImdbTitleId,
} = require('../services/imdb');
const { parseArgs } = require('../cli/update-imdb-data');

async function run() {
  assert.strictEqual(validImdbPersonId('nm0000158'), 'nm0000158');
  assert.strictEqual(validImdbPersonId('Tom Hanks'), null);
  assert.strictEqual(validImdbTitleId('tt0109830'), 'tt0109830');
  assert.strictEqual(validImdbTitleId('Forrest Gump'), null);
  assert.strictEqual(nullValue('\\N'), null);
  assert.strictEqual(titleTypeToMediaType('movie'), 'movie');
  assert.strictEqual(titleTypeToMediaType('tvMiniSeries'), 'tv');
  assert.strictEqual(titleTypeToMediaType('videoGame'), null);
  assert.ok(SUPPORTED_TITLE_TYPES.has('tvSeries'));

  const lowConfidence = calculateWorkScore({
    imdb_rating: 8.0,
    imdb_votes: 500,
    tmdb_vote_count: 500,
    tmdb_popularity: 10,
    known_for: false,
  });
  const highConfidence = calculateWorkScore({
    imdb_rating: 7.7,
    imdb_votes: 500000,
    tmdb_vote_count: 500000,
    tmdb_popularity: 10,
    known_for: false,
  });
  assert.ok(highConfidence > lowConfidence, `${highConfidence} should be above ${lowConfidence}`);

  validateHeader(DATASETS.ratings, EXPECTED_HEADERS[DATASETS.ratings]);
  assert.throws(
    () => validateHeader(DATASETS.ratings, ['tconst', 'numVotes']),
    /изменил структуру/,
  );

  const fixture = path.join(__dirname, 'fixtures', 'imdb', 'title.basics.tsv');
  const retained = [];
  const count = await streamTsv(fixture, DATASETS.titles, async (values) => {
    if (SUPPORTED_TITLE_TYPES.has(values[1])) retained.push(values[0]);
  });
  assert.strictEqual(count, 4);
  assert.deepStrictEqual(retained, ['tt0109830', 'tt0112384', 'tt0185906']);

  assert.deepStrictEqual(
    parseArgs(['--skip-download', '--skip-tmdb', '--resolve-limit=25']),
    { skipDownload: true, syncTmdb: false, resolveLimit: 25 },
  );

  console.log('IMDb importer/scoring: OK');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
