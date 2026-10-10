const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const zlib = require('zlib');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const fetch = require('node-fetch');
const db = require('../db/database');

const DATASET_BASE_URL = 'https://datasets.imdbws.com';
const DATASETS = Object.freeze({
  names: 'name.basics.tsv.gz',
  principals: 'title.principals.tsv.gz',
  titles: 'title.basics.tsv.gz',
  ratings: 'title.ratings.tsv.gz',
});

// Episode rows are intentionally excluded: KinoLike tracks movies and shows,
// not individual episodes. The remaining types cover screen acting work.
const SUPPORTED_TITLE_TYPES = new Set([
  'movie', 'short', 'tvMovie', 'tvSeries', 'tvMiniSeries', 'tvShort',
  'tvSpecial', 'video',
]);
const ACTING_CATEGORIES = new Set([
  'actor', 'actress', 'self', 'archive_footage', 'archive_sound',
]);

const EXPECTED_HEADERS = Object.freeze({
  [DATASETS.names]: ['nconst', 'primaryName', 'birthYear', 'deathYear', 'primaryProfession', 'knownForTitles'],
  [DATASETS.principals]: ['tconst', 'ordering', 'nconst', 'category', 'job', 'characters'],
  [DATASETS.titles]: ['tconst', 'titleType', 'primaryTitle', 'originalTitle', 'isAdult', 'startYear', 'endYear', 'runtimeMinutes', 'genres'],
  [DATASETS.ratings]: ['tconst', 'averageRating', 'numVotes'],
});

function nullValue(value) {
  return value === undefined || value === '\\N' || value === '' ? null : value;
}

function integerValue(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberValue(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTsvLine(line) {
  return line.split('\t');
}

function validateHeader(datasetName, header) {
  const expected = EXPECTED_HEADERS[datasetName];
  if (!expected) throw new Error(`Неизвестный IMDb dataset: ${datasetName}`);
  if (header.length !== expected.length || header.some((column, index) => column !== expected[index])) {
    throw new Error(
      `IMDb изменил структуру ${datasetName}: ожидалось "${expected.join('\t')}", получено "${header.join('\t')}"`,
    );
  }
}

async function streamTsv(filePath, datasetName, onRow, options = {}) {
  const source = fs.createReadStream(filePath);
  const input = filePath.endsWith('.gz') ? source.pipe(zlib.createGunzip()) : source;
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let header = null;
  let rowsRead = 0;

  for await (const line of lines) {
    if (header === null) {
      header = parseTsvLine(line.replace(/^\uFEFF/, ''));
      validateHeader(datasetName, header);
      continue;
    }
    if (!line) continue;
    const values = parseTsvLine(line);
    if (values.length !== header.length) {
      throw new Error(`${datasetName}: строка ${rowsRead + 2} содержит ${values.length} полей вместо ${header.length}`);
    }
    const pending = onRow(values, rowsRead);
    if (pending && typeof pending.then === 'function') await pending;
    rowsRead += 1;
    if (options.logEvery && rowsRead % options.logEvery === 0) {
      options.logger?.info?.(`[IMDb] ${datasetName}: прочитано ${rowsRead.toLocaleString('en-US')} строк`);
    }
  }

  if (header === null) throw new Error(`${datasetName}: пустой файл`);
  return rowsRead;
}

async function flushTitleBatch(client, rows) {
  if (!rows.length) return 0;
  await client.query(
    `INSERT INTO imdb_title_staging
       (imdb_id, title_type, primary_title, original_title, is_adult,
        start_year, end_year, runtime_minutes, genres)
     SELECT * FROM UNNEST(
       $1::text[], $2::text[], $3::text[], $4::text[], $5::boolean[],
       $6::integer[], $7::integer[], $8::integer[], $9::text[]
     )
     ON CONFLICT (imdb_id) DO UPDATE SET
       title_type = EXCLUDED.title_type,
       primary_title = EXCLUDED.primary_title,
       original_title = EXCLUDED.original_title,
       is_adult = EXCLUDED.is_adult,
       start_year = EXCLUDED.start_year,
       end_year = EXCLUDED.end_year,
       runtime_minutes = EXCLUDED.runtime_minutes,
       genres = EXCLUDED.genres`,
    [
      rows.map((row) => row.imdbId),
      rows.map((row) => row.titleType),
      rows.map((row) => row.primaryTitle),
      rows.map((row) => row.originalTitle),
      rows.map((row) => row.isAdult),
      rows.map((row) => row.startYear),
      rows.map((row) => row.endYear),
      rows.map((row) => row.runtimeMinutes),
      rows.map((row) => row.genres),
    ],
  );
  return rows.length;
}

async function ingestTitles(client, filePath, batchSize, logger) {
  let batch = [];
  let retained = 0;
  const rowsRead = await streamTsv(filePath, DATASETS.titles, (values) => {
    const [imdbId, titleType, primaryTitle, originalTitle, isAdult, startYear, endYear, runtimeMinutes, genres] = values;
    if (!SUPPORTED_TITLE_TYPES.has(titleType)) return;
    batch.push({
      imdbId,
      titleType,
      primaryTitle,
      originalTitle: nullValue(originalTitle),
      isAdult: isAdult === '1',
      startYear: integerValue(startYear),
      endYear: integerValue(endYear),
      runtimeMinutes: integerValue(runtimeMinutes),
      genres: nullValue(genres),
    });
    if (batch.length >= batchSize) {
      const ready = batch;
      batch = [];
      return flushTitleBatch(client, ready).then((count) => { retained += count; });
    }
    return null;
  }, { logger, logEvery: 1_000_000 });
  retained += await flushTitleBatch(client, batch);
  return { rowsRead, retained };
}

async function flushRatingBatch(client, rows) {
  if (!rows.length) return 0;
  const result = await client.query(
    `UPDATE imdb_title_staging AS title
     SET imdb_rating = incoming.rating,
         imdb_votes = incoming.votes
     FROM UNNEST($1::text[], $2::real[], $3::integer[])
       AS incoming(imdb_id, rating, votes)
     WHERE title.imdb_id = incoming.imdb_id`,
    [
      rows.map((row) => row.imdbId),
      rows.map((row) => row.rating),
      rows.map((row) => row.votes),
    ],
  );
  return result.rowCount;
}

async function ingestRatings(client, filePath, batchSize, logger) {
  let batch = [];
  let retained = 0;
  const rowsRead = await streamTsv(filePath, DATASETS.ratings, (values) => {
    batch.push({ imdbId: values[0], rating: numberValue(values[1]), votes: integerValue(values[2]) });
    if (batch.length >= batchSize) {
      const ready = batch;
      batch = [];
      return flushRatingBatch(client, ready).then((count) => { retained += count; });
    }
    return null;
  }, { logger, logEvery: 1_000_000 });
  retained += await flushRatingBatch(client, batch);
  return { rowsRead, retained };
}

async function flushCreditBatch(client, rows) {
  if (!rows.length) return 0;
  const result = await client.query(
    `INSERT INTO imdb_credit_staging
       (imdb_person_id, imdb_title_id, ordering, category, job, characters)
     SELECT incoming.imdb_person_id, incoming.imdb_title_id, incoming.ordering,
            incoming.category, incoming.job, incoming.characters
     FROM UNNEST($1::text[], $2::text[], $3::integer[], $4::text[], $5::text[], $6::text[])
       AS incoming(imdb_person_id, imdb_title_id, ordering, category, job, characters)
     JOIN imdb_title_staging title ON title.imdb_id = incoming.imdb_title_id
     ON CONFLICT (imdb_person_id, imdb_title_id, ordering) DO UPDATE SET
       category = EXCLUDED.category,
       job = EXCLUDED.job,
       characters = EXCLUDED.characters`,
    [
      rows.map((row) => row.imdbPersonId),
      rows.map((row) => row.imdbTitleId),
      rows.map((row) => row.ordering),
      rows.map((row) => row.category),
      rows.map((row) => row.job),
      rows.map((row) => row.characters),
    ],
  );
  return result.rowCount;
}

async function ingestCredits(client, filePath, batchSize, logger) {
  let batch = [];
  let retained = 0;
  const rowsRead = await streamTsv(filePath, DATASETS.principals, (values) => {
    const [imdbTitleId, ordering, imdbPersonId, category, job, characters] = values;
    if (!ACTING_CATEGORIES.has(category)) return;
    batch.push({
      imdbPersonId,
      imdbTitleId,
      ordering: integerValue(ordering),
      category,
      job: nullValue(job),
      characters: nullValue(characters),
    });
    if (batch.length >= batchSize) {
      const ready = batch;
      batch = [];
      return flushCreditBatch(client, ready).then((count) => { retained += count; });
    }
    return null;
  }, { logger, logEvery: 1_000_000 });
  retained += await flushCreditBatch(client, batch);
  return { rowsRead, retained };
}

async function flushNameBatch(client, rows) {
  if (!rows.length) return 0;
  const result = await client.query(
    `INSERT INTO imdb_name_staging
       (imdb_person_id, primary_name, birth_year, death_year, primary_professions, known_for_titles)
     SELECT * FROM UNNEST($1::text[], $2::text[], $3::integer[], $4::integer[], $5::text[], $6::text[])
     ON CONFLICT (imdb_person_id) DO UPDATE SET
       primary_name = EXCLUDED.primary_name,
       birth_year = EXCLUDED.birth_year,
       death_year = EXCLUDED.death_year,
       primary_professions = EXCLUDED.primary_professions,
       known_for_titles = EXCLUDED.known_for_titles`,
    [
      rows.map((row) => row.imdbPersonId),
      rows.map((row) => row.primaryName),
      rows.map((row) => row.birthYear),
      rows.map((row) => row.deathYear),
      rows.map((row) => row.primaryProfessions),
      rows.map((row) => row.knownForTitles),
    ],
  );
  return result.rowCount;
}

async function ingestNames(client, filePath, batchSize, logger) {
  const { rows: trackedRows } = await client.query('SELECT imdb_id FROM people WHERE imdb_id IS NOT NULL');
  const tracked = new Set(trackedRows.map((row) => row.imdb_id));
  let batch = [];
  let retained = 0;
  const rowsRead = await streamTsv(filePath, DATASETS.names, (values) => {
    if (!tracked.has(values[0])) return;
    batch.push({
      imdbPersonId: values[0],
      primaryName: values[1],
      birthYear: integerValue(values[2]),
      deathYear: integerValue(values[3]),
      primaryProfessions: nullValue(values[4]),
      knownForTitles: nullValue(values[5]),
    });
    if (batch.length >= batchSize) {
      const ready = batch;
      batch = [];
      return flushNameBatch(client, ready).then((count) => { retained += count; });
    }
    return null;
  }, { logger, logEvery: 1_000_000 });
  retained += await flushNameBatch(client, batch);
  return { rowsRead, retained, tracked: tracked.size };
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function downloadDataset(client, datasetName, dataDir, options = {}) {
  const logger = options.logger || console;
  const sourceUrl = `${DATASET_BASE_URL}/${datasetName}`;
  const localPath = path.join(dataDir, datasetName);
  const partialPath = `${localPath}.part`;
  const { rows } = await client.query(
    'SELECT * FROM imdb_dataset_files WHERE dataset_name = $1',
    [datasetName],
  );
  const previous = rows[0];
  const headers = {};
  if (!options.forceDownload && previous?.etag && await fileExists(localPath)) {
    headers['If-None-Match'] = previous.etag;
  }
  if (!options.forceDownload && previous?.last_modified && await fileExists(localPath)) {
    headers['If-Modified-Since'] = previous.last_modified;
  }

  logger.info(`[IMDb] Проверка ${datasetName}`);
  const response = await (options.fetchImpl || fetch)(sourceUrl, { headers });
  if (response.status === 304) {
    logger.info(`[IMDb] ${datasetName} не изменился (HTTP 304)`);
    return { path: localPath, changed: false, needsImport: !previous?.imported_at };
  }
  if (!response.ok || !response.body) {
    throw new Error(`Не удалось скачать ${datasetName}: HTTP ${response.status}`);
  }

  const hash = crypto.createHash('sha256');
  let byteSize = 0;
  const digestStream = new Transform({
    transform(chunk, encoding, callback) {
      hash.update(chunk);
      byteSize += chunk.length;
      callback(null, chunk);
    },
  });

  await pipeline(response.body, digestStream, fs.createWriteStream(partialPath, { flags: 'w' }));
  const sha256 = hash.digest('hex');
  const sameContent = previous?.sha256 === sha256 && await fileExists(localPath);
  if (sameContent) await fsp.unlink(partialPath);
  else await fsp.rename(partialPath, localPath);

  await client.query(
    `INSERT INTO imdb_dataset_files
       (dataset_name, source_url, local_path, etag, last_modified, sha256, byte_size, downloaded_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT (dataset_name) DO UPDATE SET
       source_url = EXCLUDED.source_url,
       local_path = EXCLUDED.local_path,
       etag = EXCLUDED.etag,
       last_modified = EXCLUDED.last_modified,
       sha256 = EXCLUDED.sha256,
       byte_size = EXCLUDED.byte_size,
       downloaded_at = EXCLUDED.downloaded_at,
       updated_at = CURRENT_TIMESTAMP`,
    [
      datasetName,
      sourceUrl,
      localPath,
      response.headers.get('etag'),
      response.headers.get('last-modified'),
      sha256,
      byteSize,
    ],
  );

  logger.info(`[IMDb] ${datasetName}: ${sameContent ? 'содержимое не изменилось' : `скачано ${byteSize.toLocaleString('en-US')} байт`}`);
  return { path: localPath, changed: !sameContent, needsImport: !sameContent || !previous?.imported_at };
}

async function resolveDatasetPaths(client, options) {
  const dataDir = path.resolve(options.dataDir || process.env.IMDB_DATA_DIR || path.join(process.cwd(), 'data', 'imdb'));
  await fsp.mkdir(dataDir, { recursive: true });
  const paths = {};
  let changed = false;
  let needsImport = Boolean(options.forceImport);

  for (const datasetName of Object.values(DATASETS)) {
    const override = options.datasetPaths?.[datasetName];
    if (override) {
      const resolved = path.resolve(override);
      if (!await fileExists(resolved)) throw new Error(`IMDb fixture не найден: ${resolved}`);
      paths[datasetName] = resolved;
      changed = true;
      needsImport = true;
      continue;
    }
    if (options.skipDownload) {
      const localPath = path.join(dataDir, datasetName);
      if (!await fileExists(localPath)) throw new Error(`IMDb dataset не найден: ${localPath}`);
      paths[datasetName] = localPath;
      needsImport = true;
      continue;
    }
    const result = await downloadDataset(client, datasetName, dataDir, options);
    paths[datasetName] = result.path;
    changed ||= result.changed;
    needsImport ||= result.needsImport;
  }
  return { paths, changed, needsImport };
}

async function mergeStaging(client, runId) {
  await client.query('BEGIN');
  try {
    await client.query(
      `INSERT INTO imdb_titles
         (imdb_id, title_type, primary_title, original_title, is_adult,
          start_year, end_year, runtime_minutes, genres, imdb_rating,
          imdb_votes, imdb_updated_at, import_run_id)
       SELECT imdb_id, title_type, primary_title, original_title, is_adult,
              start_year, end_year, runtime_minutes,
              CASE WHEN genres IS NULL THEN ARRAY[]::text[] ELSE string_to_array(genres, ',') END,
              imdb_rating, imdb_votes, CURRENT_TIMESTAMP, $1
       FROM imdb_title_staging
       ON CONFLICT (imdb_id) DO UPDATE SET
         title_type = EXCLUDED.title_type,
         primary_title = EXCLUDED.primary_title,
         original_title = EXCLUDED.original_title,
         is_adult = EXCLUDED.is_adult,
         start_year = EXCLUDED.start_year,
         end_year = EXCLUDED.end_year,
         runtime_minutes = EXCLUDED.runtime_minutes,
         genres = EXCLUDED.genres,
         imdb_rating = EXCLUDED.imdb_rating,
         imdb_votes = EXCLUDED.imdb_votes,
         imdb_updated_at = EXCLUDED.imdb_updated_at,
         import_run_id = EXCLUDED.import_run_id`,
      [runId],
    );

    // Keep the compact ratings index warm even after a full filmography import.
    // The dedicated daily importer will later replace it with the complete
    // title.ratings snapshot, including title types not stored in imdb_titles.
    await client.query(
      `INSERT INTO imdb_ratings (imdb_id, rating, votes, updated_at)
       SELECT imdb_id, imdb_rating, imdb_votes, CURRENT_TIMESTAMP
       FROM imdb_title_staging
       WHERE imdb_rating IS NOT NULL AND imdb_votes IS NOT NULL
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
      `INSERT INTO person_credits
         (person_id, imdb_person_id, title_id, imdb_title_id, ordering,
          category, characters, job, import_run_id)
       SELECT person.id, credit.imdb_person_id, metadata.id, credit.imdb_title_id,
              credit.ordering, credit.category,
              CASE WHEN credit.characters IS NULL THEN NULL ELSE credit.characters::jsonb END,
              credit.job, $1
       FROM imdb_credit_staging credit
       LEFT JOIN people person ON person.imdb_id = credit.imdb_person_id
       LEFT JOIN media_metadata metadata ON metadata.imdb_id = credit.imdb_title_id
       ON CONFLICT (imdb_person_id, imdb_title_id, ordering) DO UPDATE SET
         person_id = COALESCE(EXCLUDED.person_id, person_credits.person_id),
         title_id = COALESCE(EXCLUDED.title_id, person_credits.title_id),
         category = EXCLUDED.category,
         characters = EXCLUDED.characters,
         job = EXCLUDED.job,
         import_run_id = EXCLUDED.import_run_id,
         updated_at = CURRENT_TIMESTAMP`,
      [runId],
    );

    // Removal is performed only after every source file has been read and both
    // upserts succeeded. A parser/download error therefore cannot erase live data.
    await client.query('DELETE FROM person_credits WHERE import_run_id IS DISTINCT FROM $1', [runId]);
    await client.query('DELETE FROM imdb_titles WHERE import_run_id IS DISTINCT FROM $1', [runId]);

    await client.query(
      `UPDATE people person SET
         imdb_primary_name = name.primary_name,
         imdb_birth_year = name.birth_year,
         imdb_death_year = name.death_year,
         imdb_primary_professions = CASE
           WHEN name.primary_professions IS NULL THEN ARRAY[]::text[]
           ELSE string_to_array(name.primary_professions, ',') END,
         imdb_known_for_titles = CASE
           WHEN name.known_for_titles IS NULL THEN ARRAY[]::text[]
           ELSE string_to_array(name.known_for_titles, ',') END,
         imdb_updated_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
       FROM imdb_name_staging name
       WHERE person.imdb_id = name.imdb_person_id`,
    );

    await client.query(
      `UPDATE media_metadata metadata SET
         imdb_rating = rating.rating,
         imdb_votes = rating.votes,
         imdb_updated_at = rating.updated_at
       FROM imdb_ratings rating
       WHERE metadata.imdb_id = rating.imdb_id`,
    );

    await client.query(
      `UPDATE person_credits credit SET
         person_id = person.id,
         updated_at = CURRENT_TIMESTAMP
       FROM people person
       WHERE credit.imdb_person_id = person.imdb_id
         AND credit.person_id IS DISTINCT FROM person.id`,
    );
    await client.query(
      `UPDATE person_credits credit SET
         title_id = metadata.id,
         updated_at = CURRENT_TIMESTAMP
       FROM media_metadata metadata
       WHERE credit.imdb_title_id = metadata.imdb_id
         AND credit.title_id IS DISTINCT FROM metadata.id`,
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function runImdbImport(options = {}) {
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
      "INSERT INTO imdb_import_runs (status) VALUES ('running') RETURNING id",
    );
    runId = run.rows[0].id;
    logger.info(`[IMDb] Импорт #${runId} начат`);

    if (options.syncTmdb !== false) {
      const imdbService = require('./imdb');
      await imdbService.syncExistingTmdbEntities({
        logger,
        personLimit: options.personSyncLimit,
        titleLimit: options.titleSyncLimit,
      });
    }

    const datasets = await resolveDatasetPaths(client, options);
    if (!datasets.needsImport && !options.forceImport) {
      const stats = { skipped: true, reason: 'datasets_not_modified' };
      await client.query(
        `UPDATE imdb_import_runs SET status = 'completed', completed_at = CURRENT_TIMESTAMP,
           source_changed = FALSE, stats = $2 WHERE id = $1`,
        [runId, JSON.stringify(stats)],
      );
      logger.info('[IMDb] Все datasets актуальны, повторный импорт не требуется');
      return { runId, ...stats };
    }

    await client.query('TRUNCATE imdb_title_staging, imdb_credit_staging, imdb_name_staging');
    const batchSize = Math.max(100, Number(options.batchSize || process.env.IMDB_IMPORT_BATCH_SIZE || 5000));
    const stats = {};
    stats.titles = await ingestTitles(client, datasets.paths[DATASETS.titles], batchSize, logger);
    stats.ratings = await ingestRatings(client, datasets.paths[DATASETS.ratings], batchSize, logger);
    stats.credits = await ingestCredits(client, datasets.paths[DATASETS.principals], batchSize, logger);
    stats.names = await ingestNames(client, datasets.paths[DATASETS.names], batchSize, logger);

    await mergeStaging(client, runId);
    await client.query('ANALYZE imdb_titles, person_credits');
    await client.query(
      `UPDATE imdb_dataset_files SET imported_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE dataset_name = ANY($1::text[])`,
      [Object.values(DATASETS)],
    );

    if (options.resolveTmdb !== false) {
      const imdbService = require('./imdb');
      stats.tmdbResolution = await imdbService.resolveTrackedCredits({
        logger,
        limit: Number(options.resolveLimit ?? process.env.IMDB_TMDB_RESOLVE_LIMIT ?? 500),
      });
    }

    await client.query(
      `UPDATE imdb_import_runs SET status = 'completed', completed_at = CURRENT_TIMESTAMP,
         source_changed = $2, stats = $3 WHERE id = $1`,
      [runId, datasets.changed, JSON.stringify(stats)],
    );
    logger.info(`[IMDb] Импорт #${runId} завершён`);
    return { runId, stats, sourceChanged: datasets.changed };
  } catch (error) {
    if (runId !== null) {
      await client.query(
        `UPDATE imdb_import_runs SET status = 'failed', completed_at = CURRENT_TIMESTAMP, error = $2
         WHERE id = $1`,
        [runId, String(error.stack || error.message || error).slice(0, 10000)],
      ).catch(() => {});
    }
    logger.error('[IMDb] Импорт завершился ошибкой:', error);
    throw error;
  } finally {
    if (lockHeld) {
      await client.query("SELECT pg_advisory_unlock(hashtext('kinolike-imdb-import'))").catch(() => {});
    }
    if (ownsClient) client.release();
  }
}

module.exports = {
  ACTING_CATEGORIES,
  DATASETS,
  EXPECTED_HEADERS,
  SUPPORTED_TITLE_TYPES,
  downloadDataset,
  ingestCredits,
  ingestNames,
  ingestRatings,
  ingestTitles,
  nullValue,
  parseTsvLine,
  runImdbImport,
  streamTsv,
  validateHeader,
};
