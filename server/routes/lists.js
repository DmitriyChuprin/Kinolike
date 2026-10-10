const express = require('express');
const router = express.Router();
const ListItemModel = require('../models/listItem');
const { authMiddleware } = require('../middleware/auth');
const { scheduleGeneration } = require('../services/backgroundRecommendations');
const tmdbService = require('../services/tmdb');
const tasteProfile = require('../services/tasteProfile');
const db = require('../db/database');

// Все маршруты требуют авторизации
router.use(authMiddleware);

function isSupportedStatus(status) {
  return ['want_to_watch', 'watched', 'not_interested'].includes(status);
}

// Предзагрузка метаданных в media_metadata (fire-and-forget).
// getMovieDetails/getTvDetails сами проверят БД и при отсутствии сделают запрос к TMDB
// и сохранят результат. Чтобы карточки списков сразу видели постер/название/год.
function ensureMetadata(tmdbId, mediaType) {
  return tmdbService.ensureLocalizedMetadata(tmdbId, mediaType)
    .catch((err) => {
      console.error('[Lists] Предзагрузка метаданных не удалась:', tmdbId, mediaType, err.message);
    });
}

// Получить список
router.get('/', async (req, res) => {
  try {
    const { status, media_type, sort, compact } = req.query;
    const options = { status, media_type, sort, compact: compact === '1' || compact === 'true' };
    const items = await ListItemModel.findAllWithMetadata(req.user.id, options);
    const staleItems = items.filter((item) => item.locale !== 'ru-RU');
    if (staleItems.length > 0) {
      // Метаданные обновляются после ответа: открытие списка не должно ждать TMDB.
      void Promise.allSettled(staleItems.map((item) => ensureMetadata(item.tmdb_id, item.media_type)));
    }

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

// Получить одну запись коллекции без загрузки всей библиотеки пользователя.
router.get('/item/:mediaType/:tmdbId', async (req, res) => {
  try {
    const { mediaType, tmdbId } = req.params;
    const numericTmdbId = Number(tmdbId);
    if (!['movie', 'tv'].includes(mediaType) || !Number.isInteger(numericTmdbId) || numericTmdbId <= 0) {
      return res.status(400).json({ error: 'Некорректный media entity' });
    }

    const item = await ListItemModel.findByTmdb(req.user.id, numericTmdbId, mediaType);
    res.json({ item: item || null });
  } catch (err) {
    console.error('Ошибка получения элемента списка:', err);
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
    if (!Number.isInteger(Number(tmdb_id)) || !['movie', 'tv'].includes(media_type)) return res.status(400).json({ error: 'Некорректный media entity' });
    if (status !== undefined && !isSupportedStatus(status)) {
      return res.status(400).json({ error: 'Статус больше не поддерживается' });
    }

    // Проверяем, нет ли уже в списке
    const existing = await ListItemModel.findByTmdb(req.user.id, tmdb_id, media_type);
    if (existing) {
      await ListItemModel.update(existing.id, { status: status || 'want_to_watch' });
      const updated = await ListItemModel.findById(existing.id);
      ensureMetadata(tmdb_id, media_type);
      scheduleGeneration(req.user.id);
      await tasteProfile.invalidate(req.user.id);
      return res.json({ item: updated });
    }

    const result = await ListItemModel.create(req.user.id, { tmdb_id, media_type, status });
    const item = await ListItemModel.findById(result.lastInsertRowid);

    res.json({ item });
    ensureMetadata(tmdb_id, media_type);
    await tasteProfile.invalidate(req.user.id);
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
    if (status !== undefined && !isSupportedStatus(status)) {
      return res.status(400).json({ error: 'Статус больше не поддерживается' });
    }
    await ListItemModel.update(req.params.id, { status, rating, notes, watched_at });

    // Если изменилась оценка или статус — запускаем фоновую генерацию рекомендаций
    if (rating !== undefined || status !== undefined) {
      scheduleGeneration(req.user.id);
      await tasteProfile.invalidate(req.user.id);
      if (status === 'watched' || rating !== undefined) await db.query(`UPDATE recommendation_events SET watched_at=COALESCE(watched_at,NOW()), watched_rating=COALESCE($1,watched_rating) WHERE user_id=$2 AND tmdb_id=$3 AND media_type=$4`, [rating ?? null, req.user.id, item.tmdb_id, item.media_type]);
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
    scheduleGeneration(req.user.id);
    await tasteProfile.invalidate(req.user.id);

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
    if (items.some((item) => !isSupportedStatus(item.status || 'want_to_watch'))) {
      return res.status(400).json({ error: 'Файл содержит неподдерживаемый статус' });
    }

    await ListItemModel.importAll(req.user.id, items);
    scheduleGeneration(req.user.id);
    await tasteProfile.invalidate(req.user.id);

    res.json({ message: 'Импорт завершён', count: items.length });
  } catch (err) {
    console.error('Ошибка импорта:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
