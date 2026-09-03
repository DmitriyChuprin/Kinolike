// Jackett API — поиск торрентов (с fallback через http модуль)
const http = require('http');
const dns = require('dns');
const JACKETT_URL = process.env.TORRENT_PARSER_URL || '';
const JACKETT_API_KEY = process.env.TORRENT_PARSER_API_KEY || '';

/**
 * HTTP GET через нативный модуль (обходит проблемы DNS в Docker)
 */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
        } else {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Invalid JSON')); }
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/**
 * Разрешить DNS и вернуть IP
 */
function resolveDns(hostname) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, (err, address) => {
      if (err) reject(err);
      else resolve(address);
    });
  });
}

/**
 * Поиск фильмов/сериалов через Jackett
 */
async function search(query, type = 'movie') {
  if (!JACKETT_URL || !JACKETT_API_KEY) {
    throw new Error('Jackett не настроен');
  }

  const categories = type === 'tv' ? '5000' : '2000';
  const baseUrl = JACKETT_URL.startsWith('http') ? JACKETT_URL : `http://${JACKETT_URL}`;
  
  // Извлекаем hostname из URL
  const parsedUrl = new URL(baseUrl);
  const hostname = parsedUrl.hostname;

  // Строим query string
  const qs = new URLSearchParams({
    apikey: JACKETT_API_KEY,
    Query: query,
    'Category[]': categories,
    Sort: 'seeders',
    Order: 'desc',
  });

  // Retry до 3 раз
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Пробуем сначала через fetch
      const fetchUrl = `${baseUrl}/api/v2.0/indexers/all/results?${qs}`;
      const response = await fetch(fetchUrl, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      return formatResults(data);
    } catch (fetchErr) {
      lastError = fetchErr;
      console.error(`[Jackett] Fetch attempt ${attempt}/3 failed: ${fetchErr.message}`);
      
      // Fallback: через нативный http модуль с DNS resolution
      try {
        const ip = await resolveDns(hostname);
        const httpUrl = `http://${ip}${parsedUrl.pathname}/api/v2.0/indexers/all/results?${qs}`;
        console.log(`[Jackett] Trying native http to ${ip}`);
        const data = await httpGet(httpUrl);
        return formatResults(data);
      } catch (httpErr) {
        console.error(`[Jackett] Native http attempt ${attempt}/3 failed: ${httpErr.message}`);
        lastError = httpErr;
      }
      
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }
  
  throw lastError;
}

/**
 * Форматировать результаты из Jackett
 */
function formatResults(data) {
  if (!data.Results || !Array.isArray(data.Results)) return [];
  
  return data.Results
    .map(r => ({
      title: r.Title || '',
      link: r.Link || '',
      magnetUri: r.MagnetUri || '',
      size: r.Size || 0,
      seeders: r.Seeders || 0,
      leechers: r.Leechers || 0,
      indexer: r.Indexer || '',
      category: r.Category || [],
      publishDate: r.PublishDate || '',
      details: r.Details || '',
      quality: extractQuality(r.Title),
      isMp4: isMp4(r.Title, r.Category),
      voiceover: extractVoiceover(r.Title),
    }))
    .sort((a, b) => {
      // Сначала сортируем по качеству: 720p → 1080p → 4K
      const qualityOrder = { '720p': 1, '1080p': 2, '4K': 3, '480p': 4, '': 5 };
      const aQuality = qualityOrder[a.quality] || 5;
      const bQuality = qualityOrder[b.quality] || 5;
      
      if (aQuality !== bQuality) {
        return aQuality - bQuality;
      }
      
      // Внутри одного качества — по seeders (больше = лучше)
      return b.seeders - a.seeders;
    });
}

function extractQuality(title) {
  const t = title.toLowerCase();
  if (t.includes('2160p') || t.includes('4k') || t.includes('uhd')) return '4K';
  if (t.includes('1080p')) return '1080p';
  if (t.includes('720p')) return '720p';
  if (t.includes('480p')) return '480p';
  return '';
}

function isMp4(title, categories) {
  const t = title.toLowerCase();
  return t.includes('.mp4') || 
         t.includes('h264') || 
         t.includes('h.264') || 
         t.includes('x264') ||
         t.includes('avc');
}

function extractVoiceover(title) {
  const t = title.toLowerCase();
  
  // Студии озвучки (по убыванию специфичности)
  const studios = [
    { pattern: 'lostfilm', name: 'LostFilm' },
    { pattern: 'newstudio', name: 'NewStudio' },
    { pattern: 'hdrezka', name: 'HDRezka' },
    { pattern: 'кубик в кубе', name: 'Кубик в Кубе' },
    { pattern: 'baibako', name: 'Baibako' },
    { pattern: 'octopus', name: 'Octopus' },
    { pattern: 'amedia', name: 'Amedia' },
    { pattern: 'coldfilm', name: 'Coldfilm' },
    { pattern: 'sunstudio', name: 'SunStudio' },
    { pattern: 'viruse', name: 'ViruseProject' },
    { pattern: 'gears media', name: 'Gears Media' },
    { pattern: 'parovoz', name: 'Parovoz' },
    { pattern: 'red head', name: 'Red Head Sound' },
    { pattern: 'ozz', name: 'Ozz' },
    { pattern: 'laci', name: 'Laci' },
  ];
  
  for (const studio of studios) {
    if (t.includes(studio.pattern)) return studio.name;
  }
  
  // Типы озвучки (если студия не найдена)
  if (t.includes('dub') || t.includes('дубляж')) return 'Дубляж';
  if (t.includes('pvo') || t.includes('professional')) return 'Проф. многоголосый';
  if (t.includes('mvo') || t.includes('multi voice')) return 'Многоголосый';
  if (t.includes('dvo') || t.includes('two voice')) return 'Двухголосый';
  if (t.includes('sub') || t.includes('субтитр')) return 'Субтитры';
  
  return '';
}

module.exports = { search };
