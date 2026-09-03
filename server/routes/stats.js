const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

// Общая статистика
router.get('/overview', async (req, res) => {
  try {
    const userId = req.user.id;

    // Количество по статусам
    const { rows: statusCounts } = await db.query(
      'SELECT status, COUNT(*) as count FROM user_lists WHERE user_id = $1 GROUP BY status',
      [userId]
    );

    const counts = {};
    for (const row of statusCounts) {
      counts[row.status] = parseInt(row.count);
    }

    // Общее количество
    const total = Object.values(counts).reduce((sum, c) => sum + c, 0);

    // Средняя оценка
    const { rows: avgRows } = await db.query(
      'SELECT AVG(rating) as avg FROM user_lists WHERE user_id = $1 AND rating IS NOT NULL',
      [userId]
    );
    const avgRating = avgRows[0].avg ? Math.round(parseFloat(avgRows[0].avg) * 10) / 10 : 0;

    // Распределение оценок
    const { rows: topRated } = await db.query(
      `SELECT rating, COUNT(*) as count 
       FROM user_lists WHERE user_id = $1 AND rating IS NOT NULL 
       GROUP BY rating ORDER BY rating DESC`,
      [userId]
    );

    res.json({
      total,
      counts,
      avgRating,
      ratingDistribution: topRated,
    });
  } catch (err) {
    console.error('Ошибка статистики:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
