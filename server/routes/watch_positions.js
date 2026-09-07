// Watch positions — сохранение/получение позиций просмотра
const express = require('express');
const router = express.Router();
const { pool } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

// Все маршруты требуют авторизации
router.use(authMiddleware);

// Получить все позиции пользователя (для "Продолжить просмотр")
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, tmdb_id, media_type, position, duration, title, poster_path, updated_at
       FROM watch_positions
       WHERE user_id = $1 AND position > 0
       ORDER BY updated_at DESC
       LIMIT 20`,
      [req.user.id]
    );

    res.json({ items: result.rows });
  } catch (err) {
    console.error('[WatchPositions] GET error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Сохранить позицию просмотра
router.post('/', async (req, res) => {
  try {
    const { tmdb_id, media_type, position, duration, title, poster_path } = req.body;
    if (!tmdb_id || !media_type) {
      return res.status(400).json({ error: 'tmdb_id и media_type обязательны' });
    }

    // Не сохранять если позиция слишком маленькая (< 5 сек) или фильм досмотрен (> 95%)
    if (position < 5 || (duration > 0 && position / duration > 0.95)) {
      // Если досмотрен — удаляем запись
      if (duration > 0 && position / duration > 0.95) {
        await pool.query(
          'DELETE FROM watch_positions WHERE user_id = $1 AND tmdb_id = $2 AND media_type = $3',
          [req.user.id, tmdb_id, media_type]
        );
      }
      return res.json({ ok: true });
    }

    await pool.query(
      `INSERT INTO watch_positions (user_id, tmdb_id, media_type, position, duration, title, poster_path, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (user_id, tmdb_id, media_type) DO UPDATE
       SET position = EXCLUDED.position,
           duration = EXCLUDED.duration,
           title = COALESCE(NULLIF(EXCLUDED.title, ''), watch_positions.title),
           poster_path = COALESCE(NULLIF(EXCLUDED.poster_path, ''), watch_positions.poster_path),
           updated_at = NOW()`,
      [req.user.id, tmdb_id, media_type, position, duration || 0, title || '', poster_path || '']
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[WatchPositions] POST error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Удалить позицию (при досмотре или вручную)
router.delete('/:tmdbId/:mediaType', async (req, res) => {
  try {
    const { tmdbId, mediaType } = req.params;
    await pool.query(
      'DELETE FROM watch_positions WHERE user_id = $1 AND tmdb_id = $2 AND media_type = $3',
      [req.user.id, tmdbId, mediaType]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[WatchPositions] DELETE error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
