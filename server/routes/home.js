const express = require('express');
const router = express.Router();
const { optionalAuth } = require('../middleware/auth');
const tmdbService = require('../services/tmdb');
const db = require('../db/database');

// The curated TMDB list is shared and cached; this small per-user query only
// removes completed titles. "want_to_watch" deliberately remains visible.
router.get('/russian-new', optionalAuth, async (req, res) => {
  try {
    const data = await tmdbService.getRussianNew();
    let watched = new Set();
    if (req.user?.id) {
      const { rows } = await db.query(
        `SELECT tmdb_id, media_type FROM user_lists WHERE user_id = $1 AND status = 'watched'`,
        [req.user.id],
      );
      watched = new Set(rows.map((item) => `${item.media_type}:${item.tmdb_id}`));
    }
    res.json({ ...data, results: data.results.filter((item) => !watched.has(`${item.media_type}:${item.id}`)) });
  } catch (err) {
    // A home-page enhancement must never make the page unavailable.
    console.error('[Home] Russian new releases unavailable:', err.message);
    res.json({ results: [], unavailable: true });
  }
});

module.exports = router;
