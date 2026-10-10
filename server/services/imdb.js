const db = require('../db/database');
const tmdbService = require('./tmdb');

const IMDB_PERSON_ID = /^nm\d+$/;
const IMDB_TITLE_ID = /^tt\d+$/;
const MOVIE_TITLE_TYPES = new Set(['movie', 'short', 'tvMovie', 'video']);
const TV_TITLE_TYPES = new Set(['tvSeries', 'tvMiniSeries', 'tvShort', 'tvSpecial']);

function validImdbPersonId(value) {
  return typeof value === 'string' && IMDB_PERSON_ID.test(value) ? value : null;
}

function validImdbTitleId(value) {
  return typeof value === 'string' && IMDB_TITLE_ID.test(value) ? value : null;
}

function titleTypeToMediaType(titleType) {
  if (MOVIE_TITLE_TYPES.has(titleType)) return 'movie';
  if (TV_TITLE_TYPES.has(titleType)) return 'tv';
  return null;
}

function normalizedLog(value, exponent) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.min(1, Math.log10(number + 1) / exponent);
}

/**
 * R  = IMDb rating / 10
 * IV = min(1, log10(IMDb votes + 1) / 6)
 * TV = min(1, log10(TMDB vote_count + 1) / 6)
 * P  = min(1, log10(TMDB popularity + 1) / 3)
 * K  = 1 when the title is in a known-for list, otherwise 0
 *
 * Missing numerical sources are excluded and their weight is redistributed.
 */
function calculateWorkScore(work) {
  const components = [];
  const imdbRating = Number(work.imdb_rating ?? work.imdbRating);
  if (Number.isFinite(imdbRating) && imdbRating >= 0) {
    components.push([0.45, Math.min(1, imdbRating / 10)]);
  }
  const imdbVotes = normalizedLog(work.imdb_votes ?? work.imdbVotes, 6);
  if (imdbVotes !== null) components.push([0.25, imdbVotes]);
  const tmdbVotes = normalizedLog(work.tmdb_vote_count ?? work.tmdbVoteCount, 6);
  if (tmdbVotes !== null) components.push([0.15, tmdbVotes]);
  const popularity = normalizedLog(work.tmdb_popularity ?? work.tmdbPopularity, 3);
  if (popularity !== null) components.push([0.10, popularity]);
  components.push([0.05, work.known_for ?? work.knownFor ? 1 : 0]);

  const availableWeight = components.reduce((sum, [weight]) => sum + weight, 0);
  if (availableWeight === 0) return 0;
  const weighted = components.reduce((sum, [weight, value]) => sum + weight * value, 0);
  return Math.round((weighted / availableWeight) * 10000) / 100;
}

function safeDate(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return null;
  return value;
}

function extractPersonImdbId(person) {
  return validImdbPersonId(person?.external_ids?.imdb_id || person?.imdb_id);
}

function extractTitleImdbId(data) {
  return validImdbTitleId(data?.imdb_id || data?.external_ids?.imdb_id);
}

async function ensurePerson(person, database = db) {
  const tmdbId = Number(person?.id);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) throw new Error('Некорректный TMDB person_id');
  const imdbId = extractPersonImdbId(person);
  const knownFor = Array.isArray(person.known_for) ? person.known_for : null;
  const { rows } = await database.query(
    `INSERT INTO people
       (tmdb_id, imdb_id, name, profile_path, biography, birthday, deathday,
        place_of_birth, tmdb_popularity, tmdb_known_for, tmdb_updated_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
             COALESCE($10::jsonb, '[]'::jsonb), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT (tmdb_id) DO UPDATE SET
       imdb_id = COALESCE(EXCLUDED.imdb_id, people.imdb_id),
       name = EXCLUDED.name,
       profile_path = EXCLUDED.profile_path,
       biography = EXCLUDED.biography,
       birthday = EXCLUDED.birthday,
       deathday = EXCLUDED.deathday,
       place_of_birth = EXCLUDED.place_of_birth,
       tmdb_popularity = EXCLUDED.tmdb_popularity,
       tmdb_known_for = CASE WHEN $10::jsonb IS NULL THEN people.tmdb_known_for ELSE $10::jsonb END,
       tmdb_updated_at = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [
      tmdbId,
      imdbId,
      String(person.name || person.original_name || `TMDB person ${tmdbId}`),
      person.profile_path || null,
      person.biography || null,
      safeDate(person.birthday),
      safeDate(person.deathday),
      person.place_of_birth || null,
      Number.isFinite(Number(person.popularity)) ? Number(person.popularity) : null,
      knownFor ? JSON.stringify(knownFor) : null,
    ],
  );
  const stored = rows[0];
  if (stored.imdb_id) {
    await database.query(
      `UPDATE person_credits SET person_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE imdb_person_id = $2 AND person_id IS DISTINCT FROM $1`,
      [stored.id, stored.imdb_id],
    );
  }
  return stored;
}

async function linkMediaMetadataToImdb(tmdbId, mediaType, imdbId, database = db, logger = console) {
  const validId = validImdbTitleId(imdbId);
  if (!validId || !['movie', 'tv'].includes(mediaType)) return null;

  const existing = await database.query(
    'SELECT id, tmdb_id, media_type FROM media_metadata WHERE imdb_id = $1',
    [validId],
  );
  if (existing.rows[0] && (existing.rows[0].tmdb_id !== Number(tmdbId) || existing.rows[0].media_type !== mediaType)) {
    logger.warn?.(
      `[IMDb] ${validId} уже связан с ${existing.rows[0].media_type}/${existing.rows[0].tmdb_id}; `
      + `${mediaType}/${tmdbId} пропущен во избежание дубля`,
    );
    return existing.rows[0];
  }

  const { rows } = await database.query(
    `UPDATE media_metadata metadata SET
       imdb_id = $3,
       imdb_rating = rating.rating,
       imdb_votes = rating.votes,
       imdb_updated_at = COALESCE(rating.updated_at, CURRENT_TIMESTAMP)
     FROM (SELECT rating, votes, updated_at FROM imdb_ratings WHERE imdb_id = $3) rating
     WHERE metadata.tmdb_id = $1 AND metadata.media_type = $2
     RETURNING metadata.*`,
    [tmdbId, mediaType, validId],
  );

  // The title may not be in the local IMDb index yet. Preserve the exact ID now
  // so the next ratings import can fill its numeric fields.
  let linked = rows[0];
  if (!linked) {
    const fallback = await database.query(
      `UPDATE media_metadata SET imdb_id = $3
       WHERE tmdb_id = $1 AND media_type = $2
       RETURNING *`,
      [tmdbId, mediaType, validId],
    );
    linked = fallback.rows[0];
  }
  if (linked) {
    await database.query(
      `UPDATE person_credits SET title_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE imdb_title_id = $2 AND title_id IS DISTINCT FROM $1`,
      [linked.id, validId],
    );
  }
  return linked || null;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const count = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(Array.from({ length: count }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = { error };
      }
    }
  }));
  return results;
}

function positiveLimit(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

async function syncExistingTmdbEntities(options = {}) {
  const logger = options.logger || console;
  const titleLimit = positiveLimit(options.titleLimit ?? process.env.IMDB_TMDB_TITLE_SYNC_LIMIT, 2000);
  const personLimit = positiveLimit(options.personLimit ?? process.env.IMDB_TMDB_PERSON_SYNC_LIMIT, 2000);
  const stats = { titlesLinked: 0, titlesFailed: 0, peopleLinked: 0, peopleFailed: 0 };

  const titleResult = await db.query(
    `SELECT tmdb_id, media_type FROM media_metadata
     WHERE imdb_id IS NULL ORDER BY id LIMIT $1`,
    [titleLimit],
  );
  const titleSync = await mapWithConcurrency(titleResult.rows, 4, async (item) => {
    const external = await tmdbService.tmdbRequest(`/${item.media_type}/${item.tmdb_id}/external_ids`);
    const imdbId = validImdbTitleId(external?.imdb_id);
    if (!imdbId) return false;
    await linkMediaMetadataToImdb(item.tmdb_id, item.media_type, imdbId, db, logger);
    return true;
  });
  for (const result of titleSync) {
    if (result?.error) stats.titlesFailed += 1;
    else if (result) stats.titlesLinked += 1;
  }

  const peopleResult = await db.query(
    `SELECT tmdb_id, MAX(name) AS name
     FROM (
       SELECT ma.person_id AS tmdb_id, ma.name
       FROM media_actors ma
       UNION ALL
       SELECT p.tmdb_id, p.name FROM people p
     ) known_people
     GROUP BY tmdb_id
     ORDER BY tmdb_id
     LIMIT $1`,
    [personLimit],
  );
  const peopleSync = await mapWithConcurrency(peopleResult.rows, 4, async (item) => {
    const [details, external] = await Promise.all([
      tmdbService.getPersonDetails(item.tmdb_id),
      tmdbService.tmdbRequest(`/person/${item.tmdb_id}/external_ids`),
    ]);
    const person = await ensurePerson({ ...details, external_ids: external });
    return Boolean(person.imdb_id);
  });
  for (const result of peopleSync) {
    if (result?.error) stats.peopleFailed += 1;
    else if (result) stats.peopleLinked += 1;
  }
  logger.info?.(`[IMDb] TMDB external IDs: titles=${stats.titlesLinked}, people=${stats.peopleLinked}`);
  return stats;
}

async function resolveOneCredit(credit, logger = console) {
  const result = await tmdbService.tmdbRequest(`/find/${credit.imdb_title_id}`, { external_source: 'imdb_id' });
  const candidates = [
    ...(result.movie_results || []).map((item) => ({ ...item, mediaType: 'movie' })),
    ...(result.tv_results || []).map((item) => ({ ...item, mediaType: 'tv' })),
  ];
  if (candidates.length !== 1) return { status: candidates.length ? 'ambiguous' : 'not_found' };

  const candidate = candidates[0];
  if (!Number.isInteger(Number(candidate.id))) return { status: 'not_found' };
  if (candidate.mediaType === 'movie') await tmdbService.getMovieDetails(candidate.id);
  else await tmdbService.getTvDetails(candidate.id);
  await linkMediaMetadataToImdb(candidate.id, candidate.mediaType, credit.imdb_title_id, db, logger);
  return { status: 'linked', tmdbId: Number(candidate.id), mediaType: candidate.mediaType };
}

async function resolveTrackedCredits(options = {}) {
  const logger = options.logger || console;
  const limit = positiveLimit(options.limit, 500);
  if (limit === 0) return { attempted: 0, linked: 0, notFound: 0, ambiguous: 0, failed: 0 };
  const params = [];
  let personClause = '';
  if (options.personId) {
    params.push(options.personId);
    personClause = `AND credit.person_id = $${params.length}`;
  }
  params.push(limit);
  const { rows } = await db.query(
    `SELECT unresolved.imdb_title_id, unresolved.imdb_votes
     FROM (
       SELECT DISTINCT ON (credit.imdb_title_id)
              credit.imdb_title_id, title.imdb_votes
       FROM person_credits credit
       JOIN imdb_titles title ON title.imdb_id = credit.imdb_title_id
       WHERE credit.person_id IS NOT NULL AND credit.title_id IS NULL
         ${personClause}
       ORDER BY credit.imdb_title_id
     ) unresolved
     ORDER BY unresolved.imdb_votes DESC NULLS LAST, unresolved.imdb_title_id
     LIMIT $${params.length}`,
    params,
  );
  const results = await mapWithConcurrency(rows, 3, (credit) => resolveOneCredit(credit, logger));
  const stats = { attempted: rows.length, linked: 0, notFound: 0, ambiguous: 0, failed: 0 };
  for (const result of results) {
    if (result?.error) stats.failed += 1;
    else if (result?.status === 'linked') stats.linked += 1;
    else if (result?.status === 'ambiguous') stats.ambiguous += 1;
    else stats.notFound += 1;
  }
  return stats;
}

function charactersLabel(characters, fallback) {
  if (Array.isArray(characters)) return characters.filter(Boolean).join(', ');
  if (typeof characters === 'string' && characters) return characters;
  return fallback || '';
}

async function getTmdbAnnotations(movieCredits, tvCredits, userId) {
  const pairs = [];
  const seen = new Set();
  for (const [mediaType, credits] of [['movie', movieCredits], ['tv', tvCredits]]) {
    for (const credit of credits) {
      const tmdbId = Number(credit.id);
      const key = `${mediaType}:${tmdbId}`;
      if (!Number.isInteger(tmdbId) || seen.has(key)) continue;
      seen.add(key);
      pairs.push({ tmdbId, mediaType });
    }
  }
  if (!pairs.length) return new Map();
  const { rows } = await db.query(
    `WITH requested AS (
       SELECT * FROM UNNEST($1::integer[], $2::text[]) AS item(tmdb_id, media_type)
     )
     SELECT requested.tmdb_id, requested.media_type,
            metadata.id AS title_id, metadata.imdb_id, metadata.imdb_rating,
            metadata.imdb_votes, metadata.imdb_updated_at,
            user_item.id AS list_id, user_item.status
     FROM requested
     LEFT JOIN media_metadata metadata
       ON metadata.tmdb_id = requested.tmdb_id AND metadata.media_type = requested.media_type
     LEFT JOIN user_lists user_item
       ON user_item.user_id = $3 AND user_item.tmdb_id = requested.tmdb_id
      AND user_item.media_type = requested.media_type`,
    [pairs.map((item) => item.tmdbId), pairs.map((item) => item.mediaType), userId || 0],
  );
  return new Map(rows.map((row) => [`${row.media_type}:${row.tmdb_id}`, row]));
}

function tmdbCreditToWork(credit, mediaType, annotation, knownFor) {
  const date = mediaType === 'movie' ? credit.release_date : credit.first_air_date;
  return {
    tmdb_id: Number(credit.id),
    media_type: mediaType,
    imdb_title_id: annotation?.imdb_id || null,
    title: credit.title || credit.name || credit.original_title || credit.original_name || 'Без названия',
    original_title: credit.original_title || credit.original_name || null,
    year: Number.parseInt(String(date || '').slice(0, 4), 10) || null,
    end_year: null,
    poster_path: credit.poster_path || null,
    overview: credit.overview || null,
    category: 'actor',
    characters: charactersLabel(null, credit.character),
    job: credit.job || null,
    imdb_rating: annotation?.imdb_rating === null ? null : Number(annotation?.imdb_rating),
    imdb_votes: annotation?.imdb_votes === null ? null : Number(annotation?.imdb_votes),
    tmdb_rating: Number(credit.vote_average) || null,
    tmdb_vote_count: Number(credit.vote_count) || null,
    tmdb_popularity: Number(credit.popularity) || null,
    known_for: knownFor,
    status: annotation?.status || null,
    list_id: annotation?.list_id ? Number(annotation.list_id) : null,
    source: annotation?.imdb_id ? 'tmdb+imdb' : 'tmdb',
  };
}

function mergeWork(existing, incoming) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== null && value !== undefined && value !== '') merged[key] = value;
  }
  if (existing.characters && incoming.characters && existing.characters !== incoming.characters) {
    const roles = new Set(`${existing.characters}, ${incoming.characters}`.split(',').map((item) => item.trim()).filter(Boolean));
    merged.characters = [...roles].join(', ');
  }
  merged.source = existing.source === incoming.source ? existing.source : 'tmdb+imdb';
  return merged;
}

async function getImportedWorks(person, userId) {
  if (!person.imdb_id) return [];
  const { rows } = await db.query(
    `SELECT credit.id AS credit_id, credit.imdb_title_id, credit.category,
            credit.characters, credit.job, title.title_type, title.primary_title,
            title.original_title, title.start_year, title.end_year, title.genres,
            title.imdb_rating AS index_rating, title.imdb_votes AS index_votes,
            metadata.id AS title_id, metadata.tmdb_id, metadata.media_type,
            metadata.data AS tmdb_data, metadata.poster_path, metadata.overview,
            COALESCE(metadata.imdb_rating, title.imdb_rating) AS imdb_rating,
            COALESCE(metadata.imdb_votes, title.imdb_votes) AS imdb_votes,
            user_item.id AS list_id, user_item.status,
            title.imdb_id = ANY(person.imdb_known_for_titles) AS known_for
     FROM person_credits credit
     JOIN imdb_titles title ON title.imdb_id = credit.imdb_title_id
     JOIN people person ON person.id = $1
     LEFT JOIN media_metadata metadata ON metadata.id = credit.title_id
     LEFT JOIN user_lists user_item
       ON user_item.user_id = $2 AND user_item.tmdb_id = metadata.tmdb_id
      AND user_item.media_type = metadata.media_type
     WHERE credit.imdb_person_id = person.imdb_id`,
    [person.id, userId || 0],
  );
  return rows.map((row) => {
    const tmdbData = row.tmdb_data || {};
    return {
      credit_id: Number(row.credit_id),
      tmdb_id: row.tmdb_id === null ? null : Number(row.tmdb_id),
      media_type: row.media_type || titleTypeToMediaType(row.title_type),
      imdb_title_id: row.imdb_title_id,
      title: tmdbData.title || tmdbData.name || row.primary_title,
      original_title: tmdbData.original_title || tmdbData.original_name || row.original_title,
      year: row.start_year === null ? null : Number(row.start_year),
      end_year: row.end_year === null ? null : Number(row.end_year),
      poster_path: tmdbData.poster_path || row.poster_path || null,
      overview: tmdbData.overview || row.overview || null,
      genres: Array.isArray(row.genres) ? row.genres : [],
      category: row.category,
      characters: charactersLabel(row.characters),
      job: row.job,
      imdb_rating: row.imdb_rating === null ? null : Number(row.imdb_rating),
      imdb_votes: row.imdb_votes === null ? null : Number(row.imdb_votes),
      tmdb_rating: Number(tmdbData.vote_average) || null,
      tmdb_vote_count: Number(tmdbData.vote_count) || null,
      tmdb_popularity: Number(tmdbData.popularity) || null,
      known_for: Boolean(row.known_for),
      status: row.status || null,
      list_id: row.list_id ? Number(row.list_id) : null,
      source: row.tmdb_id ? 'tmdb+imdb' : 'imdb',
    };
  });
}

async function getPersonFilmography(personData, movieCredits = [], tvCredits = [], userId = null, options = {}) {
  const person = await ensurePerson(personData);
  const resolveLimit = positiveLimit(
    options.resolveLimit ?? process.env.IMDB_RESOLVE_ON_PERSON_LIMIT,
    12,
  );
  if (person.imdb_id && resolveLimit > 0) {
    await resolveTrackedCredits({ personId: person.id, limit: resolveLimit, logger: options.logger || console });
  }

  const movieCast = Array.isArray(movieCredits) ? movieCredits : [];
  const tvCast = Array.isArray(tvCredits) ? tvCredits : [];
  const [imported, annotations] = await Promise.all([
    getImportedWorks(person, userId),
    getTmdbAnnotations(movieCast, tvCast, userId),
  ]);
  const works = new Map();
  for (const work of imported) {
    const key = work.tmdb_id ? `${work.media_type}:${work.tmdb_id}` : `imdb:${work.imdb_title_id}`;
    works.set(key, work);
  }

  const tmdbKnownFor = new Set(
    (Array.isArray(personData.known_for) ? personData.known_for : [])
      .map((item) => `${item.media_type || (item.title ? 'movie' : 'tv')}:${item.id}`),
  );
  for (const [mediaType, credits] of [['movie', movieCast], ['tv', tvCast]]) {
    for (const credit of credits) {
      const key = `${mediaType}:${Number(credit.id)}`;
      const incoming = tmdbCreditToWork(credit, mediaType, annotations.get(key), tmdbKnownFor.has(key));
      works.set(key, works.has(key) ? mergeWork(works.get(key), incoming) : incoming);
    }
  }

  const filmography = [...works.values()].map((work) => ({
    ...work,
    work_score: calculateWorkScore(work),
    can_add: Boolean(work.tmdb_id && work.media_type),
  }));
  filmography.sort((a, b) => b.work_score - a.work_score || (b.year || 0) - (a.year || 0));
  return {
    imdb_id: person.imdb_id,
    person_id: Number(person.id),
    known_works: filmography.slice(0, 12),
    filmography,
  };
}

module.exports = {
  calculateWorkScore,
  ensurePerson,
  extractPersonImdbId,
  extractTitleImdbId,
  getPersonFilmography,
  linkMediaMetadataToImdb,
  mapWithConcurrency,
  resolveTrackedCredits,
  syncExistingTmdbEntities,
  titleTypeToMediaType,
  validImdbPersonId,
  validImdbTitleId,
};
