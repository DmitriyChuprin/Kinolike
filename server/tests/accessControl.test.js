const assert = require('assert');
const db = require('../db/database');
const { requireAdmin, requireJellyfinAccess } = require('../middleware/access');

async function run(middleware, user, row) {
  const previousQuery = db.query;
  db.query = async () => ({ rows: row ? [row] : [] });
  let statusCode = 200;
  let payload;
  let nextCalled = false;
  const res = { status(code) { statusCode = code; return this; }, json(data) { payload = data; return this; } };
  try {
    await middleware({ user, body: { userId: 999999 } }, res, () => { nextCalled = true; });
  } finally { db.query = previousQuery; }
  return { statusCode, payload, nextCalled };
}

(async () => {
  // The asserted DB row belongs to req.user.id; a body-supplied userId cannot
  // grant access to a disabled session.
  let result = await run(requireJellyfinAccess, { id: 7 }, { id: 7, jellyfin_enabled: false, is_admin: false });
  assert.equal(result.statusCode, 403);
  assert.equal(result.payload.code, 'JELLYFIN_DISABLED');
  assert.equal(result.nextCalled, false);

  result = await run(requireJellyfinAccess, { id: 7 }, { id: 7, jellyfin_enabled: true, is_admin: false });
  assert.equal(result.nextCalled, true);

  result = await run(requireAdmin, { id: 7 }, { id: 7, jellyfin_enabled: true, is_admin: false });
  assert.equal(result.statusCode, 403);

  result = await run(requireAdmin, { id: 1 }, { id: 1, jellyfin_enabled: true, is_admin: true });
  assert.equal(result.nextCalled, true);
  console.log('✓ Jellyfin access and administrator checks');
})().catch((error) => { console.error(error); process.exit(1); });
