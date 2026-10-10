const crypto = require('crypto');
const db = require('../db/database');
const { sendError } = require('../api/errors');

function tokensEqual(received, expected) {
  const left = crypto.createHash('sha256').update(String(received)).digest();
  const right = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(left, right);
}

async function apiTokenAuth(req, res, next) {
  if (process.env.KINOLIKE_API_ENABLED === 'false') {
    return sendError(res, 403, 'API_DISABLED', 'External API is disabled');
  }

  const configuredToken = process.env.KINOLIKE_API_TOKEN;
  const match = String(req.headers.authorization || '').match(/^Bearer\s+([^\s]+)$/i);
  if (!configuredToken || configuredToken.length < 32 || configuredToken.startsWith('replace_')) {
    return sendError(res, 500, 'API_TOKEN_NOT_CONFIGURED', 'External API token must be configured with at least 32 random characters');
  }
  if (!match || !tokensEqual(match[1], configuredToken)) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="KinoLike API"');
    return sendError(res, 401, 'UNAUTHORIZED', 'Valid bearer token required');
  }

  const configuredId = Number(process.env.KINOLIKE_API_USER_ID);
  const username = String(process.env.KINOLIKE_API_USERNAME || '').trim();
  if ((!Number.isInteger(configuredId) || configuredId <= 0) && !username) {
    return sendError(res, 500, 'API_USER_NOT_CONFIGURED', 'External API user is not configured');
  }

  try {
    const { rows } = Number.isInteger(configuredId) && configuredId > 0
      ? await db.query('SELECT id, username FROM users WHERE id = $1', [configuredId])
      : await db.query('SELECT id, username FROM users WHERE username = $1', [username]);
    if (!rows[0]) return sendError(res, 403, 'API_USER_NOT_FOUND', 'Configured API user does not exist');
    req.user = rows[0];
    req.auth = { type: 'api_token' };
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = { apiTokenAuth, tokensEqual };
