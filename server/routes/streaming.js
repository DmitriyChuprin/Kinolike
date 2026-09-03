// Роуты стриминга: поиск через Jackett + воспроизведение через TorrServer + Jellyfin
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const jackett = require('../services/jackett');
const torrserver = require('../services/torrserver');
const jellyfin = require('../services/jellyfin');
const db = require('../db/database');
const { optionalAuth } = require('../middleware/auth');

// Папки для .strm файлов (маунтятся извне)
const MOVIES_DIR = process.env.MOVIES_DIR || '/mnt/server/movies';
const SERIALS_DIR = process.env.SERIALS_DIR || '/mnt/server/serials';
const TORRSERVER_USERNAME = process.env.TORRSERVER_USERNAME || '';
const TORRSERVER_PASSWORD = process.env.TORRSERVER_PASSWORD || '';

/**
 * Получить чистый URL TorrServer без авторизации
 * Используется для .strm файлов, которые читает Jellyfin
 */
function getTorrServerCleanUrl() {
  const url = process.env.TORRSERVER_URL || '';
  const base = url.startsWith('http') ? url.replace(/^https?:\/\//, '') : url;
  const port = process.env.TORRSERVER_PORT || '8091';
  return `http://${base}:${port}`;
}

/**
 * Очистить имя файла от недопустимых символов
 */
function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Сохранить .strm файл для фильма (один файл = один фильм)
 */
function saveStrmFile(title, streamUrl, mediaType) {
  try {
    const dir = mediaType === 'tv' ? SERIALS_DIR : MOVIES_DIR;
    fs.mkdirSync(dir, { recursive: true });

    const filename = sanitizeFilename(title) + '.strm';
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, streamUrl, 'utf-8');

    console.log(`[Streaming] .strm saved: ${filepath}`);
    return filepath;
  } catch (err) {
    console.error('[Streaming] Ошибка сохранения .strm:', err.message);
    return null;
  }
}

/**
 * Парсинг Season/Episode из имени файла торрента
 * Поддерживает: S01E01, s01e01, S01E01E02, Season 01/Episode 01, [01], 01.mkv
 * Возвращает { season, episode } или null
 */
function parseSeasonEpisode(filename) {
  // S01E01, S01E01E02, s01e01, etc.
  const sxxexx = filename.match(/S(\d{1,2})E(\d{1,3})/i);
  if (sxxexx) {
    return { season: parseInt(sxxexx[1]), episode: parseInt(sxxexx[2]) };
  }

  // Season XX / Episode XX or SeasonXX / EpXX
  const seasonDir = filename.match(/Season[\s._-]*(\d{1,2})/i);
  const episodeDir = filename.match(/(?:Episode|Ep)[\s._-]*(\d{1,3})/i);
  if (seasonDir && episodeDir) {
    return { season: parseInt(seasonDir[1]), episode: parseInt(episodeDir[1]) };
  }

  // [01], [02] в имени файла
  const bracketNum = filename.match(/\[(\d{1,3})\]/);
  if (bracketNum) {
    return { season: null, episode: parseInt(bracketNum[1]) };
  }

  // Число перед расширением: 01.mkv, 02.mkv
  const numFile = filename.match(/(\d{1,3})\.\w{2,4}$/);
  if (numFile) {
    return { season: null, episode: parseInt(numFile[1]) };
  }

  return null;
}

/**
 * Дождаться появления файлов торрента в TorrServer
 * (метаданные могут загружаться до 60+ секунд для больших торрентов)
 */
async function waitForFiles(hash, maxAttempts = 30, delayMs = 3000) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const files = await torrserver.getTorrentFiles(hash);
      if (files && files.length > 0) return files;
    } catch (e) {
      console.log(`[Streaming] Ожидание файлов (попытка ${i + 1}/${maxAttempts})...`);
    }
    if (i < maxAttempts - 1) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return [];
}

/**
 * Фоновая задача: дождаться файлов и создать отдельные .strm для сериала
 */
async function backgroundCreateSeriesStrm(hash, title, tmdbId, userId, mediaType, poster, dbInstance) {
  console.log(`[Streaming] Фоновая задача: ожидание файлов для "${title}" (hash: ${hash})`);
  
  // Ждём файлы (до 60 секунд)
  const files = await waitForFiles(hash, 20, 3000);
  
  if (files.length === 0) {
    console.log(`[Streaming] Фоновая задача: файлы так и не загрузились для "${title}"`);
    return;
  }
  
  console.log(`[Streaming] Фоновая задача: найдено ${files.length} файлов для "${title}"`);
  
  // Создаём отдельные .strm файлы
  const created = saveStrmFilesForSeries({
    title: title || 'unknown',
    hash,
    files,
    seasonNumber: 0,
    baseUrl: getTorrServerCleanUrl(),
  });
  
  console.log(`[Streaming] Фоновая задача: создано ${created.length} .strm файлов для "${title}"`);
  
  // Удаляем fallback .strm файл (один большой файл)
  try {
    const fallbackPath = path.join(SERIALS_DIR, sanitizeFilename(title) + '.strm');
    if (fs.existsSync(fallbackPath)) {
      fs.unlinkSync(fallbackPath);
      console.log(`[Streaming] Фоновая задача: удалён fallback .strm: ${fallbackPath}`);
    }
  } catch (err) {
    console.error('[Streaming] Ошибка удаления fallback .strм:', err.message);
  }
  
  // Отправляем запрос на сканирование библиотеки в Jellyfin и ждём результат
  await jellyfin.refreshLibrary();
  
  // Обновляем stream_url и jellyfin_url в БД
  if (dbInstance && userId && tmdbId) {
    try {
      const streamUrl = `${getTorrServerCleanUrl()}/stream?link=${hash}&index=0&play`;
      
      let jellyfinUrl = null;
      if (title) {
        const jellyfinResult = await jellyfin.waitForItem(title, 'tv');
        if (jellyfinResult) {
          jellyfinUrl = jellyfinResult.jellyfinUrl;
        }
      }
      
      await dbInstance.query(
        `UPDATE streaming_links SET stream_url = $1, jellyfin_url = COALESCE($4, jellyfin_url) WHERE user_id = $2 AND tmdb_id = $3 AND media_type = 'tv'`,
        [streamUrl, userId, parseInt(tmdbId), jellyfinUrl]
      );
    } catch (dbErr) {
      console.error('[Streaming] Фоновая задача: ошибка обновления БД:', dbErr.message);
    }
  }
}

/**
 * Сохранить .strm файлы для сериала
 * Структура: serials/Show Name/Season XX/Show Name SXXEXX.strm
 *
 * @param {Object} opts
 * @param {string} opts.title — название сериала
 * @param {string} opts.hash — info_hash торрента
 * @param {Array} opts.files — файлы торрента [{Id, Name, Length}]
 * @param {number} opts.seasonNumber — номер сезона (если 0 — автоиз файлов)
 * @param {string} opts.baseUrl — базовый URL TorrServer
 * @returns {Array} список созданных .strm файлов
 */
function saveStrmFilesForSeries({ title, hash, files, seasonNumber = 0, baseUrl }) {
  const created = [];
  const showName = sanitizeFilename(title);

  // Определяем сезон и эпизоды
  let episodeMap = []; // [{fileId, season, episode}]

  // Сначала пробуем парсить из имён файлов
  let hasParsedSeason = false;
  const parsed = files.map((f, i) => {
    const parsed2 = parseSeasonEpisode(f.Name || '');
    return {
      fileId: f.Id ?? i,
      fileName: f.Name || `file_${i}`,
      season: parsed2?.season || 0,
      episode: parsed2?.episode || 0,
    };
  });

  // Проверяем, есть ли Season в подпапках
  const seasonFromPath = files.reduce((acc, f) => {
    const m = (f.Name || '').match(/Season[\s._-]*(\d{1,2})/i);
    return m ? parseInt(m[1]) : acc;
  }, 0);

  if (seasonFromPath > 0) {
    hasParsedSeason = true;
    parsed.forEach(p => { if (p.season === 0) p.season = seasonFromPath; });
  }

  // Если сезон задан явно — используем его
  const effectiveSeason = seasonNumber > 0 ? seasonNumber : (hasParsedSeason ? seasonFromPath : 1);

  // Если эпизоды не распознаны — нумеруем последовательно
  let needsSequential = parsed.every(p => p.episode === 0);
  if (needsSequential) {
    parsed.forEach((p, i) => { p.episode = i + 1; });
  }

  // Устанавливаем сезон если не определён
  parsed.forEach(p => { if (p.season === 0) p.season = effectiveSeason; });

  console.log(`[Streaming] Генерация .strm для сериала "${showName}", сезон ${effectiveSeason}, файлов: ${parsed.length}`);

  for (const item of parsed) {
    const seasonDir = `Season ${String(item.season).padStart(2, '0')}`;
    const epCode = `S${String(item.season).padStart(2, '0')}E${String(item.episode).padStart(2, '0')}`;
    const filename = `${showName} ${epCode}.strm`;
    const dirPath = path.join(SERIALS_DIR, showName, seasonDir);
    const filepath = path.join(dirPath, filename);

    const streamUrl = `${baseUrl}/stream?link=${hash}&index=${item.fileId}&play`;

    try {
      fs.mkdirSync(dirPath, { recursive: true });
      fs.writeFileSync(filepath, streamUrl, 'utf-8');
      created.push({ fileId: item.fileId, season: item.season, episode: item.episode, path: filepath });
      console.log(`[Streaming] .strm saved: ${filepath}`);
    } catch (err) {
      console.error(`[Streaming] Ошибка записи ${filepath}:`, err.message);
    }
  }

  return created;
}

/**
 * POST /api/streaming/search
 * Поиск торрентов через Jackett
 */
router.post('/search', async (req, res) => {
  try {
    const { query, type = 'movie' } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'query обязателен' });
    }

    let results = await jackett.search(query, type);

    if (results.length === 0) {
      const cleaned = query.replace(/\s*\(\d{4}\)\s*$/, '').trim();
      if (cleaned !== query) {
        results = await jackett.search(cleaned, type);
      }
    }

    if (results.length === 0) {
      const short = query.split(/[:\\/]/)[0].replace(/\s*\(\d{4}\)\s*$/, '').trim();
      if (short !== query && short.length > 2) {
        results = await jackett.search(short, type);
      }
    }

    res.json({ results });
  } catch (err) {
    console.error('Ошибка поиска торрентов:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/streaming/play
 * Добавление торрента + генерация .strm
 * Для фильмов: один .strm файл
 * Для сериалов: возвращает список файлов торрента для UI
 */
router.post('/play', optionalAuth, async (req, res) => {
  try {
    const { magnet, title, poster, tmdbId, mediaType, fileIndex = 0 } = req.body;

    if (!magnet) {
      return res.status(400).json({ error: 'magnet обязателен' });
    }

    console.log(`[Streaming] play: title="${title}", type="${mediaType}"`);

    const result = await torrserver.addTorrent(magnet, title, poster);

    if (!result.hash) {
      return res.status(500).json({ error: 'Не удалось получить info_hash торрента' });
    }

    const streamUrl = `${getTorrServerCleanUrl()}/stream?link=${result.hash}&index=${fileIndex}&play`;

    // Для фильмов — сохраняем один .strm как раньше
    if (mediaType !== 'tv') {
      const strmPath = saveStrmFile(title || 'unknown', streamUrl, mediaType || 'movie');

      // Отправляем запрос на сканирование библиотеки в Jellyfin и ждём результат
      let jellyfinUrl = null;
      if (title) {
        await jellyfin.refreshLibrary();
        const jellyfinResult = await jellyfin.waitForItem(title, mediaType || 'movie');
        if (jellyfinResult) {
          jellyfinUrl = jellyfinResult.jellyfinUrl;
        }
      }

      if (req.user && tmdbId && mediaType) {
        try {
          await db.query(
            `INSERT INTO streaming_links (user_id, tmdb_id, media_type, title, poster, hash, stream_url, jellyfin_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (user_id, tmdb_id, media_type)
             DO UPDATE SET title = $4, poster = $5, hash = $6, stream_url = $7, jellyfin_url = $8`,
            [req.user.id, tmdbId, mediaType, title || '', poster || '', result.hash, streamUrl, jellyfinUrl]
          );
        } catch (dbErr) {
          console.error('[Streaming] Ошибка сохранения в БД:', dbErr.message);
        }
      }

      return res.json({ hash: result.hash, streamUrl, strmPath, jellyfinUrl });
    }

    // Для сериалов — создаём .strm файлы автоматически
    console.log(`[Streaming] Ожидание файлов торрента...`);
    const files = await waitForFiles(result.hash);

    let jellyfinUrl = null;

    if (files.length === 0) {
      // Файлы не загрузились — сохраняем один .strm как fallback
      console.log(`[Streaming] Файлы не найдены, сохраняем один .strm`);
      const strmPath = saveStrmFile(title || 'unknown', streamUrl, 'tv');

      // Фоновая задача: дождаться файлов и создать отдельные .strм
      backgroundCreateSeriesStrm(result.hash, title, tmdbId, req.user?.id, mediaType, poster, req.user ? db : null);

      return res.json({ hash: result.hash, streamUrl, strmPath, files: [], jellyfinUrl, pendingSeriesSetup: true });
    }

    console.log(`[Streaming] Найдено файлов: ${files.length}`);

    // Сохраняем .strm файлы с автодетектом сезона из имён файлов
    const created = saveStrmFilesForSeries({
      title: title || 'unknown',
      hash: result.hash,
      files,
      seasonNumber: 0, // автоиз файлов
      baseUrl: getTorrServerCleanUrl(),
    });

    console.log(`[Streaming] Создано ${created.length} .strм файлов для сериала`);

    // Отправляем запрос на сканирование библиотеки в Jellyfin и ждём результат
    if (title) {
      await jellyfin.refreshLibrary();
      const jellyfinResult = await jellyfin.waitForItem(title, 'tv');
      if (jellyfinResult) {
        jellyfinUrl = jellyfinResult.jellyfinUrl;
      }
    }

    // Сохраняем в БД
    if (req.user && tmdbId && mediaType) {
      try {
        await db.query(
          `INSERT INTO streaming_links (user_id, tmdb_id, media_type, title, poster, hash, stream_url, jellyfin_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (user_id, tmdb_id, media_type)
           DO UPDATE SET title = $4, poster = $5, hash = $6, stream_url = $7, jellyfin_url = $8`,
          [req.user.id, tmdbId, mediaType, title || '', poster || '', result.hash, streamUrl, jellyfinUrl]
        );
      } catch (dbErr) {
        console.error('[Streaming] Ошибка сохранения в БД:', dbErr.message);
      }
    }

    return res.json({ hash: result.hash, streamUrl, created, count: created.length, jellyfinUrl });

  } catch (err) {
    console.error('Ошибка запуска стриминга:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/streaming/save-series
 * Сохранение .strm файлов для сериала с правильной структурой
 *
 * Body: { hash, title, season, files: [{id, name}], tmdbId }
 */
router.post('/save-series', optionalAuth, async (req, res) => {
  try {
    const { hash, title, season = 1, files = [], tmdbId } = req.body;

    if (!hash || !files.length) {
      return res.status(400).json({ error: 'hash и files обязательны' });
    }

    const created = saveStrmFilesForSeries({
      title: title || 'unknown',
      hash,
      files: files.map(f => ({ Id: f.id, Name: f.name })),
      seasonNumber: season,
      baseUrl: getTorrServerCleanUrl(),
    });

    // Обновляем stream_url и jellyfin_url в БД
    const streamUrl = `${getTorrServerCleanUrl()}/stream?link=${hash}&index=0&play`;

    // Отправляем запрос на сканирование библиотеки в Jellyfin и ждём результат
    let jellyfinUrl = null;
    if (title) {
      await jellyfin.refreshLibrary();
      const jellyfinResult = await jellyfin.waitForItem(title, 'tv');
      if (jellyfinResult) {
        jellyfinUrl = jellyfinResult.jellyfinUrl;
      }
    }

    if (req.user && tmdbId) {
      try {
        await db.query(
          `UPDATE streaming_links SET stream_url = $1, jellyfin_url = COALESCE($4, jellyfin_url) WHERE user_id = $2 AND tmdb_id = $3 AND media_type = 'tv'`,
          [streamUrl, req.user.id, parseInt(tmdbId), jellyfinUrl]
        );
      } catch (dbErr) {
        console.error('[Streaming] Ошибка обновления БД:', dbErr.message);
      }
    }

    res.json({ created, count: created.length, jellyfinUrl });
  } catch (err) {
    console.error('Ошибка сохранения сериала:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/streaming/files
 * Получить список файлов торрента по hash
 */
router.post('/files', async (req, res) => {
  try {
    const { hash } = req.body;
    if (!hash) return res.status(400).json({ error: 'hash обязателен' });

    const files = await waitForFiles(hash, 3, 1000);
    res.json({
      files: files.map((f, i) => ({
        id: f.Id ?? i,
        name: f.Name || '',
        size: f.Length || 0,
      })),
    });
  } catch (err) {
    console.error('Ошибка получения файлов:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/streaming/link/:type/:tmdbId
 */
router.get('/link/:type/:tmdbId', optionalAuth, async (req, res) => {
  if (!req.user) {
    return res.json({ link: null });
  }

  const { type, tmdbId } = req.params;
  const { rows } = await db.query(
    'SELECT * FROM streaming_links WHERE user_id = $1 AND tmdb_id = $2 AND media_type = $3',
    [req.user.id, parseInt(tmdbId), type]
  );

  res.json({ link: rows[0] || null });
});

/**
 * DELETE /api/streaming/link/:type/:tmdbId
 */
router.delete('/link/:type/:tmdbId', optionalAuth, async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Необходима авторизация' });
  }

  const { type, tmdbId } = req.params;
  await db.query(
    'DELETE FROM streaming_links WHERE user_id = $1 AND tmdb_id = $2 AND media_type = $3',
    [req.user.id, parseInt(tmdbId), type]
  );

  res.json({ ok: true });
});

/**
 * POST /api/streaming/info
 */
router.post('/info', async (req, res) => {
  try {
    const { hash } = req.body;
    if (!hash) return res.status(400).json({ error: 'hash обязателен' });
    const info = await torrserver.getTorrentInfo(hash);
    res.json(info);
  } catch (err) {
    console.error('Ошибка получения информации:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/streaming/status
 */
router.get('/status', async (req, res) => {
  try {
    const available = await torrserver.checkStatus();
    const jellyfinAvailable = await jellyfin.checkStatus();
    res.json({ available, jellyfinAvailable });
  } catch {
    res.json({ available: false, jellyfinAvailable: false });
  }
});

/**
 * POST /api/streaming/refresh-jellyfin/:type/:tmdbId
 * Принудительно обновить jellyfin_url для существующей записи
 */
router.post('/refresh-jellyfin/:type/:tmdbId', optionalAuth, async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Необходима авторизация' });
  }

  const { type, tmdbId } = req.params;

  try {
    // Получаем запись из БД
    const { rows } = await db.query(
      'SELECT * FROM streaming_links WHERE user_id = $1 AND tmdb_id = $2 AND media_type = $3',
      [req.user.id, parseInt(tmdbId), type]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Запись не найдена' });
    }

    const record = rows[0];
    const title = record.title;

    // Отправляем запрос на сканирование и ждём результат
    await jellyfin.refreshLibrary();

    // Ищем в Jellyfin
    const jellyfinResult = await jellyfin.waitForItem(title, type);
    const jellyfinUrl = jellyfinResult ? jellyfinResult.jellyfinUrl : null;

    // Обновляем в БД
    await db.query(
      'UPDATE streaming_links SET jellyfin_url = $1 WHERE id = $2',
      [jellyfinUrl, record.id]
    );

    res.json({ jellyfinUrl });
  } catch (err) {
    console.error('[Streaming] Ошибка обновления Jellyfin:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
