const db = require('../db/database');

async function findBest(tmdbId, mediaType, maxAgeHours) {
  const { rows } = await db.query(
    `SELECT * FROM trailer_cache
     WHERE tmdb_id = $1 AND media_type = $2 AND available = TRUE
       AND checked_at > NOW() - ($3 * INTERVAL '1 hour')
     ORDER BY CASE source
       WHEN 'rutube' THEN 0
       WHEN 'youtube' THEN 1
       WHEN 'vk' THEN 2
       WHEN 'vimeo' THEN 3
       ELSE 99
     END, score DESC, checked_at DESC LIMIT 1`,
    [tmdbId, mediaType, maxAgeHours],
  );
  return rows[0] || null;
}

async function save(tmdbId, mediaType, trailer) {
  const { rows } = await db.query(
    `INSERT INTO trailer_cache
       (tmdb_id, media_type, source, video_id, url, embed_url, language, type, official, title, score, checked_at, available)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),TRUE)
     ON CONFLICT (tmdb_id, media_type, source, video_id) DO UPDATE SET
       url = EXCLUDED.url, embed_url = EXCLUDED.embed_url, language = EXCLUDED.language,
       type = EXCLUDED.type, official = EXCLUDED.official, title = EXCLUDED.title,
       score = EXCLUDED.score, checked_at = NOW(), available = TRUE
     RETURNING *`,
    [tmdbId, mediaType, trailer.source, trailer.videoId || null, trailer.url, trailer.embedUrl || null,
      trailer.language || null, trailer.type || null, Boolean(trailer.official), trailer.title || null, trailer.score || 0],
  );
  return rows[0];
}

async function markUnavailable(tmdbId, mediaType, source, videoId) {
  const result = await db.query(
    `UPDATE trailer_cache SET available = FALSE, checked_at = NOW()
     WHERE tmdb_id = $1 AND media_type = $2 AND source = $3
       AND ($4::TEXT IS NULL OR video_id = $4)`,
    [tmdbId, mediaType, source, videoId || null],
  );
  return result.rowCount;
}

function asTrailer(row) {
  if (!row) return null;
  return { source: row.source, videoId: row.video_id, url: row.url, embedUrl: row.embed_url, language: row.language, type: row.type, official: row.official, title: row.title, score: Number(row.score) };
}

module.exports = { findBest, save, markUnavailable, asTrailer };
