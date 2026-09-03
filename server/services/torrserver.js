// TorrServer API — управление торрентами и стриминг
const TORRSERVER_URL = process.env.TORRSERVER_URL || '';
const TORRSERVER_PORT = process.env.TORRSERVER_PORT || '8091';
const TORRSERVER_USERNAME = process.env.TORRSERVER_USERNAME || '';
const TORRSERVER_PASSWORD = process.env.TORRSERVER_PASSWORD || '';

function getBaseUrl() {
  if (!TORRSERVER_URL) throw new Error('TorrServer не настроен');
  const base = TORRSERVER_URL.startsWith('http') ? TORRSERVER_URL : `http://${TORRSERVER_URL}`;
  return `${base}:${TORRSERVER_PORT}`;
}

function getAuthHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (TORRSERVER_USERNAME && TORRSERVER_PASSWORD) {
    const token = Buffer.from(`${TORRSERVER_USERNAME}:${TORRSERVER_PASSWORD}`).toString('base64');
    headers['Authorization'] = `Basic ${token}`;
  }
  return headers;
}

/**
 * Вычислить info_hash из magnet-ссылки
 */
function extractHashFromMagnet(magnetUri) {
  const match = magnetUri.match(/btih:([a-fA-F0-9]{40})/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * POST-запрос к TorrServer
 */
async function tsPost(path, body) {
  const base = getBaseUrl();
  const resp = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  return { status: resp.status, text };
}

/**
 * Добавить торрент в TorrServer (API: POST /torrents)
 * Формат по Swagger: {action:"add", link, title, poster, save_to_db}
 */
async function addTorrent(magnetOrLink, title, poster = '') {
  const hash = magnetOrLink.startsWith('magnet:')
    ? extractHashFromMagnet(magnetOrLink)
    : null;

  if (!hash) {
    throw new Error('Не удалось извлечь info_hash из ссылки');
  }

  console.log(`[TorrServer] Adding: hash=${hash}, title="${title}"`);

  const { status, text } = await tsPost('/torrents', {
    action: 'add',
    link: magnetOrLink,
    title: title,
    ...(poster ? { poster } : {}),
    save_to_db: true,
  });

  console.log(`[TorrServer] add response: ${status} ${text.substring(0, 200)}`);

  if (status !== 200) {
    throw new Error(`TorrServer: ${status} — ${text}`);
  }

  // TorrServer может вернуть массив torrent details или OK
  return { hash, title };
}

/**
 * Получить информацию о торренте
 */
async function getTorrentInfo(hash) {
  const { status, text } = await tsPost('/torrents', { action: 'get', hash });
  if (status !== 200) throw new Error(`TorrServer: ${status}`);
  return JSON.parse(text);
}

/**
 * URL для стриминга
 */
function getStreamUrl(hash, fileIndex = 0) {
  return `${getBaseUrl()}/stream?link=${hash}&index=${fileIndex}&play`;
}

/**
 * URL плейлиста
 */
function getPlaylistUrl(hash, fileIndex = 0) {
  return `${getBaseUrl()}/playlist?link=${hash}&index=${fileIndex}`;
}

/**
 * Получить список файлов торрента
 * TorrServer возвращает data как JSON-строку с вложением TorrServer.Files
 * Поля: id, path, length
 * Если stat=1 ("getting info") — метаданные ещё скачиваются, файлов нет
 */
async function getTorrentFiles(hash) {
  const { status, text } = await tsPost('/torrents', { action: 'get', hash });
  if (status !== 200) throw new Error(`TorrServer: ${status}`);
  console.log(`[TorrServer] getTorrentFiles raw (first 1000): ${text.substring(0, 1000)}`);
  const raw = JSON.parse(text);
  const torrent = Array.isArray(raw) ? raw[0] : raw;

  // Проверяем статус торрента
  if (torrent?.stat === 1 || torrent?.stat_string === 'Torrent getting info') {
    console.log(`[TorrServer] Torrent still getting info, retrying...`);
    throw new Error('Metadata still downloading');
  }

  // TorrServer оборачивает файлы в data → JSON-строка → TorrServer.Files
  if (torrent?.data) {
    try {
      const inner = JSON.parse(torrent.data);
      console.log(`[TorrServer] inner keys: ${Object.keys(inner)}`);
      const files = inner?.TorrServer?.Files || inner?.Files || [];
      console.log(`[TorrServer] files count: ${files.length}, first: ${JSON.stringify(files[0])}`);
      // Нормализуем имена полей: id→Id, path→Name, length→Length
      return files.map(f => ({
        Id: f.id,
        Name: f.path || f.name || '',
        Length: f.length,
      }));
    } catch (e) {
      console.error('[TorrServer] Ошибка парсинга data:', e.message);
    }
  }

  // Fallback: прямой формат (Files на верхнем уровне)
  if (torrent?.Files) {
    console.log(`[TorrServer] Using fallback torrent.Files, count: ${torrent.Files.length}`);
    return torrent.Files;
  }

  console.log(`[TorrServer] No files found. torrent keys: ${Object.keys(torrent || {})}, hasData: ${!!torrent?.data}`);
  return [];
}

/**
 * Проверить доступность TorrServer
 */
async function checkStatus() {
  try {
    const { status } = await tsPost('/torrents', { action: 'list' });
    return status === 200;
  } catch {
    return false;
  }
}

module.exports = { addTorrent, getTorrentInfo, getTorrentFiles, getStreamUrl, getPlaylistUrl, checkStatus };
