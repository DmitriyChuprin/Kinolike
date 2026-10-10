const db = require('../db/database');

async function currentAccess(userId) {
  const { rows } = await db.query('SELECT id, is_admin, jellyfin_enabled FROM users WHERE id = $1', [userId]);
  return rows[0] || null;
}

async function hasJellyfinAccess(userId) {
  return Boolean((await currentAccess(userId))?.jellyfin_enabled);
}

async function requireJellyfinAccess(req, res, next) {
  try {
    if (!await hasJellyfinAccess(req.user?.id)) return res.status(403).json({ error: 'Доступ к Jellyfin отключён администратором', code: 'JELLYFIN_DISABLED' });
    next();
  } catch (err) { next(err); }
}

async function requireAdmin(req, res, next) {
  try {
    if (!(await currentAccess(req.user?.id))?.is_admin) return res.status(403).json({ error: 'Требуются права администратора' });
    next();
  } catch (err) { next(err); }
}

module.exports = { currentAccess, hasJellyfinAccess, requireJellyfinAccess, requireAdmin };
