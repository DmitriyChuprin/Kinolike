const fetch = require('node-fetch');
const tmdb = require('./tmdb');
const trailerCache = require('../models/trailer');

const BAD_WORDS = /\b(reaction|review|fan trailer|concept trailer|explained|full movie|full film)\b|(?:обзор|реакция|разбор|полный фильм|весь фильм|фан-?трейлер)/i;
const TEASER_WORDS = /\bteaser\b|тизер/i;
const OFFICIAL_WORDS = /\bofficial\b|официальн/i;
const TRAILER_WORDS = /\btrailer\b|трейлер/i;
const CACHE_HOURS = Math.max(1, Number(process.env.TRAILER_CACHE_HOURS || 24 * 30));
const SOURCE_PRIORITY = { rutube: 0, youtube: 1, vk: 2, vimeo: 3 };

function normalized(value) { return String(value || '').toLocaleLowerCase('ru').replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
function titleMatches(candidate, context) {
  const title = normalized(candidate.title); const alternatives = [context.title, context.originalTitle].map(normalized).filter(Boolean);
  return alternatives.some((item) => title.includes(item) || item.includes(title));
}

function scoreCandidate(candidate, context) {
  const text = candidate.title || '';
  if (BAD_WORDS.test(text)) return -1000;
  let score = 0;
  if (candidate.language === 'ru') score += 45;
  if (candidate.type === 'Trailer') score += 35;
  else if (candidate.type === 'Teaser' || TEASER_WORDS.test(text)) score += 5;
  else score -= 10;
  if (candidate.official) score += 25;
  if (OFFICIAL_WORDS.test(text)) score += 10;
  if (titleMatches(candidate, context)) score += 20;
  else score -= 30;
  if (context.year && new RegExp(`\\b${context.year}\\b`).test(text)) score += 8;
  if (candidate.duration && candidate.duration >= 45 && candidate.duration <= 240) score += 8;
  if (candidate.duration && candidate.duration < 20) score -= 20;
  return score;
}

function youtubeCandidate(item, context) {
  const id = typeof item.id === 'string' ? item.id : item.id?.videoId;
  if (!id) return null;
  const match = String(item.contentDetails?.duration || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  const duration = match ? Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0) : undefined;
  const title = item.snippet?.title || '';
  return { source: 'youtube', videoId: id, url: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`, embedUrl: `https://www.youtube.com/embed/${encodeURIComponent(id)}?rel=0`, language: item.snippet?.defaultAudioLanguage?.split('-')[0] || (/[а-яё]/i.test(title) ? 'ru' : null), type: TRAILER_WORDS.test(title) ? 'Trailer' : (TEASER_WORDS.test(title) ? 'Teaser' : 'Clip'), official: OFFICIAL_WORDS.test(title) || /official|studios|pictures|film/i.test(item.snippet?.channelTitle || ''), title, duration, context };
}

class TmdbProvider {
  async search(context) {
    // TMDB localizes its response, but this explicitly keeps original-language
    // candidates so that a missing Russian trailer still falls back correctly.
    const data = await tmdb.tmdbRequest(`/${context.mediaType}/${context.tmdbId}/videos`, { include_video_language: 'ru,en,null' }, { ttlHours: 24 * 7 });
    return (data.results || []).map((item) => {
      if (!item.key || !item.site) return null;
      const site = String(item.site).toLowerCase();
      const maps = {
        youtube: { source: 'youtube', url: `https://www.youtube.com/watch?v=${encodeURIComponent(item.key)}`, embedUrl: `https://www.youtube.com/embed/${encodeURIComponent(item.key)}?rel=0` },
        vimeo: { source: 'vimeo', url: `https://vimeo.com/${encodeURIComponent(item.key)}`, embedUrl: `https://player.vimeo.com/video/${encodeURIComponent(item.key)}` },
      };
      const map = maps[site]; if (!map) return null;
      return { ...map, videoId: item.key, language: item.iso_639_1 || null, type: item.type || null, official: Boolean(item.official), title: item.name || '', context };
    }).filter(Boolean);
  }
}

class YouTubeProvider {
  enabled() { return Boolean(process.env.YOUTUBE_API_KEY); }
  async search(context) {
    if (!this.enabled()) return [];
    const query = `${context.title || context.originalTitle} ${context.year || ''} трейлер`.trim();
    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    url.search = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: '10', q: query, key: process.env.YOUTUBE_API_KEY }).toString();
    const response = await fetch(url.toString()); if (!response.ok) throw new Error(`YouTube API ${response.status}`);
    const ids = (await response.json()).items.map((item) => item.id?.videoId).filter(Boolean);
    if (!ids.length) return [];
    const detailsUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
    detailsUrl.search = new URLSearchParams({ part: 'snippet,contentDetails', id: ids.join(','), key: process.env.YOUTUBE_API_KEY }).toString();
    const detailsResponse = await fetch(detailsUrl.toString()); if (!detailsResponse.ok) throw new Error(`YouTube API ${detailsResponse.status}`);
    return (await detailsResponse.json()).items.map((item) => youtubeCandidate(item, context)).filter(Boolean);
  }
}

class VkVideoProvider {
  enabled() { return Boolean(process.env.VK_VIDEO_ACCESS_TOKEN); }
  async search(context) {
    if (!this.enabled()) return [];
    const url = new URL('https://api.vk.com/method/video.search');
    url.search = new URLSearchParams({ q: `${context.title || context.originalTitle} трейлер`, count: '20', adult: '0', v: '5.199', access_token: process.env.VK_VIDEO_ACCESS_TOKEN }).toString();
    const response = await fetch(url.toString()); if (!response.ok) throw new Error(`VK API ${response.status}`);
    const body = await response.json(); if (body.error) throw new Error(`VK API ${body.error.error_code}`);
    return (body.response?.items || []).map((item) => {
      if (!item.owner_id || !item.id) return null;
      const id = `${item.owner_id}_${item.id}`;
      return { source: 'vk', videoId: id, url: `https://vk.com/video${id}`, embedUrl: `https://vk.com/video_ext.php?oid=${encodeURIComponent(item.owner_id)}&id=${encodeURIComponent(item.id)}&hd=2`, language: 'ru', type: TRAILER_WORDS.test(item.title || '') ? 'Trailer' : (TEASER_WORDS.test(item.title || '') ? 'Teaser' : 'Clip'), official: OFFICIAL_WORDS.test(item.title || '') || Boolean(item.is_favorite), title: item.title || '', duration: Number(item.duration) || undefined, context };
    }).filter(Boolean);
  }
}

class VimeoProvider {
  enabled() { return Boolean(process.env.VIMEO_ACCESS_TOKEN); }
  async search(context) {
    if (!this.enabled()) return [];
    const url = new URL('https://api.vimeo.com/videos'); url.search = new URLSearchParams({ query: `${context.originalTitle || context.title} trailer`, per_page: '10', fields: 'uri,name,duration,user.name' }).toString();
    const response = await fetch(url.toString(), { headers: { Authorization: `Bearer ${process.env.VIMEO_ACCESS_TOKEN}` } }); if (!response.ok) throw new Error(`Vimeo API ${response.status}`);
    return (await response.json()).data.map((item) => {
      const id = String(item.uri || '').split('/').pop(); if (!id) return null;
      return { source: 'vimeo', videoId: id, url: `https://vimeo.com/${id}`, embedUrl: `https://player.vimeo.com/video/${id}`, language: null, type: TRAILER_WORDS.test(item.name || '') ? 'Trailer' : (TEASER_WORDS.test(item.name || '') ? 'Teaser' : 'Clip'), official: OFFICIAL_WORDS.test(item.name || '') || /official|studio/i.test(item.user?.name || ''), title: item.name || '', duration: Number(item.duration) || undefined, context };
    }).filter(Boolean);
  }
}

class RutubeProvider {
  async search(context) {
    const url = new URL('https://rutube.ru/api/search/video/');
    url.search = new URLSearchParams({ query: `${context.title || context.originalTitle} трейлер`, page: '1', limit: '20' }).toString();
    const response = await fetch(url.toString(), {
      headers: { Accept: 'application/json', Referer: 'https://rutube.ru/', 'User-Agent': 'Kinolike Trailer Resolver/1.0' },
    });
    if (!response.ok) throw new Error(`Rutube API ${response.status}`);
    return (await response.json()).results.map((item) => {
      const id = String(item.id || ''); if (!id) return null;
      const title = item.title || '';
      return {
        source: 'rutube', videoId: id,
        url: item.video_url || `https://rutube.ru/video/${encodeURIComponent(id)}/`,
        embedUrl: item.embed_url || `https://rutube.ru/play/embed/${encodeURIComponent(id)}`,
        language: 'ru', type: TRAILER_WORDS.test(title) ? 'Trailer' : (TEASER_WORDS.test(title) ? 'Teaser' : 'Clip'),
        official: OFFICIAL_WORDS.test(title) || /official|кино|film|movie|студия/i.test(item.author?.name || ''),
        title, duration: Number(item.duration) || undefined, context,
      };
    }).filter(Boolean);
  }
}

class TrailerResolver {
  constructor({ providers = [new RutubeProvider(), new YouTubeProvider(), new TmdbProvider(), new VkVideoProvider(), new VimeoProvider()], cache = trailerCache } = {}) { this.providers = providers; this.cache = cache; }
  async resolve(input, { force = false, exclude } = {}) {
    const context = { ...input, tmdbId: Number(input.tmdbId) };
    if (!force) { const cached = await this.cache.findBest(context.tmdbId, context.mediaType, CACHE_HOURS); if (cached) return { found: true, trailer: this.cache.asTrailer(cached), cached: true }; }
    console.debug(`[TrailerResolver] Search: ${context.title || context.originalTitle || context.tmdbId} (${context.year || '—'})`);
    const results = await Promise.all(this.providers.map(async (provider) => {
      try { const candidates = await provider.search(context); console.debug(`[TrailerResolver] ${provider.constructor.name.replace('Provider', '')} candidates: ${candidates.length}`); return candidates; }
      catch (error) { console.warn(`[TrailerResolver] ${provider.constructor.name}: ${error.message}`); return []; }
    }));
    const candidates = results.flat()
      .filter((candidate) => !exclude || candidate.source !== exclude.source || candidate.videoId !== exclude.videoId)
      .map((candidate) => ({ ...candidate, score: scoreCandidate(candidate, context) }))
      .filter((candidate) => candidate.score >= 0).sort((a, b) => (SOURCE_PRIORITY[a.source] ?? 99) - (SOURCE_PRIORITY[b.source] ?? 99) || b.score - a.score);
    if (!candidates.length) return { found: false, trailer: null };
    const winner = candidates[0]; await this.cache.save(context.tmdbId, context.mediaType, winner);
    console.debug(`[TrailerResolver] Selected: ${winner.source} / ${winner.language || 'original'} / ${winner.official ? 'official' : 'unofficial'} / score=${winner.score}`);
    return { found: true, trailer: winner, cached: false };
  }
  async unavailable(input) { await this.cache.markUnavailable(Number(input.tmdbId), input.mediaType, input.source, input.videoId); return this.resolve(input, { force: true, exclude: { source: input.source, videoId: input.videoId } }); }
}

module.exports = { TrailerResolver, TmdbProvider, YouTubeProvider, VkVideoProvider, RutubeProvider, VimeoProvider, scoreCandidate };
