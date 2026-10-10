const express = require('express');
const { SERVICES, getTrending } = require('../services/streamingTrending');
const router = express.Router();
router.get('/streaming', async (req, res) => {
  const service = String(req.query.service || 'kinopoisk').toLowerCase();
  if (!SERVICES.includes(service)) return res.status(400).json({ error: 'Неизвестный streaming service' });
  try { res.json(await getTrending(service)); } catch (error) { console.error('[Trending API] unavailable:', error.message); res.json({ service, updatedAt: null, items: [], unavailable: true }); }
});
module.exports = router;
