const express = require('express');
const router = express.Router();
const UserModel = require('../models/user');
const { authMiddleware } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/access');

router.use(authMiddleware, requireAdmin);

router.get('/users', async (req, res) => {
  try { res.json({ users: await UserModel.listForAdmin() }); }
  catch (err) { console.error('[Admin] users:', err.message); res.status(500).json({ error: 'Не удалось получить пользователей' }); }
});

router.put('/users/:id/jellyfin', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0 || typeof req.body.enabled !== 'boolean') return res.status(400).json({ error: 'Некорректные параметры Jellyfin' });
  try {
    const user = await UserModel.setJellyfinEnabled(id, req.body.enabled);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json({ user });
  } catch (err) { console.error('[Admin] Jellyfin access:', err.message); res.status(500).json({ error: 'Не удалось изменить доступ к Jellyfin' }); }
});

module.exports = router;
