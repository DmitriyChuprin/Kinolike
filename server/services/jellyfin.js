// Jellyfin API — поиск фильмов/сериалов и получение ссылок
const JELLYFIN_URL = process.env.JELLYFIN_URL || '';
const JELLYFIN_PORT = process.env.JELLYFIN_PORT || '';
const JELLYFIN_API_KEY = process.env.JELLYFIN_API_KEY || '';

function getBaseUrl() {
  if (!JELLYFIN_URL) throw new Error('Jellyfin не настроен (JELLYFIN_URL)');
  let base = JELLYFIN_URL.startsWith('http') ? JELLYFIN_URL : `http://${JELLYFIN_URL}`;
  // Remove trailing slash
  base = base.replace(/\/+$/, '');
  // Append port only if specified
  if (JELLYFIN_PORT) base += `:${JELLYFIN_PORT}`;
  return base;
}

/**
 * Поиск фильма/сериала в Jellyfin
 * @param {string} title — название
 * @param {string} mediaType — 'movie' или 'tv'
 * @returns {Object|null} — { itemId, itemName, jellyfinUrl } или null
 */
async function searchItem(title, mediaType) {
  if (!JELLYFIN_API_KEY) {
    console.log('[Jellyfin] API key не задан, пропускаем поиск');
    return null;
  }

  try {
    const base = getBaseUrl();
    
    // Получаем userId
    const usersResp = await fetch(`${base}/Users?api_key=${JELLYFIN_API_KEY}`);
    if (!usersResp.ok) {
      console.error(`[Jellyfin] Ошибка получения пользователей: ${usersResp.status}`);
      return null;
    }
    const users = await usersResp.json();
    if (!users.length) {
      console.error('[Jellyfin] Нет пользователей');
      return null;
    }
    const userId = users[0].Id;

    // Получаем библиотеку
    const libType = mediaType === 'tv' ? 'Сериалы' : 'Фильмы';
    const foldersResp = await fetch(`${base}/Library/VirtualFolders?api_key=${JELLYFIN_API_KEY}`);
    const folders = await foldersResp.json();
    const folder = folders.find(f => f.Name === libType);
    
    if (!folder) {
      console.log(`[Jellyfin] Библиотека "${libType}" не найдена`);
      return null;
    }

    // Получаем все элементы из библиотеки
    const itemsType = mediaType === 'tv' ? 'Series' : 'Movie';
    const itemsUrl = `${base}/Users/${userId}/Items?parentId=${folder.ItemId}&includeItemTypes=${itemsType}&limit=500&api_key=${JELLYFIN_API_KEY}`;
    const itemsResp = await fetch(itemsUrl);
    if (!itemsResp.ok) {
      console.error(`[Jellyfin] Ошибка получения элементов: ${itemsResp.status}`);
      return null;
    }
    const itemsData = await itemsResp.json();
    const items = itemsData.Items || [];

    if (items.length === 0) {
      console.log(`[Jellyfin] Библиотека "${libType}" пуста`);
      return null;
    }

    // Ищем по названию (нечёткое сравнение)
    const titleLower = title.toLowerCase();
    const found = items.find(item => {
      const name = (item.Name || '').toLowerCase();
      return name === titleLower || name.includes(titleLower) || titleLower.includes(name);
    });

    if (!found) {
      console.log(`[Jellyfin] "${title}" не найден в библиотеке "${libType}" (всего элементов: ${items.length})`);
      return null;
    }

    const itemId = found.Id;
    const itemName = found.Name;

    // Формируем ссылку на просмотр в Jellyfin (10.9+ React client: #/details?id=...)
    let jellyfinUrl;
    if (mediaType === 'tv') {
      // Для сериалов — находим первый эпизод для прямого воспроизведения
      try {
        const seasonsResp = await fetch(`${base}/Shows/${itemId}/Seasons?api_key=${JELLYFIN_API_KEY}`);
        const seasons = seasonsResp.ok ? await seasonsResp.json() : { Items: [] };
        const firstSeason = (seasons.Items || [])[0];
        
        if (firstSeason) {
          const epsResp = await fetch(`${base}/Shows/${itemId}/Episodes?seasonId=${firstSeason.Id}&api_key=${JELLYFIN_API_KEY}`);
          const eps = epsResp.ok ? await epsResp.json() : { Items: [] };
          const firstEp = (eps.Items || [])[0];
          
          if (firstEp) {
            jellyfinUrl = `${base}/web/index.html#/details?id=${firstEp.Id}`;
            console.log(`[Jellyfin] Прямая ссылка на эпизод: "${firstEp.Name}"`);
          } else {
            jellyfinUrl = `${base}/web/index.html#/details?id=${itemId}`;
          }
        } else {
          jellyfinUrl = `${base}/web/index.html#/details?id=${itemId}`;
        }
      } catch (e) {
        console.log('[Jellyfin] Не удалось найти эпизод, ссылка на страницу сериала');
        jellyfinUrl = `${base}/web/index.html#/details?id=${itemId}`;
      }
    } else {
      // Для фильмов — страница деталей с кнопкой воспроизведения
      jellyfinUrl = `${base}/web/index.html#/details?id=${itemId}`;
    }

    console.log(`[Jellyfin] Найден: "${itemName}" (ID: ${itemId})`);

    return {
      itemId,
      itemName,
      jellyfinUrl,
    };
  } catch (err) {
    console.error('[Jellyfin] Ошибка поиска:', err.message);
    return null;
  }
}

/**
 * Запросить сканирование библиотеки в Jellyfin
 * POST /Library/Refresh
 */
async function refreshLibrary() {
  if (!JELLYFIN_API_KEY) {
    console.log('[Jellyfin] API key не задан, пропускаем сканирование');
    return false;
  }

  try {
    const base = getBaseUrl();
    const resp = await fetch(`${base}/Library/Refresh?api_key=${JELLYFIN_API_KEY}`, {
      method: 'POST',
    });

    if (resp.ok) {
      console.log('[Jellyfin] Запрос на сканирование библиотеки отправлен');
      return true;
    } else {
      console.error(`[Jellyfin] Ошибка сканирования: ${resp.status}`);
      return false;
    }
  } catch (err) {
    console.error('[Jellyfin] Ошибка сканирования:', err.message);
    return false;
  }
}

/**
 * Проверить доступность Jellyfin
 */
async function checkStatus() {
  try {
    if (!JELLYFIN_URL || !JELLYFIN_API_KEY) return false;
    const base = getBaseUrl();
    const resp = await fetch(`${base}/System/Info?api_key=${JELLYFIN_API_KEY}`);
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Дождаться появления фильма/сериала в Jellyfin после сканирования
 * Повторно ищет элемент с интервалом pollIntervalMs до maxWaitMs
 *
 * @param {string} title — название
 * @param {string} mediaType — 'movie' или 'tv'
 * @param {Object} opts
 * @param {number} opts.maxWaitMs — максимальное время ожидания (мс), по умолчанию 30000
 * @param {number} opts.pollIntervalMs — интервал между попытками (мс), по умолчанию 3000
 * @returns {Object|null} — { itemId, itemName, jellyfinUrl } или null
 */
async function waitForItem(title, mediaType, { maxWaitMs = 30000, pollIntervalMs = 3000 } = {}) {
  const startTime = Date.now();
  let attempt = 0;

  while (Date.now() - startTime < maxWaitMs) {
    attempt++;
    const result = await searchItem(title, mediaType);
    if (result) {
      console.log(`[Jellyfin] Элемент "${title}" найден попыткой ${attempt} (${Date.now() - startTime}ms)`);
      return result;
    }
    console.log(`[Jellyfin] Ожидание "${title}" — попытка ${attempt}, ${Math.round((Date.now() - startTime) / 1000)}s...`);
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  // Последняя попытка
  const finalResult = await searchItem(title, mediaType);
  if (finalResult) {
    console.log(`[Jellyfin] Элемент "${title}" найден на последней попытке`);
  } else {
    console.log(`[Jellyfin] Элемент "${title}" не найден за ${maxWaitMs / 1000}с`);
  }
  return finalResult;
}

module.exports = { searchItem, refreshLibrary, checkStatus, waitForItem };
