const crypto = require('crypto');
const db = require('../db/database');

const ACTIONS = new Set(['want_to_watch', 'watched', 'not_interested', 'hide', 'open']);
const REASONS = new Set(['too_old', 'too_new', 'disliked_genre', 'disliked_actor', 'disliked_director', 'unknown', 'already_seen', 'not_now', 'other']);

function requestKey(query = '') { return crypto.createHash('sha256').update(String(query).trim().toLowerCase()).digest('hex').slice(0, 24); }

async function recordImpressions(userId, items, { algorithm = 'personal_v2', query = null } = {}) {
  if (!items?.length) return items || [];
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const item of items) {
      const result = await client.query(`INSERT INTO recommendation_events
        (user_id,tmdb_id,media_type,algorithm,request_query,request_key,score,score_components,structured_reasons)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9
        WHERE NOT EXISTS (SELECT 1 FROM recommendation_events WHERE user_id=$1 AND tmdb_id=$2 AND media_type=$3 AND algorithm=$4 AND shown_at > NOW() - INTERVAL '6 hours')
        RETURNING id`,
      [userId, item.tmdb_id, item.media_type, algorithm, query, query ? requestKey(query) : null,
        item.score || null, JSON.stringify(item.score_components || item.components || {}), JSON.stringify(item.structured_reasons || {})]);
      if (result.rows[0]) item.recommendation_id = result.rows[0].id;
      else {
        const existing = await client.query(`SELECT id FROM recommendation_events WHERE user_id=$1 AND tmdb_id=$2 AND media_type=$3 AND algorithm=$4 ORDER BY shown_at DESC LIMIT 1`, [userId, item.tmdb_id, item.media_type, algorithm]);
        item.recommendation_id = existing.rows[0]?.id;
      }
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  return items;
}

async function feedback(userId, input) {
  const tmdbId = Number(input.tmdb_id);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0 || !['movie', 'tv'].includes(input.media_type)) throw new Error('Некорректный объект рекомендации');
  if (!ACTIONS.has(input.action)) throw new Error('Некорректное действие');
  if (input.reason && !REASONS.has(input.reason)) throw new Error('Некорректная причина');
  const recommendationId = input.recommendation_id ? Number(input.recommendation_id) : null;
  if (recommendationId) {
    const owned = await db.query('SELECT 1 FROM recommendation_events WHERE id=$1 AND user_id=$2', [recommendationId, userId]);
    if (!owned.rowCount) throw new Error('Рекомендация не найдена');
  }
  const { rows } = await db.query(`INSERT INTO recommendation_feedback
    (user_id,tmdb_id,media_type,recommendation_id,action,reason,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
  [userId, tmdbId, input.media_type, recommendationId, input.action, input.reason || null, JSON.stringify(input.metadata || {})]);
  const column = input.action === 'open' ? 'opened_at' : input.action === 'want_to_watch' ? 'want_to_watch_at'
    : input.action === 'watched' ? 'watched_at' : ['hide', 'not_interested'].includes(input.action) ? 'rejected_at' : null;
  if (column) await db.query(`UPDATE recommendation_events SET ${column}=COALESCE(${column},NOW()) WHERE user_id=$1 AND tmdb_id=$2 AND media_type=$3`, [userId, tmdbId, input.media_type]);
  return rows[0];
}

async function getFeedbackSignals(userId) {
  const { rows } = await db.query(`SELECT rf.tmdb_id,rf.media_type,rf.action,rf.reason,rf.metadata,mm.data
    FROM recommendation_feedback rf LEFT JOIN media_metadata mm ON mm.tmdb_id=rf.tmdb_id AND mm.media_type=rf.media_type
    WHERE rf.user_id=$1 AND rf.created_at > NOW() - INTERVAL '365 days' ORDER BY rf.created_at DESC LIMIT 500`, [userId]);
  const blockedIds = new Set(); const genres = new Map(); const actors = new Map(); const directors = new Map();
  let oldPenalty = 0; let unknownPenalty = 0;
  for (const row of rows) {
    const negative = ['hide', 'not_interested'].includes(row.action);
    if (!negative) continue;
    if (row.reason === 'too_old') oldPenalty += 1;
    if (row.reason === 'unknown') unknownPenalty += 1;
    const data = row.data || {};
    if (row.reason === 'disliked_genre') for (const genre of data.genres || []) genres.set(String(genre.id), (genres.get(String(genre.id)) || 0) - 8);
    if (row.reason === 'disliked_actor') for (const person of (data.credits?.cast || []).slice(0, 10)) actors.set(String(person.id), (actors.get(String(person.id)) || 0) - 5);
    if (row.reason === 'disliked_director') for (const person of (data.credits?.crew || []).filter(p => p.job === 'Director')) directors.set(String(person.id), (directors.get(String(person.id)) || 0) - 8);
    blockedIds.add(`${row.media_type || ''}:${row.tmdb_id || ''}`);
  }
  return { blockedIds, genres, actors, directors, oldPenalty: Math.min(oldPenalty * 2, 20), unknownPenalty: Math.min(unknownPenalty * 2, 20) };
}

function adjustmentFor(candidate, signals = {}) {
  let adjustment = 0; const applied = [];
  const data = candidate.data || candidate.raw || candidate.details || candidate;
  for (const genre of data.genres || []) if (signals.genres?.has(String(genre.id))) { adjustment += signals.genres.get(String(genre.id)); applied.push('rejected_genre'); }
  for (const actor of (data.credits?.cast || []).slice(0, 10)) if (signals.actors?.has(String(actor.id))) { adjustment += signals.actors.get(String(actor.id)); applied.push('rejected_actor'); }
  for (const director of (data.credits?.crew || []).filter(p => p.job === 'Director')) if (signals.directors?.has(String(director.id))) { adjustment += signals.directors.get(String(director.id)); applied.push('rejected_director'); }
  const year = Number(String(data.release_date || data.first_air_date || '').slice(0, 4));
  if (year && year < 2000 && signals.oldPenalty) { adjustment -= signals.oldPenalty; applied.push('too_old_history'); }
  if ((Number(data.vote_count) || 0) < 500 && signals.unknownPenalty) { adjustment -= signals.unknownPenalty; applied.push('unknown_history'); }
  return { adjustment: Math.max(-35, Math.min(10, adjustment)), signals: [...new Set(applied)] };
}

module.exports = { ACTIONS, REASONS, requestKey, recordImpressions, feedback, getFeedbackSignals, adjustmentFor };
