// Phantom API routes — search, content structure, stream extraction, m3u8 proxy
const express = require('express');
const fetch = require('node-fetch');
const { SocksProxyAgent } = require('socks-proxy-agent');
const router = express.Router();
const phantom = require('../services/phantom');
const tmdb = require('../services/tmdb');
const crypto = require('crypto');

// SOCKS5 proxy for all Phantom requests
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
  }
}

// ===== Session-based proxy =====
// Store stream data server-side, use short IDs in proxy URLs
const streamSessions = new Map();
const SESSION_TTL = 15 * 60 * 1000; // 15 minutes

function createSession(url, edgeHash, origin, referer, cookies) {
  const id = crypto.randomBytes(6).toString('hex');
  streamSessions.set(id, { url, edgeHash, origin, referer, cookies, created: Date.now() });
  // Cleanup expired sessions
  if (streamSessions.size > 200) {
    for (const [k, v] of streamSessions) {
      if (Date.now() - v.created > SESSION_TTL) streamSessions.delete(k);
    }
  }
  return id;
}

function getSession(id) {
  const s = streamSessions.get(id);
  if (!s) return null;
  if (Date.now() - s.created > SESSION_TTL) { streamSessions.delete(id); return null; }
  return s;
}

// Helper: get IMDB ID from TMDB
async function getImdbId(tmdbId, mediaType) {
  try {
    if (mediaType === 'movie') {
      const data = await tmdb.tmdbRequest(`/movie/${tmdbId}`, {});
      return data.imdb_id || null;
    }
    const data = await tmdb.tmdbRequest(`/tv/${tmdbId}/external_ids`, {});
    const imdb = (data.external_ids || []).find(e => e.external_id_type === 'imdb_id');
    return imdb ? imdb.external_id : null;
  } catch (err) {
    console.error(`[Phantom] getImdbId error for ${mediaType}/${tmdbId}:`, err.message);
    return null;
  }
}

/**
 * POST /api/phantom/search
 */
router.post('/search', async (req, res) => {
  try {
    const { title, year = 0, mediaType = 'movie', tmdbId } = req.body;
    if (!title) return res.status(400).json({ error: 'title обязателен' });

    const isSerial = mediaType === 'tv';
    let result = null;
    let imdbId = null;

    if (tmdbId) {
      imdbId = await getImdbId(tmdbId, mediaType);
      if (imdbId) {
        console.log(`[Phantom] search: IMDB ID found: ${imdbId}`);
        result = await phantom.searchById(null, imdbId);
      }
    }

    if (!result) {
      result = await phantom.searchByTitle(title, isSerial, parseInt(year) || 0);
    }

    if (!result) {
      return res.json({ found: false, error: 'Phantom: ничего не найдено' });
    }

    const tokenMovie = result.data.token_movie;
    if (!tokenMovie) {
      return res.json({ found: false, error: 'Нет token_movie' });
    }

    const iframeData = await phantom.getIframe(tokenMovie);
    if (!iframeData) {
      return res.json({ found: false, error: 'Не удалось получить данные плеера' });
    }

    const content = phantom.parseContent(iframeData, result.category_id, isSerial);
    if (!content) {
      return res.json({ found: false, error: 'Не удалось распознать структуру контента' });
    }

    return res.json({
      found: true,
      tokenMovie,
      category_id: result.category_id,
      title: result.data.name || title,
      originalTitle: result.data.original_name || '',
      poster: result.data.poster || '',
      year: result.data.year || year,
      content,
    });
  } catch (err) {
    console.error('[Phantom] search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/phantom/stream
 * Returns streams with SHORT session-based proxy URLs
 */
router.get('/stream', async (req, res) => {
  try {
    const { tokenMovie, idFile } = req.query;
    if (!tokenMovie || !idFile) {
      return res.status(400).json({ error: 'tokenMovie и idFile обязательны' });
    }

    const result = await phantom.extractStreams(tokenMovie, parseInt(idFile));
    if (!result || !result.streams || result.streams.length === 0) {
      return res.status(404).json({ error: 'Стримы не найдены' });
    }

    const cookies = result.cookies || '';
    const edgeHash = result.watch.edge_hash || '';
    const origin = result.watch.origin || '';
    const referer = result.watch.referer || '';

    // Store each stream URL in a session and return short proxy URLs
    const streams = result.streams.map(s => {
      const sessionId = createSession(s.link, edgeHash, origin, referer, cookies);
      return {
        quality: s.quality,
        proxyUrl: `/api/phantom/proxy/${sessionId}`,
        originalUrl: s.link,
      };
    });

    return res.json({ streams, watch: result.watch });
  } catch (err) {
    console.error('[Phantom] stream error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/phantom/proxy/:sessionId
 * Proxies requests using session-based short URLs
 */
router.get('/proxy/:sessionId', async (req, res) => {
  try {
    const session = getSession(req.params.sessionId);
    if (!session) return res.status(404).send('Session expired');

    const { url, edgeHash, origin, referer, cookies } = session;

    console.log(`[Phantom Proxy] REQ: /proxy/${req.params.sessionId} → ${url.substring(0, 60)}...`);

    const headers = buildCdnHeaders(edgeHash, origin, referer, cookies);
    const response = await fetchWithRetry(url, headers);

    if (!response.ok) {
      console.log(`[Phantom Proxy] upstream ${response.status}`);
      return res.status(response.status).send(`Upstream error: ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';
    console.log(`[Phantom Proxy] upstream OK ct=${contentType}`);

    if (isM3u8(contentType, url)) {
      // m3u8 — rewrite URLs to use session-based proxy
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      const body = await response.text();
      const rewritten = rewriteM3u8(body, url, session);
      res.send(rewritten);
    } else {
      // Binary segment — pipe through
      const peek = await response.clone().buffer();
      const head = peek.slice(0, 4).toString('utf-8');
      if (head === 'ftyp' || (peek[0] === 0x00 && peek[1] === 0x00)) {
        res.setHeader('Content-Type', 'video/mp4');
      } else {
        res.setHeader('Content-Type', contentType || 'video/mp4');
      }
      const cl = response.headers.get('content-length');
      if (cl) res.setHeader('Content-Length', cl);
      const cc = response.headers.get('cache-control');
      if (cc) res.setHeader('Cache-Control', cc);
      response.body.pipe(res);
    }
  } catch (err) {
    console.error('[Phantom] proxy error:', err.message);
    res.status(500).send('Proxy error');
  }
});

// ===== Helpers =====

function buildCdnHeaders(edgeHash, origin, referer, cookies) {
  const headers = {
    'accept': '*/*',
    'accepts-controls': edgeHash,
    'authorizations': 'Bearer pXzvbyDGLYyB6VkwsWZDv3iMKZtsXNzpzRyxZUcsKHXxsSeaYakbo3hw9mBFRc5VQTpqAX6BW8aDEqyLaHYcXSQiV6KHYTVTK6MYRphNAy5sBjtrevqkDzKmLqNdfMZGEU9NELjmtKfZy3RNGzCd767sNh1mXEj4tCcvqndHtzmwAbZNkhm4ghDEasodotMBewypNQ56uotJAQGX11csfeRfBAPk8DcUWWkkqzxca8vbnEw12vUFbBzT6hz8ZB3F3dzUhUXoL2cr1WM1bXQArRCS1MUNMz3X5WDMMQoZKxj2AMTRqp7QQX4dDB9B7VzEZTmyFULhm1AcHHMkoMvSVvKYoBoAKLycYAgMHeD4ECJcGEAGpnkJhrV57zQ7',
    'connection': 'keep-alive',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'accept-language': 'ru-RU,ru;q=0.9,uk-UA;q=0.8,uk;q=0.7,en-US;q=0.6,en;q=0.5',
    'accept-encoding': 'gzip, deflate, br, zstd',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'cross-site',
  };
  if (origin) headers['origin'] = origin;
  if (referer) headers['referer'] = referer;
  if (cookies) headers['cookie'] = cookies;
  return headers;
}

async function fetchWithRetry(url, headers, maxAttempts = 3) {
  let response;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    response = await fetch(url, { headers, timeout: 15000, agent: proxyAgent || undefined });
    if (response.ok || response.status !== 403) break;
    console.log(`[Phantom Proxy] 403 attempt ${attempt + 1}, retrying...`);
    await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
  }
  return response;
}

function isM3u8(contentType, url) {
  return contentType.includes('mpegurl') || contentType.includes('m3u8') ||
    url.includes('.m3u8') || contentType.includes('x-mpegURL') || contentType.includes('vnd.apple');
}

/**
 * Rewrite m3u8 — uses session-based short URLs
 * For each URL in the m3u8, creates a session and uses /proxy/:id
 */
function rewriteM3u8(content, baseUrl, session) {
  let baseDir = baseUrl;
  try {
    const u = new URL(baseUrl);
    baseDir = u.href.substring(0, u.href.lastIndexOf('/') + 1);
  } catch {}

  return content.split('\n').map(line => {
    const trimmed = line.trim();

    // Handle #EXT-X-MAP:URI="..."
    const mapMatch = trimmed.match(/^(#EXT-X-MAP:.*URI=\")([^\"]+)(\".*)$/);
    if (mapMatch) {
      let uri = mapMatch[2];
      if (!uri.startsWith('http')) {
        try { uri = new URL(uri, baseDir).href; } catch {}
      }
      const sid = createSession(uri, session.edgeHash, session.origin, session.referer, session.cookies);
      console.log(`[Phantom m3u8] MAP URI → /proxy/${sid}`);
      return `${mapMatch[1]}/api/phantom/proxy/${sid}${mapMatch[3]}`;
    }

    if (!trimmed || trimmed.startsWith('#')) return line;

    // Resolve relative URLs
    let fullUrl = trimmed;
    if (!trimmed.startsWith('http')) {
      try { fullUrl = new URL(trimmed, baseDir).href; } catch { fullUrl = trimmed; }
    }

    const sid = createSession(fullUrl, session.edgeHash, session.origin, session.referer, session.cookies);
    console.log(`[Phantom m3u8] "${trimmed.substring(0, 40)}" → /proxy/${sid}`);
    return `/api/phantom/proxy/${sid}`;
  }).join('\n');
}

module.exports = router;
