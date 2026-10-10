const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const service = require('../services/tasteProfile');

const router = express.Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  try { res.json({ profile: await service.getTasteProfile(req.user.id, { refresh: req.query.refresh === 'true' }) }); }
  catch (error) { console.error('[Taste Profile]', error); res.status(500).json({ error: 'Не удалось построить профиль вкуса' }); }
});

router.put('/preferences', async (req, res) => {
  try { res.json({ preferences: await service.savePreferences(req.user.id, req.body || {}) }); }
  catch (error) { res.status(400).json({ error: error.message || 'Некорректные настройки' }); }
});

module.exports = router;

