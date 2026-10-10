const fetch = require('node-fetch');
const db = require('../db/database');
const tmdb = require('./tmdb');

const SERVICES = ['kion', 'wink', 'premier'];
const REFRESH_HOURS = { kion: 4, wink: 2, premier: 4 };
const SOURCE_URLS = {
  kion: 'https://kion.ru/video/filter/mainNowPopularMixable',
  wink: 'https://wink.ru/movies',
  premier: 'https://premier.one/collections/sejchas-smotryat',
};

function decode(value = '') {
  return String(value).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function yearFrom(value) { const found = String(value).match(/(?:19|20)\d{2}/); return found ? Number(found[0]) : undefined; }
function trendSection(html, start, end = []) {
  const from = html.toLocaleLowerCase('ru-RU').indexOf(start.toLocaleLowerCase('ru-RU'));
  if (from < 0) return html;
  const tail = html.slice(from);
  const offsets = end.map(marker => tail.toLocaleLowerCase('ru-RU').indexOf(marker.toLocaleLowerCase('ru-RU'))).filter(offset => offset > 0);
  return tail.slice(0, offsets.length ? Math.min(...offsets) : undefined);
}
function cleanTitle(text) {
  return text.replace(/^\s*(?:\d+\+\s*)?(?:\d+(?:[.,]\d+)?\s*)?/, '')
    .replace(/^(?:Премьера|Новый сезон|Финал сезона|Все серии|Бесплатно)\s+/i, '')
    .replace(/\s+(?:Бесплатно|Подписка|Премьера|Новый сезон|Все серии)(?:\s|·|$).*/i, '')
    .replace(/\s+(?:Комедия|Драма|Триллер|Детектив|Ужасы|Фантастика|Мелодрама|Боевик|Приключения|Реалити|Аниме|Мультфильм|Семейный|Документальный).*$/i, '')
    .replace(/\s+\d+(?:[.,]\d+)?\s*$/, '').replace(/\s+·\s*$/, '').trim();
}

async function getPublicPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KinoLikeTrending/1.0; +https://kinolike.local)', Accept: 'text/html,application/xhtml+xml' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  } finally { clearTimeout(timeout); }
}

// Public pages are SSR today.  Keeping this compact parser behind providers
// makes replacement with a discovered first-party JSON endpoint isolated.
function anchors(html, matcher, typeFromHref, baseUrl) {
  const items = []; const seen = new Set(); let match;
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = re.exec(html)) && items.length < 40) {
    const href = match[1]; if (!matcher.test(href)) continue;
    const text = decode(match[2]);
    const title = cleanTitle(text.replace(/\s+(?:19|20)\d{2}.*$/, ''));
    if (title.length < 2 || seen.has(`${href}:${title}`)) continue;
    seen.add(`${href}:${title}`);
    const nearby = decode(html.slice(Math.max(0, match.index - 160), Math.min(html.length, match.index + match[0].length + 240)));
    items.push({ title, year: yearFrom(nearby), mediaType: typeFromHref(href), sourceUrl: new URL(href, baseUrl).toString() });
  }
  return items;
}

class KionTrendingProvider {
  async fetchTrending() {
    const html = await getPublicPage(SOURCE_URLS.kion);
    return anchors(trendSection(html, 'Популярно сейчас', ['Разделы']), /\/(?:serial|film|movie)\//, href => href.includes('/serial/') ? 'tv' : 'movie', SOURCE_URLS.kion).slice(0, 20);
  }
}
class WinkTrendingProvider {
  async fetchTrending() {
    const [movies, series] = await Promise.all([getPublicPage(SOURCE_URLS.wink), getPublicPage('https://wink.ru/series')]);
    // The public Wink SSR markup repeats the heading in hydration data, so a
    // DOM substring is less stable than route filtering. The first item is the
    // page hero; subsequent /movies and /series links are the ranking cards.
    const movieItems = anchors(movies, /\/movies\//, () => 'movie', SOURCE_URLS.wink).slice(1);
    const tvItems = anchors(series, /\/series\//, () => 'tv', 'https://wink.ru/series').slice(1);
    // Both public "Сейчас смотрят" carousels describe the same one-hour signal.
    return [...movieItems, ...tvItems].slice(0, 20);
  }
}
class PremierTrendingProvider {
  async fetchTrending() {
    let html = await getPublicPage(SOURCE_URLS.premier);
    let marker = 'Сейчас смотрят';
    // The requested collection is occasionally routed to the homepage without
    // its collection block. In that case use PREMIER's public today collection,
    // rather than treating arbitrary homepage cards as a popularity ranking.
    if (!html.toLocaleLowerCase('ru-RU').includes(marker.toLocaleLowerCase('ru-RU'))) {
      html = await getPublicPage('https://premier.one/collections/smotrite-segodnya');
      marker = 'Смотрите сегодня';
    }
    const section = trendSection(html, marker, ['Фильмы в подписке', 'Смотрите сегодня', 'Коллекции сериалов']);
    if (section === html) throw new Error('PREMIER public trending collection is not present in SSR response');
    return anchors(section, /\/(?:movie|series|show|film)\//, href => /\/(?:series|show)\//.test(href) ? 'tv' : 'movie', SOURCE_URLS.premier).slice(0, 20);
  }
}
const providers = { kion: new KionTrendingProvider(), wink: new WinkTrendingProvider(), premier: new PremierTrendingProvider() };

function comparable(value) { return String(value || '').toLocaleLowerCase('ru-RU').replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
function titleScore(source, candidate) {
  const wanted = comparable(source); const titles = [candidate.title, candidate.name, candidate.original_title, candidate.original_name].map(comparable).filter(Boolean);
  if (titles.includes(wanted)) return 70;
  return titles.some(title => title && (title.includes(wanted) || wanted.includes(title))) ? 42 : 0;
}
function scoreMatch(item, candidate) {
  const title = titleScore(item.title, candidate);
  if (!title) return -Infinity;
  const date = candidate.release_date || candidate.first_air_date || '';
  const year = Number(String(date).slice(0, 4));
  const yearScore = item.year ? (year === item.year ? 18 : Math.abs(year - item.year) <= 1 ? 4 : -18) : 0;
  const typeScore = item.mediaType ? ((candidate.media_type || item.mediaType) === item.mediaType ? 12 : -50) : 0;
  return title + yearScore + typeScore + Math.min(8, Math.log10(Number(candidate.popularity) + 1));
}
async function matchTmdb(item) {
  const types = item.mediaType ? [item.mediaType] : ['movie', 'tv'];
  const results = [];
  for (const type of types) {
    const response = await tmdb.search(item.title, type);
    for (const candidate of response.results || []) results.push({ ...candidate, media_type: type });
  }
  const ranked = results.map(candidate => ({ candidate, score: scoreMatch(item, candidate) })).sort((a, b) => b.score - a.score);
  const best = ranked[0]; const second = ranked[1];
  if (!best || best.score < 72 || (second && best.score - second.score < 8)) return null;
  return { tmdbId: best.candidate.id, mediaType: best.candidate.media_type };
}

async function replaceSnapshot(service, sourceUrl, items) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const snapshot = await client.query('INSERT INTO streaming_trending_snapshots(service, source_url) VALUES ($1, $2) RETURNING id', [service, sourceUrl]);
    for (const item of items) await client.query('INSERT INTO streaming_trending_items(snapshot_id, position, tmdb_id, media_type, source_title, source_url) VALUES ($1,$2,$3,$4,$5,$6)', [snapshot.rows[0].id, item.position, item.tmdbId, item.mediaType, item.sourceTitle, item.sourceUrl || null]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
async function updateService(service) {
  const provider = providers[service]; if (!provider) throw new Error(`Unsupported service: ${service}`);
  try {
    const sourceItems = await provider.fetchTrending();
    console.log(`[Trending:${service}] fetched ${sourceItems.length}`);
    const matched = [];
    for (const [index, source] of sourceItems.entries()) {
      const match = await matchTmdb(source);
      if (!match) { console.warn(`[Trending] TMDB match failed: service=${service} title=${JSON.stringify(source.title)} year=${source.year || ''}`); continue; }
      if (matched.some(item => item.tmdbId === match.tmdbId && item.mediaType === match.mediaType)) continue;
      matched.push({ ...match, position: index + 1, sourceTitle: source.title, sourceUrl: source.sourceUrl });
      if (matched.length === 10) break;
    }
    console.log(`[Trending:${service}] matched ${matched.length}/${sourceItems.length}`);
    if (matched.length < 3) throw new Error('Too few confident TMDB matches; preserving previous snapshot');
    await replaceSnapshot(service, SOURCE_URLS[service], matched);
    console.log(`[Trending:${service}] updated successfully`);
    return { service, fetched: sourceItems.length, matched: matched.length };
  } catch (error) { console.error(`[Trending:${service}] update failed: ${error.message}`); return { service, error: error.message }; }
}
async function getTrending(service) {
  const { rows } = await db.query(`SELECT s.fetched_at, i.position, i.tmdb_id, i.media_type
    FROM streaming_trending_snapshots s JOIN streaming_trending_items i ON i.snapshot_id=s.id
    WHERE s.service=$1 AND s.id=(SELECT id FROM streaming_trending_snapshots WHERE service=$1 ORDER BY fetched_at DESC LIMIT 1)
    ORDER BY i.position`, [service]);
  return { service, updatedAt: rows[0]?.fetched_at || null, items: rows.map(row => ({ position: row.position, tmdbId: row.tmdb_id, mediaType: row.media_type })), unavailable: rows.length === 0 };
}
async function isDue(service) {
  const { rows } = await db.query('SELECT fetched_at FROM streaming_trending_snapshots WHERE service=$1 ORDER BY fetched_at DESC LIMIT 1', [service]);
  if (!rows[0]) return true;
  return Date.now() - new Date(rows[0].fetched_at).getTime() >= REFRESH_HOURS[service] * 3600000;
}
module.exports = { SERVICES, REFRESH_HOURS, providers, getTrending, isDue, updateService, matchTmdb, scoreMatch, __test: { comparable, titleScore } };
