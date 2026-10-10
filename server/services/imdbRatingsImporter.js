const path = require('path');
const fs = require('fs/promises');
const db = require('../db/database');
const {
  DATASETS,
  downloadDataset,
  streamTsv,
} = require('./imdbImporter');

const RATINGS_DATASET = DATASETS.ratings;
const IMDB_TITLE_ID = /^tt\d+$/;

function parseRatingRow(values) {
  const imdbId = String(values?.[0] || '');
  const rating = Number.parseFloat(values?.[1]);
  const votes = Number.parseInt(values?.[2], 10);
  if (!IMDB_TITLE_ID.test(imdbId)) return null;
  if (!Number.isFinite(rating) || rating < 0 || rating > 10) return null;
  if (!Number.isSafeInteger(votes) || votes < 0) return null;
  return { imdbId, rating, votes };
}

async function flushRatingBatch(client, rows) {
  if (!rows.length) return 0;
  await client.query(
    `INSERT INTO imdb_rating_staging (imdb_id, rating, votes)
     SELECT * FROM UNNEST($1::text[], $2::real[], $3::integer[])
     ON CONFLICT (imdb_id) DO UPDATE SET
       rating = EXCLUDED.rating,
       votes = EXCLUDED.votes`,
    [
      rows.map((row) => row.imdbId),
      rows.map((row) => row.rating),
      rows.map((row) => row.votes),
    ],
  );
  return rows.length;
}

async function ingestRatingSnapshot(client, filePath, options = {}) {
  const logger = options.logger || console;
  const batchSize = Math.max(100, Number(options.batchSize || process.env.IMDB_IMPORT_BATCH_SIZE || 5000));
  let batch = [];
  let valid = 0;
  let invalid = 0;

  const processed = await streamTsv(filePath, RATINGS_DATASET, (values) => {
    const row = parseRatingRow(values);
    if (!row) {
      invalid += 1;
      return null;
    }
    batch.push(row);
    if (batch.length < batchSize) return null;
    const ready = batch;
    batch = [];
    return flushRatingBatch(client, ready).then((count) => { valid += count; });
  }, { logger, logEvery: 500_000 });
  valid += await flushRatingBatch(client, batch);
  return { processed, valid, invalid };
}

async function localFileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveRatingsDataset(client, options) {
  const override = options.datasetPath || options.datasetPaths?.[RATINGS_DATASET];
  if (override) {
    const resolved = path.resolve(override);
    if (!await localFileExists(resolved)) throw new Error(`IMDb fixture не найден: ${resolved}`);
    return { path: resolved, changed: true, needsImport: true };
  }

  const dataDir = path.resolve(options.dataDir || process.env.IMDB_DATA_DIR || path.join(process.cwd(), 'data', 'imdb'));
  await fs.mkdir(dataDir, { recursive: true });
  if (options.skipDownload) {
    const localPath = path.join(dataDir, RATINGS_DATASET);
    if (!await localFileExists(localPath)) throw new Error(`IMDb dataset не найден: ${localPath}`);
    return { path: localPath, changed: false, needsImport: true };
  }

  const downloaded = await downloadDataset(client, RATINGS_DATASET, dataDir, options);
  const { rows } = await client.query(
    'SELECT ratings_imported_at FROM imdb_dataset_files WHERE dataset_name = $1',
    [RATINGS_DATASET],
  );
  return {
    ...downloaded,
    needsImport: Boolean(options.forceImport || downloaded.changed || !rows[0]?.ratings_imported_at),
  };
}

async function mergeRatingSnapshot(client) {
  await client.query('BEGIN');
  try {
    const { rows: [counts] } = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE current.imdb_id IS NULL)::integer AS inserted,
         COUNT(*) FILTER (
           WHERE current.imdb_id IS NOT NULL
             AND (current.rating IS DISTINCT FROM staged.rating OR current.votes IS DISTINCT FROM staged.votes)
         )::integer AS updated
       FROM imdb_rating_staging staged
       LEFT JOIN imdb_ratings current ON current.imdb_id = staged.imdb_id`,
    );
    const { rows: [removed] } = await client.query(
      `SELECT COUNT(*)::integer AS count
       FROM imdb_ratings current
       WHERE NOT EXISTS (
         SELECT 1 FROM imdb_rating_staging staged WHERE staged.imdb_id = current.imdb_id
       )`,
    );

    await client.query(
      `INSERT INTO imdb_ratings (imdb_id, rating, votes, updated_at)
       SELECT imdb_id, rating, votes, CURRENT_TIMESTAMP
       FROM imdb_rating_staging
       ON CONFLICT (imdb_id) DO UPDATE SET
         rating = EXCLUDED.rating,
         votes = EXCLUDED.votes,
         updated_at = CASE
           WHEN imdb_ratings.rating IS DISTINCT FROM EXCLUDED.rating
             OR imdb_ratings.votes IS DISTINCT FROM EXCLUDED.votes
           THEN CURRENT_TIMESTAMP
           ELSE imdb_ratings.updated_at
         END`,
    );
    await client.query(
      `DELETE FROM imdb_ratings current
       WHERE NOT EXISTS (
         SELECT 1 FROM imdb_rating_staging staged WHERE staged.imdb_id = current.imdb_id
       )`,
    );

    await client.query(
      `UPDATE imdb_titles title SET
         imdb_rating = rating.rating,
         imdb_votes = rating.votes,
         imdb_updated_at = rating.updated_at
       FROM imdb_ratings rating
       WHERE title.imdb_id = rating.imdb_id
         AND (title.imdb_rating IS DISTINCT FROM rating.rating
           OR title.imdb_votes IS DISTINCT FROM rating.votes)`,
    );
    const metadataUpdated = await client.query(
      `UPDATE media_metadata metadata SET
         imdb_rating = rating.rating,
         imdb_votes = rating.votes,
         imdb_updated_at = rating.updated_at
       FROM imdb_ratings rating
       WHERE metadata.imdb_id = rating.imdb_id
         AND (metadata.imdb_rating IS DISTINCT FROM rating.rating
           OR metadata.imdb_votes IS DISTINCT FROM rating.votes)`,
    );
    const metadataCleared = await client.query(
      `UPDATE media_metadata metadata SET
         imdb_rating = NULL,
         imdb_votes = NULL,
         imdb_updated_at = CURRENT_TIMESTAMP
       WHERE metadata.imdb_id IS NOT NULL
         AND metadata.imdb_rating IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM imdb_ratings rating WHERE rating.imdb_id = metadata.imdb_id
         )`,
    );
    let invalidatedRecommendations = 0;
    if (metadataUpdated.rowCount > 0 || metadataCleared.rowCount > 0) {
      const invalidated = await client.query('DELETE FROM recommendations');
      invalidatedRecommendations = invalidated.rowCount;
    }
    await client.query('COMMIT');
    return {
      inserted: counts.inserted,
      updated: counts.updated,
      removed: removed.count,
      linkedUpdated: metadataUpdated.rowCount,
      linkedCleared: metadataCleared.rowCount,
      invalidatedRecommendations,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function runImdbRatingsImport(options = {}) {
  const startedAt = Date.now();
  const logger = options.logger || console;
  const client = options.client || await (options.database || db).connect();
  const ownsClient = !options.client;
  let lockHeld = false;
  let runId = null;

  try {
    const lock = await client.query("SELECT pg_try_advisory_lock(hashtext('kinolike-imdb-import')) AS locked");
    if (!lock.rows[0].locked) throw new Error('Импорт IMDb уже выполняется');
    lockHeld = true;

    const run = await client.query(
      "INSERT INTO imdb_import_runs (status, import_type) VALUES ('running', 'ratings') RETURNING id",
    );
    runId = run.rows[0].id;
    logger.info(`[IMDb Ratings] Обновление #${runId} начато`);

    const dataset = await resolveRatingsDataset(client, options);
    if (!dataset.needsImport) {
      const stats = { skipped: true, reason: 'dataset_not_modified', durationMs: Date.now() - startedAt };
      await client.query(
        `UPDATE imdb_import_runs SET status = 'completed', completed_at = CURRENT_TIMESTAMP,
           source_changed = FALSE, stats = $2 WHERE id = $1`,
        [runId, JSON.stringify(stats)],
      );
      logger.info(`[IMDb Ratings] ${RATINGS_DATASET} не изменился; обновление пропущено`);
      return { runId, ...stats };
    }

    await client.query('TRUNCATE imdb_rating_staging');
    const parsed = await ingestRatingSnapshot(client, dataset.path, { ...options, logger });
    const changes = await mergeRatingSnapshot(client);
    await client.query('ANALYZE imdb_ratings, media_metadata');
    await client.query(
      `UPDATE imdb_dataset_files SET
         ratings_imported_at = CURRENT_TIMESTAMP,
         imported_at = COALESCE(imported_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
       WHERE dataset_name = $1`,
      [RATINGS_DATASET],
    );

    const stats = { ...parsed, ...changes, durationMs: Date.now() - startedAt };
    await client.query(
      `UPDATE imdb_import_runs SET status = 'completed', completed_at = CURRENT_TIMESTAMP,
         source_changed = $2, stats = $3 WHERE id = $1`,
      [runId, dataset.changed, JSON.stringify(stats)],
    );
    logger.info(
      `[IMDb Ratings] Обновление #${runId} завершено: обработано ${parsed.processed}, `
      + `добавлено ${changes.inserted}, обновлено ${changes.updated}, удалено ${changes.removed}, `
      + `ошибочных строк ${parsed.invalid}, ${stats.durationMs} мс`,
    );
    return { runId, stats, sourceChanged: dataset.changed };
  } catch (error) {
    if (runId !== null) {
      await client.query(
        `UPDATE imdb_import_runs SET status = 'failed', completed_at = CURRENT_TIMESTAMP, error = $2
         WHERE id = $1`,
        [runId, String(error.stack || error.message || error).slice(0, 10000)],
      ).catch(() => {});
    }
    logger.error('[IMDb Ratings] Обновление завершилось ошибкой:', error);
    throw error;
  } finally {
    if (lockHeld) {
      await client.query("SELECT pg_advisory_unlock(hashtext('kinolike-imdb-import'))").catch(() => {});
    }
    if (ownsClient) client.release();
  }
}

module.exports = {
  RATINGS_DATASET,
  flushRatingBatch,
  ingestRatingSnapshot,
  mergeRatingSnapshot,
  parseRatingRow,
  runImdbRatingsImport,
};
