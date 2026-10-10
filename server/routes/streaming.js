// Роуты стриминга: поиск через Jackett + воспроизведение через TorrServer + Jellyfin
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { Readable } = require('node:stream');
const jackett = require('../services/jackett');
const torrserver = require('../services/torrserver');
const jellyfin = require('../services/jellyfin');
const phantom = require('../services/phantom');
const videohub = require('../services/videohub');
const playbackLifecycle = require('../services/playbackLifecycle');
const segmentProviders = require('../services/segments');
const db = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const { hasJellyfinAccess, requireJellyfinAccess } = require('../middleware/access');

// Все операции со стримингом требуют входа: они могут запускать TorrServer,
// создавать .strm-файлы и добавлять контент в Jellyfin.
router.use(authMiddleware);

function segmentInput(query) {
  const tmdbId = Number(query.tmdb_id);
  const mediaType = String(query.media_type || '');
  const season = query.season === undefined ? null : optionalPositive(query.season);
  const episode = query.episode === undefined ? null : optionalPositive(query.episode);
  const duration = query.duration === undefined ? 0 : Math.round(Number(query.duration));
  const imdbId = String(query.imdb_id || '').trim();
  if (!Number.isInteger(tmdbId) || tmdbId <= 0 || !['movie', 'tv'].includes(mediaType)
    || !Number.isFinite(duration) || duration < 0 || duration > 7 * 24 * 60 * 60
    || (mediaType === 'movie' && (season !== null || episode !== null))
    || (mediaType === 'tv' && (!season || !episode))) throw new Error('Некорректные параметры сегментов');
  return { tmdbId, mediaType, season: season || 0, episode: episode || 0, duration, imdbId: /^tt\d+$/i.test(imdbId) ? imdbId : null };
}

function segmentResponse(row) {
  return {
    intro: row.intro_start === null || row.intro_end === null ? null : { start: Number(row.intro_start), end: Number(row.intro_end) },
    credits: row.credits_start === null || row.credits_end === null ? null : { start: Number(row.credits_start), end: Number(row.credits_end) },
    source: row.source,
  };
}

// One backend contract for every player source. External services are never
// called by React, and failures intentionally degrade to an empty response.
router.get('/segments', async (req, res) => {
  let input;
  try { input = segmentInput(req.query); } catch (err) { return res.status(400).json({ error: err.message }); }
  try {
    const label = `${input.mediaType}:${input.tmdbId}${input.mediaType === 'tv' ? ` S${input.season}E${input.episode}` : ''} (${input.duration}s)`;
    const cached = await db.query(
      `SELECT * FROM streaming_segments WHERE tmdb_id = $1 AND media_type = $2 AND season = $3 AND episode = $4 AND duration_seconds = $5`,
      [input.tmdbId, input.mediaType, input.season, input.episode, input.duration]
    );
    if (cached.rows[0]) {
      const response = segmentResponse(cached.rows[0]);
      console.info(`[Segments] cache hit ${label}; source=${response.source}; intro=${response.intro ? `${response.intro.start}-${response.intro.end}` : 'none'}; credits=${response.credits ? `${response.credits.start}-${response.credits.end}` : 'none'}`);
      return res.json(response);
    }

    // Browser-provided IMDb can be stale/missing, so use the canonical TMDB
    // metadata enrichment as a fallback before deciding no lookup is possible.
    if (!input.imdbId) {
      const metadata = await db.query('SELECT imdb_id FROM media_metadata WHERE tmdb_id = $1 AND media_type = $2', [input.tmdbId, input.mediaType]);
      const candidate = String(metadata.rows[0]?.imdb_id || '');
      if (/^tt\d+$/i.test(candidate)) input.imdbId = candidate;
    }
    const result = input.imdbId
      ? await segmentProviders.fetchSegments(input)
      : { intro: null, credits: null, source: 'none' };
    const stored = await db.query(
      `INSERT INTO streaming_segments (tmdb_id, imdb_id, media_type, season, episode, duration_seconds, intro_start, intro_end, credits_start, credits_end, source, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CURRENT_TIMESTAMP)
       ON CONFLICT (tmdb_id, media_type, season, episode, duration_seconds) DO UPDATE SET
         imdb_id = EXCLUDED.imdb_id, intro_start = EXCLUDED.intro_start, intro_end = EXCLUDED.intro_end,
         credits_start = EXCLUDED.credits_start, credits_end = EXCLUDED.credits_end, source = EXCLUDED.source, updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [input.tmdbId, input.imdbId, input.mediaType, input.season, input.episode, input.duration,
        result.intro?.start ?? null, result.intro?.end ?? null, result.credits?.start ?? null, result.credits?.end ?? null, result.source]
    );
    const response = segmentResponse(stored.rows[0]);
    console.info(`[Segments] cache miss ${label}; imdb=${input.imdbId || 'missing'}; source=${response.source}; intro=${response.intro ? `${response.intro.start}-${response.intro.end}` : 'none'}; credits=${response.credits ? `${response.credits.start}-${response.credits.end}` : 'none'}`);
    res.json(response);
  } catch (err) {
    // Segment support must never block the player. A successful empty response
    // lets clients continue playback even during DB/provider trouble.
    console.warn('[Segments] unavailable:', err.message);
    res.json({ intro: null, credits: null, source: 'none' });
  }
});

// Папки для .strm файлов (маунтятся извне)
const MOVIES_DIR = process.env.MOVIES_DIR || '/mnt/server/movies';
const SERIALS_DIR = process.env.SERIALS_DIR || '/mnt/server/serials';
const TORRSERVER_USERNAME = process.env.TORRSERVER_USERNAME || '';
const TORRSERVER_PASSWORD = process.env.TORRSERVER_PASSWORD || '';
const STREAMING_DIAGNOSTICS = process.env.STREAMING_DIAGNOSTICS === 'true';

function jellyfinProxyUrl(upstreamPath) {
  return `/api/streaming/jellyfin/proxy?path=${encodeURIComponent(upstreamPath)}`;
}

function rewriteHlsManifest(manifest, manifestUrl) {
  const rewrite = (value) => {
    if (!value || /^(?:data:|blob:)/i.test(value)) return value;
    const resolved = jellyfin.resolveUpstreamPath(new URL(value, manifestUrl).toString());
    return jellyfinProxyUrl(`${resolved.pathname}${resolved.search}`);
  };
  return manifest.split(/\r?\n/).map((line) => {
    if (!line) return line;
    if (!line.startsWith('#')) return rewrite(line.trim());
    return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${rewrite(uri)}"`);
  }).join('\n');
}

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
 * Дождаться появления файлов торрента в TorrServer.
 * Пока TorrServer читает magnet, файловый список может быть пустым.
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
 * Синхронизировать созданные .strm-файлы с Jellyfin и получить ссылку.
 * Если Jellyfin не настроен/недоступен, торрент всё равно считается добавленным:
 * .strm-файл уже находится в подключённой библиотеке.
 */
async function syncWithJellyfin(title, mediaType) {
  if (!title) return null;

  const refreshed = await jellyfin.refreshLibrary();
  if (!refreshed) return null;

  const jellyfinResult = await jellyfin.waitForItem(title, mediaType);
  return jellyfinResult?.jellyfinUrl || null;
}

function getPrimaryFileId(files, requestedIndex = 0) {
  if (!files.length) return requestedIndex;
  const requested = files.find((file) => Number(file.Id) === Number(requestedIndex));
  return requested ? requested.Id : (files[0].Id ?? requestedIndex);
}

function getPlayableFiles(files) {
  const videoFiles = files.filter((file) => /\.(mkv|mp4|avi|m4v|mov|webm|ts|flv)$/i.test(file.Name || ''));
  return videoFiles.length > 0 ? videoFiles : files;
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

    if (typeof query !== 'string' || !query.trim() || query.length > 300) {
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
 * Добавление торрента в TorrServer, ожидание чтения метаданных,
 * генерация .strm и синхронизация с Jellyfin.
 */
router.post('/play', async (req, res) => {
  try {
    const { magnet, title, poster, tmdbId, mediaType, fileIndex = 0 } = req.body;

    if (typeof magnet !== 'string' || !magnet.startsWith('magnet:?xt=urn:btih:') || magnet.length > 4096) {
      return res.status(400).json({ error: 'magnet обязателен' });
    }
    if (!Number.isInteger(Number(tmdbId)) || !['movie', 'tv'].includes(mediaType)) return res.status(400).json({ error: 'Некорректный media entity' });

    console.log(`[Streaming] play: title="${title}", type="${mediaType}"`);

    const result = await torrserver.addTorrent(magnet, title, poster);

    if (!result.hash) {
      return res.status(500).json({ error: 'Не удалось получить info_hash торрента' });
    }

    console.log(`[Streaming] Ожидание чтения торрента TorrServer...`);
    const files = await waitForFiles(result.hash);
    if (files.length === 0) {
      throw new Error('TorrServer не успел прочитать торрент. Попробуйте выбрать его ещё раз.');
    }

    const playableFiles = getPlayableFiles(files);
    const primaryFileId = getPrimaryFileId(playableFiles, fileIndex);
    const streamUrl = `${getTorrServerCleanUrl()}/stream?link=${result.hash}&index=${primaryFileId}&play`;
    let created = [];
    let strmPath = null;

    // Для фильма — один .strm, для сериала — отдельный .strm на каждый эпизод.
    if (mediaType !== 'tv') {
      strmPath = saveStrmFile(title || 'unknown', streamUrl, mediaType || 'movie');
      if (!strmPath) {
        throw new Error('Не удалось создать .strm-файл фильма. Проверьте каталоги MOVIES_DIR/SERIALS_DIR.');
      }
    } else {
      created = saveStrmFilesForSeries({
        title: title || 'unknown',
        hash: result.hash,
        files: playableFiles,
        seasonNumber: 0,
        baseUrl: getTorrServerCleanUrl(),
      });

      if (created.length === 0) {
        throw new Error('Не удалось создать .strm-файлы для сериала.');
      }
    }

    console.log(`[Streaming] .strm-файлы созданы, синхронизация с Jellyfin...`);
    const jellyfinUrl = await hasJellyfinAccess(req.user.id)
      ? await syncWithJellyfin(title, mediaType || 'movie')
      : null;

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

    return res.json({
      hash: result.hash,
      streamUrl,
      strmPath,
      files: files.map((file) => ({ id: file.Id, name: file.Name, size: file.Length })),
      created,
      count: created.length || 1,
      jellyfinUrl,
      addedToTorrServer: true,
      syncedToJellyfin: Boolean(jellyfinUrl),
    });

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
router.post('/save-series', async (req, res) => {
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
    if (title && await hasJellyfinAccess(req.user.id)) {
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
router.get('/link/:type/:tmdbId', async (req, res) => {
  try {
    const { type, tmdbId } = req.params;
    const { rows } = await db.query(
      'SELECT * FROM streaming_links WHERE user_id = $1 AND tmdb_id = $2 AND media_type = $3',
      [req.user.id, parseInt(tmdbId), type]
    );

    const link = rows[0] || null;
    // An old per-user record may contain a previously generated Jellyfin URL.
    // Do not disclose it after the permission has been revoked.
    if (link && !await hasJellyfinAccess(req.user.id)) link.jellyfin_url = null;
    res.json({ link });
  } catch (err) {
    console.error('[Streaming] Ошибка получения ссылки:', err.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

/**
 * Explicit Jellyfin availability check. It is intentionally not called while
 * rendering the detail page, and never exposes the Jellyfin URL or API key.
 */
router.get('/jellyfin/check', requireJellyfinAccess, async (req, res) => {
  const tmdbId = Number(req.query.tmdb_id);
  const mediaType = req.query.media_type;
  const title = String(req.query.title || '').trim().slice(0, 300);
  const originalTitle = String(req.query.original_title || '').trim().slice(0, 300);
  const year = Number(req.query.year) || undefined;
  if (!Number.isInteger(tmdbId) || tmdbId <= 0 || !['movie', 'tv'].includes(mediaType) || !title) {
    return res.status(400).json({ error: 'Некорректные параметры проверки Jellyfin' });
  }
  try {
    const found = await jellyfin.findItem({ tmdbId, mediaType, title, originalTitle, year });
    if (!found) return res.json({ found: false });
    res.json({ found: true, itemId: found.itemId, title: found.itemName, itemType: found.itemType });
  } catch (err) {
    console.error('[Jellyfin] Проверка доступности:', err.message);
    res.status(502).json({ error: 'Не удалось подключиться к Jellyfin' });
  }
});

function phantomInput(req) {
  const tmdbId = Number(req.query.tmdb_id ?? req.body?.tmdb_id);
  const mediaType = req.query.media_type ?? req.body?.media_type;
  const title = String(req.query.title ?? req.body?.title ?? '').trim().slice(0, 300);
  // Query endpoints use snake_case. Accept the React object's camelCase too:
  // playback is JSON and must not silently discard the external identifiers.
  const originalTitle = String(req.query.original_title ?? req.body?.original_title ?? req.body?.originalTitle ?? '').trim().slice(0, 300);
  const imdbId = String(req.query.imdb_id ?? req.body?.imdb_id ?? req.body?.imdbId ?? '').trim();
  const kinopoiskId = String(req.query.kinopoisk_id ?? req.body?.kinopoisk_id ?? req.body?.kinopoiskId ?? '').trim();
  const year = Number(req.query.year ?? req.body?.year) || undefined;
  const originalLanguage = String(req.query.original_language ?? req.body?.original_language ?? req.body?.originalLanguage ?? '').trim();
  // TMDB id belongs only to KinoLike. Phantom receives stable external IDs
  // when available, otherwise it performs its native title/year fallback.
  if (!['movie', 'tv'].includes(mediaType) || !title) throw new Error('Некорректные параметры Phantom');
  return { tmdbId: Number.isInteger(tmdbId) ? tmdbId : undefined, mediaType, title, originalTitle, imdbId: /^tt\d+$/i.test(imdbId) ? imdbId : undefined, kinopoiskId: /^\d{1,20}$/.test(kinopoiskId) ? kinopoiskId : undefined, year, originalLanguage: originalLanguage.slice(0, 20) };
}

function optionalPositive(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number < 10000 ? number : null;
}

async function preferredOnlineSource(req, requestedSource) {
  // The preference is always resolved from the authenticated account. A
  // client-provided user ID or source must not choose another user's setting.
  const { rows } = await db.query(
    `SELECT preferred_streaming_source FROM users WHERE id = $1`,
    [req.user.id]
  );
  if (requestedSource === 'phantom' || requestedSource === 'videohub') return requestedSource;
  return rows[0]?.preferred_streaming_source === 'videohub' ? 'videohub' : 'phantom';
}

function sourceOrder(preferred) {
  // Initial resolution is always Phantom first.  Subsequent selector calls
  // stay on the already selected provider, but can still recover via the other.
  return preferred === 'videohub' ? ['videohub', 'phantom'] : ['phantom', 'videohub'];
}

async function lookupOnline(input, preferred) {
  const failures = [];
  for (const source of sourceOrder(preferred)) {
    try {
      console.info(`[Streaming] Trying ${source === 'phantom' ? 'Phantom' : 'VideoHUB'}... mediaType=${input.mediaType} tmdbId=${input.tmdbId || 'unknown'}${input.season ? ` season=${input.season}` : ''}${input.episode ? ` episode=${input.episode}` : ''} source=${source}`);
      const result = source === 'phantom' ? { data: await phantom.lookup(input) } : await videohub.lookup(input);
      return { source, ...result, failures };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push(`${source}: ${reason}`);
      console.warn(`[Streaming] ${source === 'phantom' ? 'Phantom' : 'VideoHUB'} failed: ${reason}; mediaType=${input.mediaType} tmdbId=${input.tmdbId || 'unknown'}${input.season ? ` season=${input.season}` : ''}${input.episode ? ` episode=${input.episode}` : ''} source=${source}`);
      if (source === 'phantom') console.info('[Streaming] Falling back to VideoHUB...');
    }
  }
  const error = new Error('No online stream source is available'); error.failures = failures; throw error;
}

function onlineResult(source, data, input, kind) {
  if (kind === 'check') {
    if (input.mediaType === 'movie') return { available: phantom.normalizeVoices(data).length > 0, type: 'movie', voices: phantom.normalizeVoices(data) };
    return { available: phantom.normalizeSeasons(data).length > 0, type: 'series', seasons: phantom.normalizeSeasons(data) };
  }
  if (kind === 'voices') return { available: phantom.normalizeVoices(data).length > 0, season: input.season, voices: phantom.normalizeVoices(data) };
  return { available: phantom.normalizeEpisodes(data).length > 0, season: input.season, translationId: input.translationId, episodes: phantom.normalizeEpisodes(data) };
}

function episodeAvailability(data, season) {
  const episodes = phantom.normalizeEpisodes(data);
  const seasons = [...new Set([...phantom.normalizeSeasons(data), ...episodes.map((item) => item.season)])].sort((a, b) => a - b);
  return { seasons, episodes: episodes.filter((item) => item.season === Number(season)).map((item) => item.episode).sort((a, b) => a - b) };
}

async function resolveOnline(input, kind, preferred) {
  const failures = [];
  for (const source of sourceOrder(preferred)) {
    try {
      const result = await lookupOnline(input, source);
      const normalized = onlineResult(result.source, result.data, input, kind);
      if (normalized.available) return { source: result.source, ...normalized };
      failures.push(`${result.source}: no ${kind}`);
      console.warn(`[Streaming] ${result.source === 'phantom' ? 'Phantom' : 'VideoHUB'} failed: no ${kind}`);
      // lookupOnline may have succeeded while the requested season/translation
      // is absent.  Do not mistake that for a playable source.
      if (result.source === 'phantom') console.info('[Streaming] Falling back to VideoHUB...');
    } catch (err) { failures.push(...(err.failures || [err.message])); }
  }
  const error = new Error('No matching online source'); error.failures = failures; throw error;
}

// A successful metadata lookup does not guarantee that the provider can
// serve its actual HLS media. Verify the first byte before returning a player
// URL so a 503 can trigger the normal provider fallback instead of causing
// hls.js to reconnect forever in the browser.
async function assertOnlineStream(adapter, streamUrl, source) {
  const target = adapter.lampacStreamUrl(streamUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(target, { headers: { Range: 'bytes=0-1' }, signal: controller.signal });
    if (!response.ok) {
      if (STREAMING_DIAGNOSTICS) console.warn(`[Streaming] ${source} stream probe status=${response.status} path=${target.pathname}`);
      throw new Error(`${source} stream HTTP ${response.status}`);
    }
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`${source} stream probe timed out`);
    throw err;
  } finally { clearTimeout(timeout); }
}

function phantomProgressInput(source) {
  const tmdbId = Number(source.tmdbId ?? source.tmdb_id);
  const mediaType = source.mediaType ?? source.media_type;
  const season = source.season === undefined || source.season === null || source.season === '' ? null : optionalPositive(source.season);
  const episode = source.episode === undefined || source.episode === null || source.episode === '' ? null : optionalPositive(source.episode);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0 || !['movie', 'tv'].includes(mediaType)) throw new Error('Некорректный медиаресурс');
  if ((mediaType === 'movie' && (season !== null || episode !== null)) || (mediaType === 'tv' && (!season || !episode))) {
    throw new Error('Некорректные сезон или серия');
  }
  return { tmdbId, mediaType, season, episode, storageSeason: season || 0, storageEpisode: episode || 0 };
}

function phantomProgressResponse(row) {
  return {
    position: Number(row.position_seconds), duration: Number(row.duration_seconds),
    updatedAt: row.updated_at, revision: Number(row.revision), completed: Boolean(row.completed_at), translationId: row.translation_id || null,
  };
}

// Phantom's source of truth.  Jellyfin has an independent UserData/lifecycle
// mechanism and deliberately does not use this endpoint.
router.get('/progress/continue', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT tmdb_id, media_type, season, episode, position_seconds, duration_seconds, translation_id, updated_at
         FROM phantom_watch_positions
        WHERE user_id = $1
          AND completed_at IS NULL
          AND position_seconds > 5
          AND (duration_seconds = 0 OR position_seconds < duration_seconds * 0.95)
        ORDER BY updated_at DESC
        LIMIT 20`,
      [req.user.id]
    );
    res.json({ items: rows.map((row) => ({
      tmdbId: Number(row.tmdb_id), mediaType: row.media_type,
      season: row.media_type === 'tv' ? Number(row.season) : null,
      episode: row.media_type === 'tv' ? Number(row.episode) : null,
      position: Number(row.position_seconds), duration: Number(row.duration_seconds), translationId: row.translation_id || null, updatedAt: row.updated_at,
    })) });
  } catch (err) {
    console.error('[Phantom] continue progress read:', err.message);
    res.status(500).json({ error: 'Не удалось получить список продолжения просмотра' });
  }
});

router.delete('/progress', async (req, res) => {
  let input;
  try { input = phantomProgressInput(req.query); } catch (err) { return res.status(400).json({ error: err.message }); }
  try {
    await db.query(
      `DELETE FROM phantom_watch_positions
        WHERE user_id = $1 AND tmdb_id = $2 AND media_type = $3 AND season = $4 AND episode = $5`,
      [req.user.id, input.tmdbId, input.mediaType, input.storageSeason, input.storageEpisode]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[Phantom] progress delete:', err.message);
    res.status(500).json({ error: 'Не удалось удалить прогресс просмотра' });
  }
});

router.get('/progress', async (req, res) => {
  let input;
  try { input = phantomProgressInput(req.query); } catch (err) { return res.status(400).json({ error: err.message }); }
  try {
    const { rows } = await db.query(
      `SELECT position_seconds, duration_seconds, completed_at, revision, updated_at, translation_id
         FROM phantom_watch_positions
        WHERE user_id = $1 AND tmdb_id = $2 AND media_type = $3
          AND season = $4 AND episode = $5`,
      [req.user.id, input.tmdbId, input.mediaType, input.storageSeason, input.storageEpisode]
    );
    if (!rows[0]) return res.json({ position: 0, duration: 0, updatedAt: null, revision: 0, completed: false });
    res.json(phantomProgressResponse(rows[0]));
  } catch (err) {
    console.error('[Phantom] progress read:', err.message);
    res.status(500).json({ error: 'Не удалось получить прогресс просмотра' });
  }
});

router.put('/progress', async (req, res) => {
  let input;
  try { input = phantomProgressInput(req.body || {}); } catch (err) { return res.status(400).json({ error: err.message }); }
  const position = Number(req.body.position);
  const duration = Number(req.body.duration);
  const baseRevision = Number(req.body.baseRevision);
  const translationId = req.body.translationId === undefined || req.body.translationId === null ? null : String(req.body.translationId).trim().slice(0, 100);
  if (!Number.isFinite(position) || !Number.isFinite(duration) || position < 0 || duration < 0 || position > 7 * 24 * 60 * 60 || duration > 7 * 24 * 60 * 60
    || (duration > 0 && position > duration + 5) || !Number.isSafeInteger(baseRevision) || baseRevision < 0 || (translationId !== null && !translationId)) {
    return res.status(400).json({ error: 'Некорректные данные прогресса' });
  }
  // A small tail margin avoids offering "continue" after the credits.  The
  // row remains as a completion tombstone so a stale device cannot revive it.
  const completed = duration > 0 && position >= duration * 0.95;
  const storedPosition = completed ? 0 : position;
  try {
    const { rows } = await db.query(
      `INSERT INTO phantom_watch_positions
         (user_id, tmdb_id, media_type, season, episode, position_seconds, duration_seconds, completed_at, translation_id, revision, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8 THEN CURRENT_TIMESTAMP ELSE NULL END, $9, 1, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id, tmdb_id, media_type, season, episode) DO UPDATE
         SET position_seconds = EXCLUDED.position_seconds,
             duration_seconds = EXCLUDED.duration_seconds,
             completed_at = EXCLUDED.completed_at,
             translation_id = COALESCE(EXCLUDED.translation_id, phantom_watch_positions.translation_id),
             revision = phantom_watch_positions.revision + 1,
             updated_at = CURRENT_TIMESTAMP
       WHERE phantom_watch_positions.revision = $10
       RETURNING position_seconds, duration_seconds, completed_at, revision, updated_at, translation_id`,
      [req.user.id, input.tmdbId, input.mediaType, input.storageSeason, input.storageEpisode, storedPosition, duration, completed, translationId, baseRevision]
    );
    if (rows[0]) return res.json(phantomProgressResponse(rows[0]));
    const latest = await db.query(
      `SELECT position_seconds, duration_seconds, completed_at, revision, updated_at, translation_id FROM phantom_watch_positions
        WHERE user_id = $1 AND tmdb_id = $2 AND media_type = $3
          AND season = $4 AND episode = $5`,
      [req.user.id, input.tmdbId, input.mediaType, input.storageSeason, input.storageEpisode]
    );
    return res.status(409).json({ error: 'Прогресс уже обновлён на другом устройстве', progress: latest.rows[0] ? phantomProgressResponse(latest.rows[0]) : null });
  } catch (err) {
    console.error('[Phantom] progress write:', err.message);
    res.status(500).json({ error: 'Не удалось сохранить прогресс просмотра' });
  }
});

// Phantom is independent from Jellyfin: failures are returned as a normal
// unavailable source and cannot break DetailPage or the local library.
router.get('/phantom/check', async (req, res) => {
  let input;
  try { input = phantomInput(req); } catch (err) { return res.status(400).json({ error: err.message }); }
  try {
    return res.json(await resolveOnline(input, 'check', await preferredOnlineSource(req)));
  } catch (err) {
    console.warn('[Streaming] online lookup unavailable:', err.failures || err.message);
    return res.json({ available: false, unavailable: true, source: await preferredOnlineSource(req).catch(() => 'phantom') });
  }
});

router.get('/phantom/voices', async (req, res) => {
  let input;
  try { input = phantomInput(req); } catch (err) { return res.status(400).json({ error: err.message }); }
  const season = optionalPositive(req.query.season);
  if (input.mediaType !== 'tv' || !season) return res.status(400).json({ error: 'Нужен корректный сезон сериала' });
  try {
    res.json(await resolveOnline({ ...input, season }, 'voices', await preferredOnlineSource(req, req.query.source)));
  } catch (err) { console.warn('[Streaming] voices unavailable:', err.failures || err.message); res.status(502).json({ error: 'Phantom и VideoHUB временно недоступны' }); }
});

router.get('/phantom/episodes', async (req, res) => {
  let input;
  try { input = phantomInput(req); } catch (err) { return res.status(400).json({ error: err.message }); }
  const season = optionalPositive(req.query.season);
  const translationId = String(req.query.translation_id || '').slice(0, 100);
  if (input.mediaType !== 'tv' || !season || !translationId) return res.status(400).json({ error: 'Нужны сезон и озвучка' });
  try {
    res.json(await resolveOnline({ ...input, season, translationId }, 'episodes', await preferredOnlineSource(req, req.query.source)));
  } catch (err) { console.warn('[Streaming] episodes unavailable:', err.failures || err.message); res.status(502).json({ error: 'Phantom и VideoHUB временно недоступны' }); }
});

router.post('/phantom/playback', async (req, res) => {
  let input;
  try { input = phantomInput(req); } catch (err) { return res.status(400).json({ error: err.message }); }
  const season = optionalPositive(req.body.season);
  const translationId = req.body.translation_id === undefined ? undefined : String(req.body.translation_id).slice(0, 100);
  const episode = optionalPositive(req.body.episode);
  if (input.mediaType === 'tv' && (!season || !translationId || !episode)) return res.status(400).json({ error: 'Для сериала нужны сезон, озвучка и серия' });
  try {
    const playbackInput = { ...input, season, translationId, episode };
    const failures = [];
    for (const source of sourceOrder(await preferredOnlineSource(req, req.body.source))) {
      try {
        const result = source === 'phantom' ? { data: await phantom.lookup(playbackInput) } : await videohub.lookup(playbackInput);
        // Episode matching is exact; if a fallback provider does not expose
        // the previous provider's translation ID, use its selected/default
        // voice but never its first episode.
        const stream = phantom.findStream(result.data, { translationId, season, episode })
          || phantom.findStream(result.data, { season, episode });
        if (!stream) {
          if (input.mediaType === 'tv') {
            const available = episodeAvailability(result.data, season);
            console.warn(`[Phantom] episode stream not found tmdbId=${input.tmdbId || 'unknown'} season=${season} episode=${episode} translationId=${translationId || '-'} available seasons=${available.seasons.join(',') || '-'} available episodes=${available.episodes.join(',') || '-'}`);
          }
          throw new Error(input.mediaType === 'tv' ? `stream S${season}E${episode} not found` : 'no stream');
        }
        const adapter = source === 'phantom' ? phantom : videohub;
        await assertOnlineStream(adapter, stream.stream, source === 'phantom' ? 'Phantom' : 'VideoHUB');
        const reference = adapter.createReference(req.user.id, adapter.lampacStreamUrl(stream.stream).toString());
        console.info(`[Streaming] ${source === 'phantom' ? 'Phantom' : 'VideoHUB'} stream found mediaType=${input.mediaType} tmdbId=${input.tmdbId || 'unknown'}${season ? ` season=${season} episode=${episode}` : ''} source=${source}`);
        return res.json({ url: `/api/streaming/${source}/hls/${reference}`, type: 'm3u8', source, stream: true, season: season || null, episode: episode || null, translation: translationId || null });
      } catch (err) {
        failures.push(`${source}: ${err.message}`);
        console.warn(`[Streaming] ${source === 'phantom' ? 'Phantom' : 'VideoHUB'} failed: ${err.message}`);
        if (source === 'phantom') console.info('[Streaming] Falling back to VideoHUB...');
      }
    }
    console.warn('[Streaming] all playback sources failed:', failures);
    res.status(502).json({ error: 'Phantom и VideoHUB недоступны: не удалось запустить онлайн-воспроизведение' });
  } catch (err) { console.warn('[Streaming] playback unavailable:', err.message); res.status(502).json({ error: 'Phantom и VideoHUB недоступны: не удалось запустить онлайн-воспроизведение' }); }
});

router.get('/phantom/hls/:reference', async (req, res) => {
  const upstreamUrl = phantom.getReference(req.user.id, req.params.reference);
  if (!upstreamUrl) return res.status(404).json({ error: 'Ссылка на поток истекла' });
  const controller = new AbortController();
  let complete = false;
  const abort = () => { if (!complete && !controller.signal.aborted) controller.abort(); };
  req.once('aborted', abort); res.once('close', abort);
  try {
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    const upstream = await fetch(upstreamUrl, { headers, signal: controller.signal });
    res.status(upstream.status);
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'etag', 'last-modified']) {
      const value = upstream.headers.get(name); if (value) res.setHeader(name, value);
    }
    const contentType = upstream.headers.get('content-type') || '';
    const isManifest = /mpegurl/i.test(contentType) || /\.m3u8$/i.test(upstreamUrl.pathname);
    if (isManifest) {
      const manifest = await upstream.text(); complete = true;
      if (!upstream.ok) return res.status(upstream.status).json({ error: 'Онлайн playlist недоступен' });
      res.removeHeader('content-length');
      return res.type('application/vnd.apple.mpegurl').send(phantom.rewriteManifest(manifest, upstreamUrl, req.user.id));
    }
    if (!upstream.body) { complete = true; return res.end(); }
    const media = Readable.fromWeb(upstream.body);
    media.on('error', (err) => { if (err.name !== 'AbortError') console.warn('[Phantom] HLS upstream error:', err.message); if (!res.headersSent) res.status(502); res.end(); });
    media.on('end', () => { complete = true; });
    res.once('close', () => { if (!complete) media.destroy(); });
    media.pipe(res);
  } catch (err) {
    if (err.name !== 'AbortError') console.warn('[Phantom] HLS proxy error:', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Онлайн-поток временно недоступен' });
  }
});

// VideoHUB has the same HLS lifecycle as Phantom, but retains its own opaque
// reference store and manifest allow-list so a URL from one provider cannot be
// replayed through the other provider's proxy.
router.get('/videohub/hls/:reference', async (req, res) => {
  const upstreamUrl = videohub.getReference(req.user.id, req.params.reference);
  if (!upstreamUrl) return res.status(404).json({ error: 'Ссылка на поток истекла' });
  const controller = new AbortController(); let complete = false;
  const abort = () => { if (!complete && !controller.signal.aborted) controller.abort(); };
  req.once('aborted', abort); res.once('close', abort);
  try {
    if (STREAMING_DIAGNOSTICS) console.info(`[VideoHUB HLS] request path=${upstreamUrl.pathname} range=${req.headers.range || 'none'}`);
    const headers = {}; if (req.headers.range) headers.Range = req.headers.range;
    const upstream = await fetch(upstreamUrl, { headers, signal: controller.signal });
    if (STREAMING_DIAGNOSTICS) console.info(`[VideoHUB HLS] response status=${upstream.status} sourcePath=${upstreamUrl.pathname}`);
    res.status(upstream.status);
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'etag', 'last-modified']) { const value = upstream.headers.get(name); if (value) res.setHeader(name, value); }
    const contentType = upstream.headers.get('content-type') || '';
    if (/mpegurl/i.test(contentType) || /\.m3u8$/i.test(upstreamUrl.pathname)) {
      const manifest = await upstream.text(); complete = true;
      if (!upstream.ok) return res.status(upstream.status).json({ error: 'Онлайн playlist недоступен' });
      res.removeHeader('content-length');
      const manifestUrl = new URL(upstream.url || upstreamUrl.toString());
      if (STREAMING_DIAGNOSTICS) console.info(`[VideoHUB HLS] manifest path=${manifestUrl.pathname} lines=${manifest.split(/\r?\n/).filter(Boolean).length}`);
      return res.type('application/vnd.apple.mpegurl').send(videohub.rewriteManifest(manifest, manifestUrl, req.user.id));
    }
    if (!upstream.body) { complete = true; return res.end(); }
    const media = Readable.fromWeb(upstream.body);
    media.on('error', (err) => { if (err.name !== 'AbortError') console.warn(`[VideoHUB HLS] upstream error path=${upstreamUrl.pathname}:`, err.message); if (!res.headersSent) res.status(502); res.end(); });
    media.on('end', () => { complete = true; }); res.once('close', () => { if (!complete) media.destroy(); }); media.pipe(res);
  } catch (err) {
    if (err.name !== 'AbortError') console.warn(`[VideoHUB HLS] proxy error path=${upstreamUrl.pathname}:`, err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Онлайн-поток временно недоступен' });
  }
});

router.get('/jellyfin/series/:seriesId/seasons', requireJellyfinAccess, async (req, res) => {
  const tmdbId = Number(req.query.tmdb_id);
  if (!validJellyfinItemId(req.params.seriesId) || !Number.isInteger(tmdbId) || tmdbId <= 0) {
    return res.status(400).json({ error: 'Некорректный Series ItemId' });
  }
  try {
    await jellyfin.assertSeries(req.params.seriesId, tmdbId);
    res.json({ seasons: await jellyfin.getSeasons(req.params.seriesId) });
  } catch (err) {
    console.error('[Jellyfin] Сезоны:', err.message);
    res.status(502).json({ error: 'Не удалось получить сезоны из Jellyfin' });
  }
});

// Flat, sorted list used only to choose the next real episode. PlaybackInfo is
// deliberately not requested here, so no HLS/transcoding session is started.
router.get('/jellyfin/series/:seriesId/episodes', requireJellyfinAccess, async (req, res) => {
  const tmdbId = Number(req.query.tmdb_id);
  if (!validJellyfinItemId(req.params.seriesId) || !Number.isInteger(tmdbId) || tmdbId <= 0) {
    return res.status(400).json({ error: 'Некорректный Series ItemId' });
  }
  try {
    await jellyfin.assertSeries(req.params.seriesId, tmdbId);
    res.json({ episodes: await jellyfin.getSeriesEpisodes(req.params.seriesId) });
  } catch (err) {
    console.error('[Jellyfin] Список эпизодов:', err.message);
    res.status(502).json({ error: 'Не удалось получить эпизоды из Jellyfin' });
  }
});

router.get('/jellyfin/series/:seriesId/seasons/:seasonId/episodes', requireJellyfinAccess, async (req, res) => {
  const tmdbId = Number(req.query.tmdb_id);
  if (!validJellyfinItemId(req.params.seriesId) || !validJellyfinItemId(req.params.seasonId)
    || !Number.isInteger(tmdbId) || tmdbId <= 0) {
    return res.status(400).json({ error: 'Некорректный Season ItemId' });
  }
  try {
    await jellyfin.assertSeries(req.params.seriesId, tmdbId);
    const season = await jellyfin.getItem(req.params.seasonId);
    if (season.Type !== 'Season' || (season.SeriesId || season.ParentId) !== req.params.seriesId) {
      return res.status(403).json({ error: 'Сезон не относится к выбранному сериалу' });
    }
    const episodes = await jellyfin.getSeasonEpisodes(req.params.seriesId, req.params.seasonId);
    res.json({ episodes });
  } catch (err) {
    console.error('[Jellyfin] Эпизоды:', err.message);
    res.status(502).json({ error: 'Не удалось получить эпизоды из Jellyfin' });
  }
});

/**
 * Resolve a saved KinoLike link to a Jellyfin movie/episode. For series the
 * episode list is returned as well, so changing an episode creates a fresh
 * PlaybackInfo/HLS session instead of reusing the old one.
 */
router.get('/jellyfin/resolve/:type/:tmdbId', requireJellyfinAccess, async (req, res) => {
  try {
    const { type, tmdbId } = req.params;
    const { rows } = await db.query(
      'SELECT title FROM streaming_links WHERE user_id = $1 AND tmdb_id = $2 AND media_type = $3',
      [req.user.id, parseInt(tmdbId), type]
    );
    if (!rows.length) return res.status(404).json({ error: 'Источник не найден' });
    const found = await jellyfin.searchItem(rows[0].title, type);
    if (!found) return res.status(404).json({ error: 'Элемент ещё не найден в Jellyfin' });
    const episodes = type === 'tv' ? await jellyfin.getEpisodes(found.itemId) : [];
    res.json({
      itemId: found.playbackItemId || found.itemId,
      seriesId: type === 'tv' ? found.itemId : null,
      title: found.itemName,
      episodes,
    });
  } catch (err) {
    console.error('[Jellyfin] Ошибка разрешения источника:', err.message);
    res.status(502).json({ error: err.message });
  }
});

/**
 * Negotiate Direct Play / Direct Stream / transcoding through PlaybackInfo.
 * The response only contains KinoLike proxy URLs; the Jellyfin API key and
 * upstream address stay server-side.
 */
router.post('/jellyfin/playback/:itemId', requireJellyfinAccess, async (req, res) => {
  try {
    const deviceId = String(req.body.deviceId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
    const clientSessionId = String(req.body.clientSessionId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
    if (!deviceId) return res.status(400).json({ error: 'deviceId обязателен' });
    if (!clientSessionId) return res.status(400).json({ error: 'clientSessionId обязателен' });
    const tmdbId = Number(req.body.tmdbId);
    const mediaType = req.body.mediaType;
    const startTimeTicks = req.body.startTimeTicks === undefined ? 0 : Number(req.body.startTimeTicks);
    if (!validJellyfinItemId(req.params.itemId) || !Number.isInteger(tmdbId) || tmdbId <= 0 || !['movie', 'tv'].includes(mediaType)
      || !Number.isSafeInteger(startTimeTicks) || startTimeTicks < 0 || startTimeTicks > 7 * 24 * 60 * 60 * 10_000_000) {
      return res.status(400).json({ error: 'Некорректный медиаресурс' });
    }
    await jellyfin.validatePlaybackItem(req.params.itemId, tmdbId, mediaType);
    const result = await jellyfin.getPlaybackInfo(req.params.itemId, {
      ...req.body,
      deviceId,
      startTimeTicks,
      audioStreamIndex: Number.isInteger(req.body.audioStreamIndex) ? req.body.audioStreamIndex : undefined,
      subtitleStreamIndex: Number.isInteger(req.body.subtitleStreamIndex) ? req.body.subtitleStreamIndex : -1,
    });
    await playbackLifecycle.registerSession({
      userId: req.user.id, clientSessionId, itemId: req.params.itemId,
      tmdbId, mediaType, deviceId, playback: result,
    });
    res.json({
      ...result,
      upstreamPath: undefined,
      subtitlePath: undefined,
      url: jellyfinProxyUrl(result.upstreamPath),
      subtitleUrl: result.subtitlePath ? jellyfinProxyUrl(result.subtitlePath) : null,
    });
  } catch (err) {
    console.error('[Jellyfin] PlaybackInfo:', err.message);
    res.status(/DeviceProfile|deviceId/.test(err.message) ? 400 : 502).json({ error: err.message });
  }
});

function playbackRequest(req, res) {
  const playSessionId = String(req.body.playSessionId || '');
  const clientSessionId = String(req.body.clientSessionId || '');
  const position = req.body.position === undefined ? 0 : Number(req.body.position);
  const duration = req.body.duration === undefined ? 0 : Number(req.body.duration);
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(playSessionId) || !/^[a-zA-Z0-9_-]{8,80}$/.test(clientSessionId)
    || !Number.isFinite(position) || !Number.isFinite(duration) || position < 0 || duration < 0
    || position > 7 * 24 * 60 * 60 || duration > 7 * 24 * 60 * 60) {
    res.status(400).json({ error: 'Некорректные данные playback session' });
    return null;
  }
  return { playSessionId, clientSessionId, position, duration };
}

router.post('/jellyfin/session/start', requireJellyfinAccess, async (req, res) => {
  const data = playbackRequest(req, res);
  if (!data) return;
  try {
    const session = await playbackLifecycle.startSession(req.user.id, data.clientSessionId, data.playSessionId, data.position);
    if (!session) return res.status(404).json({ error: 'Playback session не найдена' });
    res.json({ ok: true, state: session.state === 'prepared' ? 'playing' : session.state });
  } catch (err) {
    console.error('[Playback] START failed:', err.message);
    res.status(502).json({ error: 'Jellyfin не принял событие запуска' });
  }
});

router.post('/jellyfin/session/progress', requireJellyfinAccess, async (req, res) => {
  const data = playbackRequest(req, res);
  if (!data) return;
  try {
    const session = await playbackLifecycle.progressSession(req.user.id, data.clientSessionId, data.playSessionId, {
      positionSeconds: data.position, durationSeconds: data.duration, isPaused: req.body.isPaused === true,
    });
    if (!session) return res.status(404).json({ error: 'Активная playback session не найдена' });
    res.json({ ok: true, state: session.state });
  } catch (err) {
    console.error('[Playback] PROGRESS failed:', err.message);
    res.status(502).json({ error: 'Jellyfin не принял playback progress' });
  }
});

router.post('/jellyfin/session/stop', requireJellyfinAccess, async (req, res) => {
  const data = playbackRequest(req, res);
  if (!data) return;
  try {
    const result = await playbackLifecycle.stopSession(req.user.id, data.clientSessionId, data.playSessionId, {
      positionSeconds: data.position, durationSeconds: data.duration, reason: req.body.reason,
    });
    if (!result) return res.status(404).json({ error: 'Playback session не найдена' });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[Playback] STOP failed:', err.message);
    res.status(502).json({ error: 'Jellyfin не принял событие остановки' });
  }
});

function validJellyfinItemId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{8,128}$/.test(value);
}

// Jellyfin UserData is the source of truth for resume. Episodes use their
// individual Jellyfin ItemIds, so their positions cannot be mixed.
router.get('/jellyfin/progress/:itemId', requireJellyfinAccess, async (req, res) => {
  if (!validJellyfinItemId(req.params.itemId)) return res.status(400).json({ error: 'Некорректный ItemId' });
  try {
    const positionTicks = await jellyfin.getPlaybackPosition(req.params.itemId);
    console.info(`[Playback Resume]\nItemId: ${req.params.itemId}\nPlaybackPositionTicks: ${positionTicks}\nSeconds: ${(positionTicks / 10_000_000).toFixed(1)}`);
    res.json({ position: positionTicks / 10_000_000, duration: 0, positionTicks });
  } catch (err) {
    console.error('[Jellyfin] Ошибка чтения PlaybackPositionTicks:', err.message);
    res.status(500).json({ error: 'Не удалось получить позицию просмотра' });
  }
});

/**
 * Authenticated same-origin media proxy. This is also used for HLS child
 * playlists, segments and external VTT subtitles.
 */
router.get('/jellyfin/proxy', requireJellyfinAccess, async (req, res) => {
  const controller = new AbortController();
  let upstreamFinished = false;
  const abortUpstream = () => {
    if (upstreamFinished || controller.signal.aborted) return;
    controller.abort();
    if (process.env.PLAYBACK_DEBUG === 'true') console.info('[Playback] Browser → Jellyfin proxy connection closed; upstream aborted');
  };
  req.once('aborted', abortUpstream);
  res.once('close', abortUpstream);
  try {
    if (typeof req.query.path !== 'string') return res.status(400).json({ error: 'path обязателен' });
    const upstreamUrl = jellyfin.resolveUpstreamPath(req.query.path);
    // The proxy carries a server API key, so it must never become a generic
    // tunnel to administrative Jellyfin endpoints.
    if (!/^\/videos\//i.test(upstreamUrl.pathname)) {
      return res.status(403).json({ error: 'Разрешены только медиаресурсы Jellyfin' });
    }
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    if (process.env.PLAYBACK_DEBUG === 'true') {
      console.info(`[Playback][Range]\nPath: ${upstreamUrl.pathname}\nRange: ${req.headers.range || 'none'}`);
    }
    const upstream = await jellyfin.jellyfinFetch(upstreamUrl.toString(), { headers, signal: controller.signal });
    res.status(upstream.status);
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'etag', 'last-modified']) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    const contentType = upstream.headers.get('content-type') || '';
    const isManifest = /mpegurl/i.test(contentType) || /\.m3u8$/i.test(upstreamUrl.pathname);
    if (isManifest) {
      console.info(`[Jellyfin Proxy] HLS playlist ${upstream.status}`);
      const manifest = await upstream.text();
      upstreamFinished = true;
      res.removeHeader('content-length');
      res.type('application/vnd.apple.mpegurl').send(rewriteHlsManifest(manifest, upstreamUrl));
      return;
    }
    if (!upstream.body) return res.end();
    // `fetch` returns a Web ReadableStream, while Express expects a Node
    // stream. HLS media segments used to fail here before reaching Safari/
    // Firefox, which surfaced as a browser "failed to decode" error.
    const mediaStream = Readable.fromWeb(upstream.body);
    mediaStream.on('error', (error) => {
      if (error.name !== 'AbortError') console.error('[Jellyfin] Ошибка media proxy:', error.message);
      if (!res.headersSent) res.status(502);
      res.end();
    });
    mediaStream.on('end', () => { upstreamFinished = true; });
    res.once('close', () => { if (!upstreamFinished) mediaStream.destroy(); });
    mediaStream.pipe(res);
  } catch (err) {
    if (err.name !== 'AbortError') console.error('[Jellyfin] Media proxy:', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Jellyfin media proxy недоступен' });
  }
});

/**
 * DELETE /api/streaming/link/:type/:tmdbId
 */
router.delete('/link/:type/:tmdbId', async (req, res) => {
  try {
    const { type, tmdbId } = req.params;
    await db.query(
      'DELETE FROM streaming_links WHERE user_id = $1 AND tmdb_id = $2 AND media_type = $3',
      [req.user.id, parseInt(tmdbId), type]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[Streaming] Ошибка удаления ссылки:', err.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
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
router.post('/refresh-jellyfin/:type/:tmdbId', requireJellyfinAccess, async (req, res) => {
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
