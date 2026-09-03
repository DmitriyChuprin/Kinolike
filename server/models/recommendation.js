const db = require('../db/database');

const RecommendationModel = {
  async getCached(userId) {
    const { rows } = await db.query(
      `SELECT * FROM recommendations 
       WHERE user_id = $1 AND expires_at > NOW()
       ORDER BY score DESC`,
      [userId]
    );
    return rows;
  },

  async save(userId, recommendations, ttlHours = 24) {
    // Дедупликация по tmdb_id + media_type
    const seen = new Set();
    const unique = recommendations.filter(rec => {
      const key = `${rec.tmdb_id}:${rec.media_type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM recommendations WHERE user_id = $1', [userId]);
      for (const rec of unique) {
        await client.query(
          `INSERT INTO recommendations (user_id, tmdb_id, media_type, reason, score, expires_at)
           VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '1 hour' * $6)`,
          [userId, rec.tmdb_id, rec.media_type, rec.reason, rec.score, ttlHours]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async clearCache(userId) {
    return db.query('DELETE FROM recommendations WHERE user_id = $1', [userId]);
  }
};

module.exports = RecommendationModel;
