const express = require('express');
const router = express.Router();
const ListItemModel = require('../models/listItem');
const { authMiddleware } = require('../middleware/auth');
const { scheduleGeneration } = require('../services/backgroundRecommendations');
const tmdbService = require('../services/tmdb');

// Все маршруты требуют авторизации
router.use(authMiddleware);

// Предзагрузка метаданных в media_metadata (fire-and-forget).
// getMovieDetails/getTvDetails сами проверят БД и при отсутствии сделают запрос к TMDB
// и сохранят результат. Чтобы карточки списков сразу видели постер/название/год.
function ensureMetadata(tmdbId, mediaType) {
  tmdbService.getMediaMetadata(tmdbId, mediaType)
    .then((existing) => {
      if (existing) return;
      return mediaType === 'movie'
        ? tmdbService.getMovieDetails(tmdbId)
        : tmdbService.getTvDetails(tmdbId);
    })
    .catch((err) => {
      console.error('[Lists] Предзагрузка метаданных не удалась:', tmdbId, mediaType, err.message);
    });
}

// Получить список
router.get('/', async (req, res) => {
  try {
    const { status, media_type, sort } = req.query;
    const items = await ListItemModel.findAllWithMetadata(req.user.id, { status, media_type, sort });

    // Получаем количество по статусам для бейджей
    const counts = await ListItemModel.getCountsByStatus(req.user.id);
    const statusCounts = {};
    for (const c of counts) {
      statusCounts[c.status] = c.count;
    }

    res.json({ items, statusCounts });
  } catch (err) {
    console.error('Ошибка получения списка:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Добавить в список
router.post('/', async (req, res) => {
  try {
    const { tmdb_id, media_type, status } = req.body;

    if (!tmdb_id || !media_type) {
      return res.status(400).json({ error: 'tmdb_id и media_type обязательны' });
    }

    // Проверяем, нет ли уже в списке
    const existing = await ListItemModel.findByTmdb(req.user.id, tmdb_id, media_type);
    if (existing) {
      await ListItemModel.update(existing.id, { status: status || 'want_to_watch' });
      const updated = await ListItemModel.findById(existing.id);
      ensureMetadata(tmdb_id, media_type);
      return res.json({ item: updated });
    }

    const result = await ListItemModel.create(req.user.id, { tmdb_id, media_type, status });
    const item = await ListItemModel.findById(result.lastInsertRowid);

    res.json({ item });
    ensureMetadata(tmdb_id, media_type);
  } catch (err) {
    console.error('Ошибка добавления в список:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Обновить запись
router.put('/:id', async (req, res) => {
  try {
    const item = await ListItemModel.findById(req.params.id);
    if (!item || item.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Запись не найдена' });
    }

    const { status, rating, notes, watched_at } = req.body;
    await ListItemModel.update(req.params.id, { status, rating, notes, watched_at });

    // Если изменилась оценка или статус — запускаем фоновую генерацию рекомендаций
    if (rating !== undefined || status !== undefined) {
      scheduleGeneration(req.user.id);
    }

    const updated = await ListItemModel.findById(req.params.id);
    res.json({ item: updated });
  } catch (err) {
    console.error('Ошибка обновления записи:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Удалить
router.delete('/:id', async (req, res) => {
  try {
    const item = await ListItemModel.findById(req.params.id);
    if (!item || item.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Запись не найдена' });
    }

    await ListItemModel.delete(req.params.id);

    res.json({ message: 'Удалено' });
  } catch (err) {
    console.error('Ошибка удаления:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Экспорт
router.get('/export', async (req, res) => {
  try {
    const items = await ListItemModel.exportAll(req.user.id);
    res.json(items);
  } catch (err) {
    console.error('Ошибка экспорта:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Импорт
router.post('/import', async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'items должен быть массивом' });
    }

    await ListItemModel.importAll(req.user.id, items);

    res.json({ message: 'Импорт завершён', count: items.length });
  } catch (err) {
    console.error('Ошибка импорта:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
