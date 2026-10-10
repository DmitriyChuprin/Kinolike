const db = require('../db/database');
const jellyfin = require('./jellyfin');

const STALE_AFTER_MS = Math.max(120_000, Number(process.env.PLAYBACK_STALE_TIMEOUT_MS) || 180_000);
const WATCHDOG_INTERVAL_MS = Math.max(30_000, Number(process.env.PLAYBACK_WATCHDOG_INTERVAL_MS) || 60_000);
const STOP_REASONS = new Set([
  'player-close', 'page-leave', 'episode-change', 'movie-change', 'track-change',
  'ended', 'component-unmount', 'stale-heartbeat', 'replaced', 'error',
]);

function cleanReason(value) {
  return STOP_REASONS.has(value) ? value : 'player-close';
}

function secondsFromTicks(value) {
  const ticks = Number(value);
  return Number.isFinite(ticks) && ticks > 0 ? ticks / 10_000_000 : 0;
}

async function registerSession({ userId, clientSessionId, itemId, tmdbId, mediaType, deviceId, playback }) {
  if (!playback.playSessionId || !playback.mediaSourceId) throw new Error('Jellyfin не вернул идентификаторы playback session');
  await db.query(
    `INSERT INTO jellyfin_playback_sessions
      (play_session_id, client_session_id, user_id, jellyfin_item_id, media_source_id, device_id,
       tmdb_id, media_type, play_method, audio_stream_index, subtitle_stream_index)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [playback.playSessionId, clientSessionId, userId, itemId, playback.mediaSourceId, deviceId,
      tmdbId, mediaType, playback.playMethod || 'DirectPlay', playback.audioStreamIndex, playback.subtitleStreamIndex]
  );
  console.info(`[Playback]\nPREPARED\nItem: ${itemId}\nPlaySessionId: ${playback.playSessionId}`);
}

async function ownedSession(userId, clientSessionId, playSessionId) {
  const { rows } = await db.query(
    `SELECT * FROM jellyfin_playback_sessions
     WHERE user_id = $1 AND client_session_id = $2 AND play_session_id = $3`,
    [userId, clientSessionId, playSessionId]
  );
  return rows[0] || null;
}

async function startSession(userId, clientSessionId, playSessionId, positionSeconds = 0) {
  const session = await ownedSession(userId, clientSessionId, playSessionId);
  if (!session) return null;
  if (session.state === 'stopped' || session.state === 'stopping') return session;
  if (session.state === 'prepared') await jellyfin.reportPlaybackStart(session, { positionSeconds });
  const { rows } = await db.query(
    `UPDATE jellyfin_playback_sessions SET state = 'playing', position_ticks = $4,
       last_progress_at = CURRENT_TIMESTAMP
     WHERE user_id = $1 AND client_session_id = $2 AND play_session_id = $3
       AND state IN ('prepared', 'playing') RETURNING *`,
    [userId, clientSessionId, playSessionId, jellyfin.secondsToTicks(positionSeconds)]
  );
  const updated = rows[0] || session;
  console.info(`[Playback]\nSTART\nItem: ${updated.jellyfin_item_id}\nPlaySessionId: ${updated.play_session_id}`);
  return updated;
}

async function progressSession(userId, clientSessionId, playSessionId, { positionSeconds, durationSeconds, isPaused }) {
  const session = await ownedSession(userId, clientSessionId, playSessionId);
  if (!session || !['prepared', 'playing'].includes(session.state)) return null;
  await jellyfin.reportPlaybackProgress(session, { positionSeconds, isPaused });
  const { rows } = await db.query(
    `UPDATE jellyfin_playback_sessions SET state = 'playing', position_ticks = $4,
       duration_ticks = $5, last_progress_at = CURRENT_TIMESTAMP
     WHERE user_id = $1 AND client_session_id = $2 AND play_session_id = $3
       AND state IN ('prepared', 'playing') RETURNING *`,
    [userId, clientSessionId, playSessionId, jellyfin.secondsToTicks(positionSeconds), jellyfin.secondsToTicks(durationSeconds)]
  );
  return rows[0] || null;
}

async function stopClaimedSession(session, reason) {
  try {
    await jellyfin.reportPlaybackStopped(session, { positionSeconds: secondsFromTicks(session.position_ticks) });
    await db.query(
      `UPDATE jellyfin_playback_sessions SET state = 'stopped', stopped_at = CURRENT_TIMESTAMP,
       stop_reason = $2, last_progress_at = CURRENT_TIMESTAMP WHERE play_session_id = $1`,
      [session.play_session_id, reason]
    );
    console.info(`[Playback]\nSTOP\nReason: ${reason}\nPosition: ${secondsFromTicks(session.position_ticks).toFixed(1)}s\nPlaySessionId: ${session.play_session_id}`);
    console.info('[Playback]\nJellyfin stop sent\nSession closed');
    return true;
  } catch (error) {
    await db.query(
      `UPDATE jellyfin_playback_sessions SET state = 'playing', last_progress_at = CURRENT_TIMESTAMP
       WHERE play_session_id = $1 AND state = 'stopping'`,
      [session.play_session_id]
    ).catch(() => {});
    throw error;
  }
}

async function stopSession(userId, clientSessionId, playSessionId, { positionSeconds, durationSeconds, reason }) {
  const normalizedReason = cleanReason(reason);
  const { rows } = await db.query(
    `UPDATE jellyfin_playback_sessions SET state = 'stopping', position_ticks = $4,
       duration_ticks = $5, stop_reason = $6, last_progress_at = CURRENT_TIMESTAMP
     WHERE user_id = $1 AND client_session_id = $2 AND play_session_id = $3
       AND state IN ('prepared', 'playing') RETURNING *`,
    [userId, clientSessionId, playSessionId, jellyfin.secondsToTicks(positionSeconds), jellyfin.secondsToTicks(durationSeconds), normalizedReason]
  );
  if (rows[0]) {
    await stopClaimedSession(rows[0], normalizedReason);
    return { stopped: true, alreadyStopped: false };
  }
  const existing = await ownedSession(userId, clientSessionId, playSessionId);
  if (!existing) return null;
  return { stopped: existing.state === 'stopped', alreadyStopped: true };
}

async function stopStaleSessions() {
  const cutoff = new Date(Date.now() - STALE_AFTER_MS);
  const { rows } = await db.query(
    `UPDATE jellyfin_playback_sessions SET state = 'stopping', stop_reason = 'stale-heartbeat'
     WHERE play_session_id IN (
       SELECT play_session_id FROM jellyfin_playback_sessions
       WHERE state IN ('prepared', 'playing', 'stopping') AND last_progress_at < $1
       FOR UPDATE SKIP LOCKED
     ) RETURNING *`,
    [cutoff]
  );
  for (const session of rows) {
    try {
      console.warn(`[Playback] stale heartbeat: ${session.play_session_id}`);
      await stopClaimedSession(session, 'stale-heartbeat');
    } catch (error) {
      console.error('[Playback] watchdog stop failed:', error.message);
    }
  }
  await db.query(`DELETE FROM jellyfin_playback_sessions WHERE state = 'stopped' AND stopped_at < CURRENT_TIMESTAMP - INTERVAL '7 days'`);
}

function startPlaybackWatchdog() {
  const timer = setInterval(() => void stopStaleSessions().catch((error) => {
    console.error('[Playback] watchdog:', error.message);
  }), WATCHDOG_INTERVAL_MS);
  timer.unref?.();
  console.info(`[Playback] watchdog enabled (stale after ${Math.round(STALE_AFTER_MS / 1000)}s)`);
  return timer;
}

module.exports = { registerSession, startSession, progressSession, stopSession, stopStaleSessions, startPlaybackWatchdog, cleanReason, secondsFromTicks };
