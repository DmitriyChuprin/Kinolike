const db = require('../db/database');

const ReviewSummaryModel = {
  async find(tmdbId, mediaType) {
    const { rows } = await db.query(
      `SELECT summary, source_count, source_language, generated_at
       FROM ai_review_summaries
       WHERE tmdb_id = $1 AND media_type = $2`,
      [tmdbId, mediaType],
    );
    return rows[0] || null;
  },

  async save(tmdbId, mediaType, { summary, sourceCount, language }) {
    const { rows } = await db.query(
      `INSERT INTO ai_review_summaries
         (tmdb_id, media_type, summary, source_count, source_language)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tmdb_id, media_type)
       DO UPDATE SET summary = EXCLUDED.summary,
                     source_count = EXCLUDED.source_count,
                     source_language = EXCLUDED.source_language,
                     generated_at = CURRENT_TIMESTAMP
       RETURNING summary, source_count, source_language, generated_at`,
      [tmdbId, mediaType, summary, sourceCount, language || null],
    );
    return rows[0];
  },
};

module.exports = ReviewSummaryModel;
