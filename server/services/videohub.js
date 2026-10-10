// Lampac's installed CDNvideohub module exposes VideoHUB through the local
// `/lite/cdnvideohub` template API.  The module itself accepts only a
// Kinopoisk ID; TMDB/IMDb are resolved through Lampac's `/externalids` bridge.
const crypto = require('node:crypto');
const phantom = require('./phantom');

const LAMPAC_URL = (process.env.LAMPAC_URL || 'http://192.168.1.103:9118').replace(/\/+$/, '');
const TIMEOUT_MS = Math.max(1000, Number(process.env.VIDEOHUB_TIMEOUT_MS) || 10000);

function asUrl(value) { try { return new URL(String(value)); } catch { return null; } }

async function request(path, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${LAMPAC_URL}${path}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`VideoHUB HTTP ${response.status}`);
    const body = await response.text();
    if (!body.trim()) throw new Error(`VideoHUB ${label} returned an empty response`);
    return body;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`VideoHUB ${label} timed out`);
    throw err;
  } finally { clearTimeout(timeout); }
}

async function resolveKinopoiskId(input) {
  if (/^\d{1,20}$/.test(String(input.kinopoiskId || ''))) return String(input.kinopoiskId);
  const query = new URLSearchParams({ id: String(input.tmdbId || ''), serial: input.mediaType === 'tv' ? '1' : '0' });
  if (input.imdbId) query.set('imdb_id', input.imdbId);
  const body = await request(`/externalids?${query}`, 'external IDs');
  let data;
  try { data = JSON.parse(body); } catch { throw new Error('VideoHUB external IDs response is invalid'); }
  const id = String(data?.kinopoisk_id || '');
  if (!/^\d{1,20}$/.test(id) || id === '0') throw new Error('VideoHUB requires a Kinopoisk ID');
  return id;
}

async function lookup(input) {
  const kinopoiskId = await resolveKinopoiskId(input);
  const query = new URLSearchParams({
    kinopoisk_id: kinopoiskId,
    title: String(input.title || '').slice(0, 300),
    original_title: String(input.originalTitle || '').slice(0, 300),
  });
  // These are the only selector parameters accepted by CDNvideohub's route.
  if (input.season) query.set('s', String(input.season));
  if (input.translationId) query.set('t', String(input.translationId));
  console.info(`[VideoHUB] lookup ${input.mediaType} kp=${kinopoiskId}${input.season ? ` season ${input.season}` : ''}`);
  return { data: phantom.parseDataJson(await request(`/lite/cdnvideohub?${query}`, 'lookup')), kinopoiskId };
}

function lampacStreamUrl(stream) {
  const url = asUrl(stream); const base = new URL(LAMPAC_URL);
  const loopback = /^(?:127\.0\.0\.1|localhost|::1)$/i.test(url?.hostname || '') && url.port === (base.port || '80');
  if (!url || (url.origin !== base.origin && !loopback) || !/^(?:\/lite\/cdnvideohub\/|\/proxy\/)/.test(url.pathname)) throw new Error('VideoHUB returned an unsafe stream URL');
  return url.origin === base.origin ? url : new URL(`${url.pathname}${url.search}`, base);
}

const references = new Map(); const REF_TTL_MS = 30 * 60 * 1000;
function createReference(userId, url) {
  const now = Date.now();
  for (const [key, value] of references) if (value.expiresAt < now) references.delete(key);
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
  if (!value || /^(?:data:|blob:)/i.test(value) || /^\/\//.test(value) || /^[a-z][a-z\d+.-]*:/i.test(value) && !/^https?:/i.test(value)) return null;
  let resolved; try { resolved = new URL(value, baseUrl); } catch { return null; }
  try { return lampacStreamUrl(resolved.toString()); } catch { return null; }
}
function rewriteManifest(manifest, manifestUrl, userId) {
  const rewrite = (value) => {
    const url = resolvePlaylistValue(manifestUrl, value);
    return url ? `/api/streaming/videohub/hls/${createReference(userId, url.toString())}` : value;
  };
  return String(manifest).split(/\r?\n/).map((line) => !line || !line.startsWith('#') ? (line ? rewrite(line.trim()) : line) : line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${rewrite(uri)}"`)).join('\n');
}

module.exports = { lookup, resolveKinopoiskId, lampacStreamUrl, createReference, getReference, rewriteManifest, resolvePlaylistValue };
