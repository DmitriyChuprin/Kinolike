const db = require('../db/database');
const bcrypt = require('bcryptjs');

const UserModel = {
  async create(username, email, password) {
    const hash = bcrypt.hashSync(password, 10);
    const { rows } = await db.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [username, email, hash]
    );
    return { lastInsertRowid: rows[0].id };
  },

  async findByEmail(email) {
    const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    return rows[0] || null;
  },

  async findByUsername(username) {
    const { rows } = await db.query('SELECT * FROM users WHERE username = $1', [username]);
    return rows[0] || null;
  },

  async findById(id) {
    const { rows } = await db.query(
      'SELECT id, username, email, avatar_url, is_admin, jellyfin_enabled, preferred_streaming_source, created_at FROM users WHERE id = $1', [id]
    );
    return rows[0] || null;
  },

  async updateProfile(id, { username, email, avatar_url, preferred_streaming_source }) {
    const fields = [];
    const values = [];
    let idx = 1;

    if (username !== undefined) { fields.push(`username = $${idx++}`); values.push(username); }
    if (email !== undefined) { fields.push(`email = $${idx++}`); values.push(email); }
    if (avatar_url !== undefined) { fields.push(`avatar_url = $${idx++}`); values.push(avatar_url); }
    if (preferred_streaming_source !== undefined) { fields.push(`preferred_streaming_source = $${idx++}`); values.push(preferred_streaming_source); }

    if (fields.length === 0) return null;

    values.push(id);
    return db.query(`UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}`, values);
  },

  async updatePassword(id, newPassword) {
    const hash = bcrypt.hashSync(newPassword, 10);
    return db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, id]);
  },

  async listForAdmin() {
    const { rows } = await db.query(
      'SELECT id, username, email, avatar_url, is_admin, jellyfin_enabled, preferred_streaming_source, created_at FROM users ORDER BY created_at DESC'
    );
    return rows;
  },

  async setJellyfinEnabled(id, enabled) {
    const { rows } = await db.query(
      'UPDATE users SET jellyfin_enabled = $1 WHERE id = $2 RETURNING id, username, email, avatar_url, is_admin, jellyfin_enabled, preferred_streaming_source, created_at',
      [enabled, id]
    );
    return rows[0] || null;
  },

  verifyPassword(plainPassword, hash) {
    return bcrypt.compareSync(plainPassword, hash);
  }
};

module.exports = UserModel;
