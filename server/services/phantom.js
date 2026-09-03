// Phantom online source — Node.js port of Lampac Phantom module
// HTTP search + iframe parsing + Playwright-based m3u8 extraction
// All upstream requests go through SOCKS5 proxy
const fetch = require('node-fetch');
const { SocksProxyAgent } = require('socks-proxy-agent');

const PHANTOM_API = 'https://api.apbugall.org';
const PHANTOM_LINK = 'https://aport-as.allarknow.online';
const PHANTOM_TOKEN = '22c8122334d050de1bfc97bd08aa5e';

// ===== SOCKS5 proxy setup =====
let proxyAgent = null;
{
  const host = process.env.TMDB_PROXY_HOST || '127.0.0.1';
  const port = process.env.TMDB_PROXY_PORT || '1080';
  const user = process.env.TMDB_PROXY_USERNAME;
  const pass = process.env.TMDB_PROXY_PASSWORD;
  if (process.env.TMDB_PROXY_ENABLED === 'true') {
    let proxyUrl = `socks5://${host}:${port}`;
    if (user && pass) proxyUrl = `socks5://${user}:${pass}@${host}:${port}`;
    proxyAgent = new SocksProxyAgent(proxyUrl);
    console.log(`[Phantom] SOCKS5 прокси: ${user ? '***@' : ''}${host}:${port}`);
  } else {
    console.log('[Phantom] SOCKS5 прокси отключен');
  }
}

const FETCH_OPTIONS = {
  timeout: 12000,
  agent: proxyAgent || undefined,
};

// In-memory cache: key → { data, expires }
const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { cache.delete(key); return null; }
  return entry.data;
}

function cacheSet(key, data, ttlMs) {
  cache.set(key, { data, expires: Date.now() + ttlMs });
}

// ===== HTTP API =====

/**
 * Search by Kinopoisk / IMDB ID
 * Returns { category_id, data }
 */
async function searchById(kpId, imdbId) {
  const params = new URLSearchParams({ token: PHANTOM_TOKEN });
  if (kpId) params.set('kp', kpId);
  if (imdbId) params.set('imdb', imdbId);

  const url = `${PHANTOM_API}/?${params}`;
  console.log(`[Phantom] searchById: kp=${kpId} imdb=${imdbId}`);

  const resp = await fetch(url, FETCH_OPTIONS);
  const root = await resp.json();

  if (!root.data) return null;
  return {
    category_id: root.data.category,
    data: root.data,
  };
}

/**
 * Search by title + year
 * Returns { category_id, data } or null
 */
async function searchByTitle(title, isSerial = false, year = 0) {
  const listType = isSerial ? 'serial' : 'movie';
  const params = new URLSearchParams({
    token: PHANTOM_TOKEN,
    name: title,
    list: listType,
  });

  const url = `${PHANTOM_API}/?${params}`;
  console.log(`[Phantom] searchByTitle: "${title}" (${listType})`);

  const resp = await fetch(url, FETCH_OPTIONS);
  const root = await resp.json();

  if (!root.data) return null;

  // Try to match by title + year (like Lampac does)
  const stitle = title.toLowerCase().trim();
  for (const item of root.data) {
    const itemName = (item.name || '').toLowerCase().trim();
    if (itemName === stitle) {
      const y = item.year || 0;
      if (y > 0 && year > 0) {
        if (y === year || y === year - 1 || y === year + 1) {
          return { category_id: item.category_id || item.category, data: item };
        }
      } else {
        return { category_id: item.category_id || item.category, data: item };
      }
    }
  }

  // Fallback: return first match if year is close
  if (root.data.length > 0 && year > 0) {
    for (const item of root.data) {
      const y = item.year || 0;
      if (y > 0 && (y === year || y === year - 1 || y === year + 1)) {
        return { category_id: item.category_id || item.category, data: item };
      }
    }
  }

  return null;
}

/**
 * Get iframe content — parses fileList JSON from the iframe HTML
 * Returns { all, active } or null
 */
async function getIframe(tokenMovie) {
  if (!tokenMovie) return null;

  const cacheKey = `iframe:${tokenMovie}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const url = `${PHANTOM_LINK}/?token_movie=${tokenMovie}&token=${PHANTOM_TOKEN}`;
  console.log(`[Phantom] getIframe: tokenMovie=${tokenMovie}`);

  try {
    const resp = await fetch(url, {
      ...FETCH_OPTIONS,
      headers: {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'referer': 'https://kinogo-go.tv/',
        'sec-fetch-dest': 'iframe',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'cross-site',
        'upgrade-insecure-requests': '1',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
    });
    const html = await resp.text();

    // Parse fileList = JSON.parse('...')
    const match = html.match(/fileList\s*=\s*JSON\.parse\('([^'\\]*(?:\\.[^'\\]*)*)'\)/);
    if (!match) {
      console.log('[Phantom] getIframe: fileList not found in HTML');
      return null;
    }

    // Unescape the JSON string
    let jsonStr = match[1]
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, '\\')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t');

    const root = JSON.parse(jsonStr);
    const result = { all: root.all, active: root.active || null };

    cacheSet(cacheKey, result, 40 * 1000); // 40 sec cache
    return result;
  } catch (err) {
    console.error(`[Phantom] getIframe error:`, err.message);
    return null;
  }
}

// ===== Playwright stream extraction =====

/**
 * Extract m3u8 stream URLs using Playwright
 * Returns { watch: { edge_hash, origin, referer }, streams: [{ quality, link }] }
 */
async function extractStreams(tokenMovie, idFile) {
  const cacheKey = `streams:${tokenMovie}:${idFile}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  let chromium;
  try {
    chromium = require('playwright-core').chromium;
  } catch (e) {
    console.error('[Phantom] playwright-core not installed:', e.message);
    return null;
  }

  // Determine Chromium executable path
  const execPath = process.env.CHROMIUM_PATH ||
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
    '/usr/bin/chromium-browser';

  const iframeUri = `${PHANTOM_LINK}/?token_movie=${tokenMovie}&token=${PHANTOM_TOKEN}`;
  const iframeHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0">
<script>
var f = document.createElement('iframe');
f.src = '${iframeUri}';
f.style.cssText = 'width:100%;height:100%;border:none;position:fixed;top:0;left:0';
document.body.appendChild(f);
</script></body></html>`;

  let browser = null;
  try {
    console.log(`[Phantom] extractStreams: tokenMovie=${tokenMovie} idFile=${idFile}`);

    browser = await chromium.launch({
      executablePath: execPath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-extensions',
      ],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    let streams = [];
    let watch = {};
    let resolved = false;
    let capturedCookies = {};

    // Helper: HTTP request via node-fetch (SOCKS5 proxy)
    async function directRequest(url, opts = {}) {
      const directResp = await fetch(url, {
        ...opts,
        timeout: 12000,
        headers: opts.headers || {},
        redirect: 'follow',
        agent: proxyAgent || undefined,
      });
      // Capture Set-Cookie headers from all responses
      const setCookie = directResp.headers.raw()['set-cookie'];
      if (setCookie) {
        for (const sc of setCookie) {
          const m = sc.match(/^([^=]+)=([^;]*)/);
          if (m) capturedCookies[m[1].trim()] = m[2].trim();
        }
      }
      return directResp;
    }

    const resultPromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!resolved) { resolved = true; resolve(); }
      }, 20000);

      page.route('**/*', async (route) => {
        const url = route.request().url();
        const method = route.request().method();

        try {
          // 1) Replace kinogo-go.tv with our iframe HTML
          if (url.includes('kinogo-go.tv')) {
            console.log(`[Phantom] ROUTE: kinogo-go.tv → iframe HTML`);
            await route.fulfill({ status: 200, contentType: 'text/html', body: iframeHtml });
            return;
          }

          // 2) Intercept POST /movies/ — fetch with correct idFile
          if (method === 'POST' && url.includes('/movies/')) {
            const newUrl = url.replace(/\/[0-9]+$/, `/${idFile}`);
            const headers = { ...route.request().headers() };
            headers['accept-encoding'] = 'gzip, deflate, br, zstd';
            headers['cache-control'] = 'no-cache';
            headers['dnt'] = '1';
            headers['pragma'] = 'no-cache';
            headers['sec-fetch-dest'] = 'empty';
            headers['sec-fetch-mode'] = 'cors';
            headers['sec-fetch-site'] = 'same-origin';

            try {
              console.log(`[Phantom] POST intercepted: ${url} → ${newUrl}`);
              const directResp = await directRequest(newUrl, {
                method: 'POST',
                headers,
                body: route.request().postData() || undefined,
              });
              const json = await directResp.json();
              console.log(`[Phantom] POST response keys: ${Object.keys(json).join(', ')}`);

              if (json.hlsSource) {
                const items = Array.isArray(json.hlsSource) ? json.hlsSource : [json.hlsSource];
                const selectedItem = items.find(s => s.default === true) || items[0];
                if (selectedItem && selectedItem.quality) {
                  for (const [q, link] of Object.entries(selectedItem.quality)) {
                    if (link && typeof link === 'string') {
                      const clean = link.split(' or ')[0].trim();
                      console.log(`[Phantom] stream: ${q}p → ${clean.substring(0, 80)}`);
                      streams.push({ quality: `${q}p`, link: clean });
                    }
                  }
                }
              } else {
                console.log(`[Phantom] POST no hlsSource, keys: ${Object.keys(json).join(', ')}`);
              }

              await route.fulfill({ status: directResp.status, contentType: 'application/json', body: JSON.stringify(json) });
            } catch (e) {
              console.error('[Phantom] POST error:', e.message);
              await route.abort();
            }
            return;
          }

          // 3) Capture master.m3u8 headers
          if (url.includes('master.m3u8')) {
            const h = route.request().headers();
            watch = { edge_hash: h['accepts-controls'] || '', origin: h['origin'] || '', referer: h['referer'] || '' };
            console.log(`[Phantom] master.m3u8 captured: edge_hash=${watch.edge_hash ? 'yes' : 'no'}`);
            if (!resolved) { resolved = true; clearTimeout(timer); resolve(); }
            await route.abort();
            return;
          }

          // 4) Everything else: direct request via node-fetch
          const shortUrl = url.length > 100 ? url.substring(0, 100) + '...' : url;
          console.log(`[Phantom] ROUTE: ${method} ${shortUrl}`);
          const directResp = await directRequest(url, {
            method,
            headers: route.request().headers(),
            body: method !== 'GET' && method !== 'HEAD' ? route.request().postData() : undefined,
          });
          const body = await directResp.buffer();
          const ct = directResp.headers.get('content-type') || '';

          await route.fulfill({
            status: directResp.status,
            contentType: ct,
            headers: Object.fromEntries([...directResp.headers].filter(([k]) => !['content-encoding', 'transfer-encoding'].includes(k))),
            body,
          });
        } catch (err) {
          console.error(`[Phantom] ROUTE error: ${method} ${url.substring(0, 80)}: ${err.message}`);
          try { await route.abort(); } catch {}
        }
      });
    });

    await page.goto('https://kinogo-go.tv/', { timeout: 15000, waitUntil: 'domcontentloaded' });
    await resultPromise;

    const result = { watch, streams };
    if (streams.length > 0) {
      // Use captured cookies from proxy responses (Set-Cookie headers)
      // Playwright context.cookies() returns 0 because all requests are proxied via node-fetch
      const cookieStr = Object.entries(capturedCookies).map(([k,v]) => `${k}=${v}`).join('; ');
      result.cookies = cookieStr;
      console.log(`[Phantom] captured ${Object.keys(capturedCookies).length} cookies from responses`);
      cacheSet(cacheKey, result, 10 * 60 * 1000); // 10 min cache
    }
    console.log(`[Phantom] extractStreams: found ${streams.length} streams`);
    return result;
  } catch (err) {
    console.error('[Phantom] extractStreams error:', err.message);
    return null;
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

// ===== Content structure helpers =====

/**
 * Parse content structure from iframe data
 * Returns structured content with seasons, episodes, translations
 */
function parseContent(iframeData, category_id, serial) {
  if (!iframeData || !iframeData.all) return null;

  const all = iframeData.all;

  // Movie (category 1 or 3)
  if (category_id === 1 || category_id === 3) {
    const videos = all.theatrical;
    if (!videos) return null;

    const translations = [];
    for (const [translationName, sources] of Object.entries(videos)) {
      for (const [sourceKey, fileData] of Object.entries(sources)) {
        translations.push({
          name: fileData.translation || translationName,
          quality: fileData.quality || '',
          id: fileData.id,
          uhd: !!fileData.uhd,
        });
      }
    }

    return {
      type: 'movie',
      translations,
    };
  }

  // Serial (category 2)
  if (serial || category_id === 2) {
    const seasons = {};
    const firstKey = Object.keys(all)[0];

    if (firstKey && firstKey.startsWith('t')) {
      // Translation-based format
      for (const [transKey, transData] of Object.entries(all)) {
        const file = transData.file || transData;
        if (typeof file !== 'object') continue;

        for (const [seasonKey, seasonData] of Object.entries(file)) {
          if (!seasons[seasonKey]) seasons[seasonKey] = {};

          if (Array.isArray(seasonData)) {
            for (const ep of seasonData) {
              if (ep.id_translation !== undefined) {
                const transName = ep.translation || `voice_${ep.id_translation}`;
                if (!seasons[seasonKey][transName]) seasons[seasonKey][transName] = [];
                seasons[seasonKey][transName].push({
                  episode: ep.episode,
                  id: ep.id,
                  translation: transName,
                });
              }
            }
          } else if (typeof seasonData === 'object') {
            for (const [epKey, epData] of Object.entries(seasonData)) {
              if (epData.id_translation !== undefined) {
                const transName = epData.translation || `voice_${epData.id_translation}`;
                if (!seasons[seasonKey][transName]) seasons[seasonKey][transName] = [];
                seasons[seasonKey][transName].push({
                  episode: epData.episode || parseInt(epKey),
                  id: epData.id,
                  translation: transName,
                });
              }
            }
          }
        }
      }
    } else if (all[firstKey] && Array.isArray(all[firstKey])) {
      // Array format
      for (const [seasonKey, episodes] of Object.entries(all)) {
        if (!Array.isArray(episodes)) continue;
        seasons[seasonKey] = {};

        for (const ep of episodes) {
          for (const [voiceKey, voiceData] of Object.entries(ep)) {
            const transName = voiceData.translation || voiceKey;
            if (!seasons[seasonKey][transName]) seasons[seasonKey][transName] = [];
            seasons[seasonKey][transName].push({
              episode: voiceData.episode,
              id: voiceData.id,
              translation: transName,
            });
          }
        }
      }
    } else {
      // Object format
      for (const [seasonKey, seasonData] of Object.entries(all)) {
        if (typeof seasonData !== 'object') continue;
        seasons[seasonKey] = {};

        for (const [epKey, epData] of Object.entries(seasonData)) {
          if (typeof epData !== 'object') continue;
          for (const [voiceKey, voiceData] of Object.entries(epData)) {
            const transName = voiceData.translation || voiceKey;
            if (!seasons[seasonKey][transName]) seasons[seasonKey][transName] = [];
            seasons[seasonKey][transName].push({
              episode: voiceData.episode || parseInt(epKey),
              id: voiceData.id,
              translation: transName,
            });
          }
        }
      }
    }

    return {
      type: 'serial',
      seasons,
    };
  }

  return null;
}

module.exports = {
  PHANTOM_API,
  PHANTOM_LINK,
  PHANTOM_TOKEN,
  searchById,
  searchByTitle,
  getIframe,
  extractStreams,
  parseContent,
};
