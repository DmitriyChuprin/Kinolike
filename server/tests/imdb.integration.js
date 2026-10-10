const assert = require('assert');
const path = require('path');
const db = require('../db/database');
const { DATASETS, runImdbImport } = require('../services/imdbImporter');
const { runImdbRatingsImport } = require('../services/imdbRatingsImporter');

const fixtureDir = path.join(__dirname, 'fixtures', 'imdb');

function fixturePaths(ratings = 'title.ratings.tsv') {
  return {
    [DATASETS.names]: path.join(fixtureDir, 'name.basics.tsv'),
    [DATASETS.titles]: path.join(fixtureDir, 'title.basics.tsv'),
    [DATASETS.principals]: path.join(fixtureDir, 'title.principals.tsv'),
    [DATASETS.ratings]: path.join(fixtureDir, ratings),
  };
}

async function importFixtures(ratings) {
  return runImdbImport({
    datasetPaths: fixturePaths(ratings),
    syncTmdb: false,
    resolveTmdb: false,
    batchSize: 2,
    logger: { info() {}, warn() {}, error: console.error },
  });
}

async function run() {
  await db.initSchema();
  await db.query(
    `INSERT INTO people (tmdb_id, imdb_id, name)
     VALUES (31, 'nm0000158', 'Tom Hanks')
     ON CONFLICT (tmdb_id) DO UPDATE SET imdb_id = EXCLUDED.imdb_id`,
  );
  await db.query(
    `INSERT INTO media_metadata
       (tmdb_id, media_type, data, locale, release_year, title, imdb_id)
     VALUES (13, 'movie', $1, 'ru-RU', 1994, 'Форрест Гамп', 'tt0109830')
     ON CONFLICT (tmdb_id, media_type) DO UPDATE SET imdb_id = EXCLUDED.imdb_id`,
    [JSON.stringify({ id: 13, title: 'Форрест Гамп', release_date: '1994-07-06' })],
  );

  await importFixtures('title.ratings.tsv');
  const first = await db.query(
    `SELECT
       (SELECT COUNT(*)::integer FROM imdb_titles) AS titles,
       (SELECT COUNT(*)::integer FROM person_credits) AS credits,
       (SELECT COUNT(*)::integer FROM person_credits WHERE person_id IS NOT NULL) AS linked_people,
       (SELECT COUNT(*)::integer FROM person_credits WHERE title_id IS NOT NULL) AS linked_titles,
       (SELECT imdb_rating FROM media_metadata WHERE tmdb_id = 13 AND media_type = 'movie') AS rating`,
  );
  assert.deepStrictEqual(
    { titles: first.rows[0].titles, credits: first.rows[0].credits },
    { titles: 3, credits: 3 },
  );
  assert.strictEqual(first.rows[0].linked_people, 3);
  assert.strictEqual(first.rows[0].linked_titles, 1);
  assert.strictEqual(Number(first.rows[0].rating), 8.8);

  await importFixtures('title.ratings.tsv');
  const repeat = await db.query(
    'SELECT COUNT(*)::integer AS credits FROM person_credits',
  );
  assert.strictEqual(repeat.rows[0].credits, 3, 'repeat import must not duplicate credits');

  await importFixtures('title.ratings.v2.tsv');
  const updated = await db.query(
    `SELECT imdb_rating, imdb_votes FROM media_metadata
     WHERE tmdb_id = 13 AND media_type = 'movie'`,
  );
  assert.strictEqual(Number(updated.rows[0].imdb_rating), 8.9);
  assert.strictEqual(updated.rows[0].imdb_votes, 2400100);

  const series = await db.query(
    `SELECT title_type, start_year, end_year, imdb_rating
     FROM imdb_titles WHERE imdb_id = 'tt0185906'`,
  );
  assert.strictEqual(series.rows[0].title_type, 'tvMiniSeries');
  assert.strictEqual(series.rows[0].start_year, 2001);
  assert.strictEqual(series.rows[0].end_year, 2001);
  assert.strictEqual(Number(series.rows[0].imdb_rating), 9.4);

  const user = await db.query(
    `INSERT INTO users (username, email, password_hash)
     VALUES ('imdb-test', 'imdb-test@example.test', 'not-used')
     RETURNING id`,
  );
  await db.query(
    `INSERT INTO recommendations (user_id, tmdb_id, media_type, reason, score, expires_at)
     VALUES ($1, 13, 'movie', 'stale IMDb score', 50, CURRENT_TIMESTAMP + INTERVAL '1 day')`,
    [user.rows[0].id],
  );

  const ratingsOptions = (file) => ({
    datasetPath: path.join(fixtureDir, file),
    batchSize: 2,
    logger: { info() {}, warn() {}, error: console.error },
  });
  await runImdbRatingsImport(ratingsOptions('title.ratings.tsv'));
  const firstRatings = await db.query('SELECT COUNT(*)::integer AS count FROM imdb_ratings');
  assert.strictEqual(firstRatings.rows[0].count, 4);
  const invalidated = await db.query('SELECT COUNT(*)::integer AS count FROM recommendations');
  assert.strictEqual(invalidated.rows[0].count, 0, 'changed linked ratings must invalidate recommendation cache');

  const repeatRatings = await runImdbRatingsImport(ratingsOptions('title.ratings.tsv'));
  assert.strictEqual(repeatRatings.stats.inserted, 0);
  assert.strictEqual(repeatRatings.stats.updated, 0);
  const noDuplicates = await db.query(
    'SELECT COUNT(*)::integer AS total, COUNT(DISTINCT imdb_id)::integer AS unique_count FROM imdb_ratings',
  );
  assert.strictEqual(noDuplicates.rows[0].total, noDuplicates.rows[0].unique_count);

  await runImdbRatingsImport(ratingsOptions('title.ratings.v2.tsv'));
  const refreshed = await db.query(
    `SELECT imdb_rating, imdb_votes FROM media_metadata
     WHERE tmdb_id = 13 AND media_type = 'movie'`,
  );
  assert.strictEqual(Number(refreshed.rows[0].imdb_rating), 8.9);
  assert.strictEqual(refreshed.rows[0].imdb_votes, 2400100);

  console.log('IMDb PostgreSQL integration: OK');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
