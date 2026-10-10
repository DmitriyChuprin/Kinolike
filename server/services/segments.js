const INTRODB_URL = process.env.INTRODB_API_URL || 'https://api.introdb.app';
const SKIPDB_URL = process.env.SKIPDB_API_URL || 'https://api.skipdb.tv';
const TIMEOUT_MS = Number(process.env.SEGMENTS_API_TIMEOUT_MS) || 3500;

function validSegment(value, duration) {
  if (!value || typeof value !== 'object') return null;
  const start = Number(value.start ?? value.start_sec ?? (Number(value.start_ms) / 1000));
  const end = Number(value.end ?? value.end_sec ?? (Number(value.end_ms) / 1000));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return null;
  // A broken upstream response must never result in a destructive seek.
  if (duration > 0 && (start > duration + 2 || end > duration + 2)) return null;
  return { start, end: duration > 0 && end > duration ? duration : end };
}

async function getJson(url, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    return await response.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function introDbUrl(input) {
  const query = new URLSearchParams({ imdb_id: input.imdbId });
  if (input.mediaType === 'movie') query.set('is_movie', 'true');
  else { query.set('season', String(input.season)); query.set('episode', String(input.episode)); }
  return `${INTRODB_URL}/segments?${query}`;
}

async function introdb(input, fetchImpl) {
  const data = await getJson(introDbUrl(input), fetchImpl);
  if (!data) return null;
  const intro = validSegment(data.intro, input.duration);
  // IntroDB calls end credits "outro"; accept credits for forward-compatible payloads.
  const credits = validSegment(data.outro, input.duration) || validSegment(data.credits, input.duration);
  return intro || credits ? { intro, credits, source: 'introdb' } : null;
}

async function skipdb(input, fetchImpl) {
  const query = new URLSearchParams({ imdb_id: input.imdbId, adjust: 'conservative' });
  if (input.duration > 0) query.set('duration', String(input.duration));
  if (input.mediaType === 'tv') { query.set('season', String(input.season)); query.set('episode', String(input.episode)); }
  const data = await getJson(`${SKIPDB_URL}/api/segments?${query}`, fetchImpl);
  if (!data?.segments) return null;
  const intro = validSegment(data.segments.intro, input.duration);
  const credits = validSegment(data.segments.outro, input.duration);
  return intro || credits ? { intro, credits, source: 'skipdb' } : null;
}

async function fetchSegments(input, fetchImpl) {
  // Provider order is intentional: IntroDB is the primary source. SkipDB is
  // queried only when it supplied no usable intro or credits at all.
  return await introdb(input, fetchImpl) || await skipdb(input, fetchImpl) || { intro: null, credits: null, source: 'none' };
}

module.exports = { validSegment, introDbUrl, introdb, skipdb, fetchSegments };
