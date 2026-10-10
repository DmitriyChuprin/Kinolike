// Lampac NextGen Phantom adapter. Lampac returns an HTML fragment with a
// data-json attribute, so this module deliberately keeps that format private.
const crypto = require('node:crypto');

// Lampac is installed on the LAN host, not inside the KinoLike container.
// Deployment can override this through LAMPAC_URL without touching code.
const LAMPAC_URL = (process.env.LAMPAC_URL || 'http://192.168.1.103:9118').replace(/\/+$/, '');
// Keep the primary provider from delaying the reserve source for too long.
// This is intentionally separate from any broader Lampac timeout setting.
const TIMEOUT_MS = Math.max(1000, Number(process.env.PHANTOM_TIMEOUT_MS) || 7000);
const DIAGNOSTICS = process.env.PHANTOM_DIAGNOSTICS === 'true';

function decodeHtml(value) {
  return String(value || '').replace(/&(quot|apos|amp|lt|gt);|&#(x[0-9a-f]+|\d+);/gi, (all, named, numeric) => {
    if (named) return ({ quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' })[named.toLowerCase()] || all;
    const code = numeric[0].toLowerCase() === 'x' ? parseInt(numeric.slice(1), 16) : parseInt(numeric, 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : all;
  });
}

function parseDataJson(html) {
  const matches = [...String(html || '').matchAll(/\bdata-json\s*=\s*(['"])([\s\S]*?)\1/gi)];
  if (!matches.length) throw new Error('Phantom response does not contain data-json');
  const source = String(html || '');
  const values = matches.map((match) => {
    try {
      const value = JSON.parse(decodeHtml(match[2]));
      // Series translations use a selector whose visible caption sits outside
      // data-json: <div data-json='…'>LostFilm</div>. Keep that caption only
      // as adapter metadata; raw Lampac HTML never leaves the backend.
      const after = source.slice((match.index || 0) + match[0].length);
      const label = after.match(/^\s*>([^<]{1,300})<\//)?.[1];
      if (label && value && typeof value === 'object' && !Array.isArray(value)) value.__label = decodeHtml(label).trim();
      return value;
    } catch (err) {
      throw new Error(`Phantom data-json is invalid: ${err.message}`);
    }
  });
  // A movie response renders one data-json element per translation, while
  // series responses may have only one object or an array. Preserve the old
  // single-value shape but expose all movie translations to the normalizer.
  return values.length === 1 ? values[0] : values.flatMap((value) => Array.isArray(value) ? value : [value]);
}

function walk(value, result = []) {
  if (Array.isArray(value)) value.forEach((item) => walk(item, result));
  else if (value && typeof value === 'object') {
    result.push(value);
    Object.values(value).forEach((item) => walk(item, result));
  }
  return result;
}

function asUrl(value) {
  try { return new URL(String(value)); } catch { return null; }
}

function urlParam(object, param) {
  for (const value of [object?.url, object?.stream]) {
    const url = asUrl(value);
    if (url?.searchParams.get(param)) return url.searchParams.get(param);
  }
  return object?.[param] === undefined || object?.[param] === null ? null : String(object[param]);
}

function unique(items, key) {
  const seen = new Set();
  return items.filter((item) => { const value = key(item); if (!value || seen.has(value)) return false; seen.add(value); return true; });
}

// Lampac providers do not all name series fields identically. Phantom uses
// URL `s`/`e`, while other Lampac providers can return structured cards.
// Keep that provider variation inside the adapter layer.
function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function seasonOf(item) {
  return positiveInteger(urlParam(item, 's') ?? item?.season ?? item?.season_number ?? item?.seasonNumber);
}

function episodeOf(item) {
  return positiveInteger(urlParam(item, 'e') ?? item?.episode ?? item?.episode_number ?? item?.episodeNumber);
}

function normalizeVoices(data) {
  return unique(walk(data).filter((item) => {
    if (!item || (!item.stream && !item.url)) return false;
    const translationId = urlParam(item, 't');
    // A selected season response includes episode cards below translation
    // selectors. Episode cards have s/e (or s + stream) and cannot be voices.
    if (episodeOf(item) || ((item?.type === 'season' || item?.type === 'episode' || seasonOf(item)) && !translationId)) return false;
    return Boolean(item.translate || item.voice_name || item.__label || item.title || translationId);
  })
    .map((item, index) => ({
      id: String(urlParam(item, 't') || item.translate_id || item.id || item.translate || item.voice_name || index + 1),
      // Phantom's voice_name may contain a quality label (for example 2160p),
      // while translate is the human-readable dubbing name.
      name: String(item.translate || item.__label || item.voice_name || item.title || 'Озвучка'),
      quality: item.maxquality ? String(item.maxquality) : undefined,
    })), (voice) => `${voice.id}:${voice.name}`);
}

function normalizeSeasons(data) {
  return [...new Set(walk(data).map(seasonOf).filter(Boolean))].sort((a, b) => a - b);
}

function normalizeEpisodes(data) {
  return unique(walk(data).filter((item) => episodeOf(item))
    .map((item) => ({
      id: String(item.id || `${seasonOf(item) || 0}-${episodeOf(item)}`),
      season: seasonOf(item) || 0, episode: episodeOf(item),
      name: String(item.name || item.title || `${episodeOf(item)} серия`),
      voice: item.details ? String(item.details) : undefined,
    })), (episode) => `${episode.season}:${episode.episode}`)
    .sort((a, b) => a.episode - b.episode);
}

function findStream(data, { translationId, season, episode } = {}) {
  const candidates = walk(data).filter((item) => typeof item?.stream === 'string' && asUrl(item.stream));
  const matchesTranslation = (item, index) => !translationId || urlParam(item, 't') === String(translationId)
    || String(item.translate_id || '') === String(translationId)
    || String(item.id || '') === String(translationId)
    || String(item.translate || item.voice_name || '') === String(translationId)
    || String(index + 1) === String(translationId);
  // Phantom applies `t` to the lookup request but its resulting episode cards
  // commonly contain only `s`, `e` and `stream`. In that shape the lookup is
  // already translation-specific, so requiring a per-card translation field
  // would reject every episode.
  const hasPerCardTranslation = candidates.some((item) => urlParam(item, 't')
    || item.translate_id || item.translate || item.voice_name);
  const stream = candidates.find((item, index) => (!translationId || !hasPerCardTranslation || matchesTranslation(item, index))
    && (!season || Number(urlParam(item, 's') ?? item.season) === Number(season))
    && (!episode || Number(urlParam(item, 'e') ?? item.episode) === Number(episode)));
  // A selected episode is an exact request. Never silently substitute the
  // first card: that makes a missing/misparsed S01E05 play S01E01 instead.
  return stream || (episode ? null : candidates[0] || null);
}

function buildLookupQuery({ tokenMovie, imdbId, kinopoiskId, title, originalTitle, year, mediaType, season, translationId, originalLanguage }) {
  const query = new URLSearchParams({ serial: mediaType === 'tv' ? '1' : '0' });
  // `orid` is Phantom's token_movie, never KinoLike/TMDB's internal id.
  // During a normal lookup it is intentionally absent; Phantom identifies the
  // title from IMDb/Kinopoisk or its title/year fallback.
  if (tokenMovie) query.set('orid', String(tokenMovie));
  if (imdbId) query.set('imdb_id', String(imdbId));
  if (kinopoiskId) query.set('kinopoisk_id', String(kinopoiskId));
  if (title) query.set('title', String(title).slice(0, 300));
  if (originalTitle) query.set('original_title', String(originalTitle).slice(0, 300));
  if (originalLanguage) query.set('original_language', String(originalLanguage).slice(0, 20));
  if (year) query.set('year', String(year));
  if (season) query.set('s', String(season));
  if (translationId) query.set('t', String(translationId));
  return query;
}

async function lookup(input) {
  const query = buildLookupQuery(input);
  const lookupUrl = `${LAMPAC_URL}/lite/phantom?${query}`;
  const logQuery = new URLSearchParams(query);
  // token_movie is a capability returned by Lampac; diagnostics must not turn
  // it into a reusable server-log credential.
  if (logQuery.has('orid')) logQuery.set('orid', '<redacted>');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    console.info(`[Phantom] lookup ${input.mediaType} ${input.tmdbId || input.imdbId || input.title || 'unknown'}${input.season ? ` season ${input.season}` : ''}`);
    if (DIAGNOSTICS) console.info(`[Phantom] request ${LAMPAC_URL}/lite/phantom?${logQuery}`);
    const response = await fetch(lookupUrl, { signal: controller.signal });
    if (!response.ok) {
      // Log the lookup identity (but never a stream URL/token), as a
      // 503 for a title-only fallback looks identical to a provider outage.
      console.warn(`[Phantom] lookup failed status=${response.status} query=${logQuery}`);
      throw new Error(`Phantom HTTP ${response.status}`);
    }
    const html = await response.text();
    if (!html.trim()) throw new Error('Phantom returned an empty response');
    const data = parseDataJson(html);
    if (DIAGNOSTICS) {
      const episodes = normalizeEpisodes(data);
      console.info(`[Phantom] response items=${walk(data).length} seasons=${normalizeSeasons(data).join(',') || '-'} episodes=${episodes.map((item) => `S${item.season}E${item.episode}`).join(',') || '-'} voices=${normalizeVoices(data).map((item) => item.id).join(',') || '-'}`);
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Phantom request timed out');
    throw err;
  } finally { clearTimeout(timeout); }
}

function lampacStreamUrl(stream) {
  const url = asUrl(stream);
  const base = new URL(LAMPAC_URL);
  // Lampac commonly writes 127.0.0.1 into its own HTML and playlists. That is
  // Lampac's loopback, not the browser's or KinoLike container's loopback.
  // Canonicalize only that trusted form to the configured private Lampac host.
  const lampacLoopback = /^(?:127\.0\.0\.1|localhost|::1)$/i.test(url?.hostname || '') && url.port === (base.port || '80');
  if (!url || (url.origin !== base.origin && !lampacLoopback) || !/^(?:\/lite\/phantom\/|\/proxy\/)/.test(url.pathname)) {
    throw new Error('Phantom returned an unsafe stream URL');
  }
  return url.origin === base.origin ? url : new URL(`${url.pathname}${url.search}`, base);
}

// Short-lived opaque references prevent the browser from learning Lampac URLs
// and mean this cannot be used as an arbitrary-url SSRF endpoint.
const references = new Map();
const REF_TTL_MS = 30 * 60 * 1000;
function createReference(userId, url) {
  const now = Date.now();
  for (const [key, value] of references) if (value.expiresAt < now) references.delete(key);
  // A playlist can create many segment refs. Bound the in-memory, ephemeral
  // cache even if a client never returns for them.
  if (references.size > 10000) {
    const oldest = [...references.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt).slice(0, 1000);
    oldest.forEach(([key]) => references.delete(key));
  }
  const id = crypto.randomBytes(24).toString('base64url');
  references.set(id, { userId: Number(userId), url: lampacStreamUrl(url).toString(), expiresAt: now + REF_TTL_MS });
  return id;
}
function getReference(userId, id) {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(String(id))) return null;
  const ref = references.get(id);
  if (!ref || ref.expiresAt < Date.now() || ref.userId !== Number(userId)) { references.delete(id); return null; }
  return new URL(ref.url);
}

function resolvePlaylistValue(baseUrl, value) {
  if (!value || /^(?:data:|blob:)/i.test(value)) return null;
  if (/^\/\//.test(value) || /^[a-z][a-z\d+.-]*:/i.test(value) && !/^https?:/i.test(value)) return null;
  let resolved;
  try { resolved = new URL(value, baseUrl); } catch { return null; }
  const base = new URL(LAMPAC_URL);
  const lampacLoopback = /^(?:127\.0\.0\.1|localhost|::1)$/i.test(resolved.hostname) && resolved.port === (base.port || '80');
  if ((resolved.origin !== base.origin && !lampacLoopback) || !resolved.pathname.startsWith('/') || resolved.pathname.split('/').includes('..')) return null;
  // Playback is intentionally constrained to Lampac's Phantom and its own
  // generated proxy paths; admin/API endpoints are never reachable.
  if (!(/^(\/lite\/phantom\/|\/proxy\/)/.test(resolved.pathname))) return null;
  return resolved.origin === base.origin ? resolved : new URL(`${resolved.pathname}${resolved.search}`, base);
}

function rewriteManifest(manifest, manifestUrl, userId) {
  const rewrite = (value) => {
    const resolved = resolvePlaylistValue(manifestUrl, value);
    return resolved ? `/api/streaming/phantom/hls/${createReference(userId, resolved.toString())}` : value;
  };
  return String(manifest).split(/\r?\n/).map((line) => {
    if (!line || line.startsWith('#') === false) return line ? rewrite(line.trim()) : line;
    return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${rewrite(uri)}"`);
  }).join('\n');
}

module.exports = { parseDataJson, normalizeVoices, normalizeSeasons, normalizeEpisodes, findStream, buildLookupQuery, lookup, createReference, getReference, rewriteManifest, resolvePlaylistValue, lampacStreamUrl };
