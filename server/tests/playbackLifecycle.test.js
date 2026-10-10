const assert = require('assert');
const db = require('../db/database');
const jellyfin = require('../services/jellyfin');
const lifecycle = require('../services/playbackLifecycle');

const originalQuery = db.query;
const originalStopped = jellyfin.reportPlaybackStopped;
let stopCalls = 0;
let session = {
  play_session_id: 'play-session-123', client_session_id: 'client-session-123', user_id: 7,
  jellyfin_item_id: 'item-12345678', media_source_id: 'source-12345678', device_id: 'device-12345678',
  tmdb_id: 42, media_type: 'movie', play_method: 'Transcode', state: 'playing',
  position_ticks: 0, duration_ticks: 0,
};

db.query = async (sql, params = []) => {
  if (sql.includes("SET state = 'stopping', position_ticks")) {
    if (session.state !== 'playing' && session.state !== 'prepared') return { rows: [] };
    if (params[0] !== session.user_id || params[1] !== session.client_session_id || params[2] !== session.play_session_id) return { rows: [] };
    session = { ...session, state: 'stopping', position_ticks: params[3], duration_ticks: params[4], stop_reason: params[5] };
    return { rows: [{ ...session }] };
  }
  if (sql.includes('SELECT * FROM jellyfin_playback_sessions')) {
    const owned = params[0] === session.user_id && params[1] === session.client_session_id && params[2] === session.play_session_id;
    return { rows: owned ? [{ ...session }] : [] };
  }
  if (sql.includes("SET state = 'stopped'")) {
    session = { ...session, state: 'stopped', stop_reason: params[1] };
    return { rows: [] };
  }
  throw new Error(`Unexpected SQL in playback lifecycle test: ${sql}`);
};
jellyfin.reportPlaybackStopped = async () => { stopCalls += 1; };

(async () => {
  try {
    const first = await lifecycle.stopSession(7, 'client-session-123', 'play-session-123', {
      positionSeconds: 90, durationSeconds: 0, reason: 'player-close',
    });
    assert.deepStrictEqual(first, { stopped: true, alreadyStopped: false });
    assert.strictEqual(session.state, 'stopped');
    assert.strictEqual(session.position_ticks, 900000000);
    assert.strictEqual(stopCalls, 1);

    const duplicate = await lifecycle.stopSession(7, 'client-session-123', 'play-session-123', {
      positionSeconds: 91, durationSeconds: 3600, reason: 'page-leave',
    });
    assert.deepStrictEqual(duplicate, { stopped: true, alreadyStopped: true });
    assert.strictEqual(stopCalls, 1, 'duplicate STOP must not reach Jellyfin');

    const foreign = await lifecycle.stopSession(8, 'other-client-123', 'play-session-123', {
      positionSeconds: 0, durationSeconds: 0, reason: 'player-close',
    });
    assert.strictEqual(foreign, null, 'a different user/client cannot control the session');
    assert.strictEqual(lifecycle.cleanReason('not-allowed'), 'player-close');
    console.log('✓ Playback lifecycle ownership, position and idempotent STOP');
  } finally {
    db.query = originalQuery;
    jellyfin.reportPlaybackStopped = originalStopped;
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
