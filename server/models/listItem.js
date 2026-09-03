const db = require('../db/database');

const ListItemModel = {
  async findAll(userId, { status, media_type, sort } = {}) {
    let query = 'SELECT * FROM user_lists WHERE user_id = $1';
    const params = [userId];
    let idx = 2;

    if (status) {
      query += ` AND status = $${idx++}`;
      params.push(status);
    }
    if (media_type) {
      query += ` AND media_type = $${idx++}`;
      params.push(media_type);
    }

    const sortMap = {
      'added_at': 'added_at DESC',
      'added_at_asc': 'added_at ASC',
      'rating': 'rating DESC',
      'rating_asc': 'rating ASC',
      'updated_at': 'updated_at DESC',
      'watched_at': 'watched_at DESC',
    };
    query += ` ORDER BY ${sortMap[sort] || 'added_at DESC'}`;

    const { rows } = await db.query(query, params);
    return rows;
  },

  // Список с метаданными из media_metadata (один SQL-запрос вместо N HTTP)
  async findAllWithMetadata(userId, { status, media_type, sort } = {}) {
    let query = `
      SELECT ul.*, mm.data as details
      FROM user_lists ul
      LEFT JOIN media_metadata mm
        ON mm.tmdb_id = ul.tmdb_id AND mm.media_type = ul.media_type
      WHERE ul.user_id = $1
    `;
    const params = [userId];
    let idx = 2;

    if (status) {
      query += ` AND ul.status = $${idx++}`;
      params.push(status);
    }
    if (media_type) {
      query += ` AND ul.media_type = $${idx++}`;
      params.push(media_type);
    }

    const sortMap = {
      'added_at': 'ul.added_at DESC',
      'added_at_asc': 'ul.added_at ASC',
      'rating': 'ul.rating DESC',
      'rating_asc': 'ul.rating ASC',
      'updated_at': 'ul.updated_at DESC',
      'watched_at': 'ul.watched_at DESC',
    };
    query += ` ORDER BY ${sortMap[sort] || 'ul.added_at DESC'}`;

    const { rows } = await db.query(query, params);
    return rows;
  },

  async findById(id) {
    const { rows } = await db.query('SELECT * FROM user_lists WHERE id = $1', [id]);
    return rows[0] || null;
  },

  async findByTmdb(userId, tmdbId, mediaType) {
    const { rows } = await db.query(
      'SELECT * FROM user_lists WHERE user_id = $1 AND tmdb_id = $2 AND media_type = $3',
      [userId, tmdbId, mediaType]
    );
    return rows[0] || null;
  },

  async create(userId, { tmdb_id, media_type, status = 'want_to_watch' }) {
    const { rows, rowCount } = await db.query(
      'INSERT INTO user_lists (user_id, tmdb_id, media_type, status) VALUES ($1, $2, $3, $4) RETURNING id',
      [userId, tmdb_id, media_type, status]
    );
    return { lastInsertRowid: rows[0].id, changes: rowCount };
  },

  async update(id, { status, rating, notes, watched_at }) {
    const fields = [];
    const values = [];
    let idx = 1;

    if (status !== undefined) { fields.push(`status = $${idx++}`); values.push(status); }
    if (rating !== undefined) { fields.push(`rating = $${idx++}`); values.push(rating); }
    if (notes !== undefined) { fields.push(`notes = $${idx++}`); values.push(notes); }
    if (watched_at !== undefined) { fields.push(`watched_at = $${idx++}`); values.push(watched_at); }

    if (fields.length === 0) return null;

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    return db.query(`UPDATE user_lists SET ${fields.join(', ')} WHERE id = $${idx}`, values);
  },

  async delete(id) {
    return db.query('DELETE FROM user_lists WHERE id = $1', [id]);
  },

  async getCountsByStatus(userId) {
    const { rows } = await db.query(
      'SELECT status, COUNT(*) as count FROM user_lists WHERE user_id = $1 GROUP BY status',
      [userId]
    );
    return rows;
  },

  async exportAll(userId) {
    const { rows } = await db.query(
      'SELECT * FROM user_lists WHERE user_id = $1 ORDER BY added_at DESC',
      [userId]
    );
    return rows;
  },

  async importAll(userId, items) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM user_lists WHERE user_id = $1', [userId]);
      for (const item of items) {
        await client.query(
          'INSERT INTO user_lists (user_id, tmdb_id, media_type, status, rating, notes, added_at, watched_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [
            userId,
            item.tmdb_id,
            item.media_type,
            item.status || 'want_to_watch',
            item.rating || null,
            item.notes || null,
            item.added_at || new Date().toISOString(),
            item.watched_at || null
          ]
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

  async invalidateRecommendations(userId) {
    return db.query('DELETE FROM recommendations WHERE user_id = $1', [userId]);
  }
};

module.exports = ListItemModel;
