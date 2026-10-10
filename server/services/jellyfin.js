// Jellyfin API — поиск фильмов/сериалов и получение ссылок
const JELLYFIN_URL = process.env.JELLYFIN_URL || '';
const JELLYFIN_PORT = process.env.JELLYFIN_PORT || '';
const JELLYFIN_API_KEY = process.env.JELLYFIN_API_KEY || '';
// An API key can administer Jellyfin but is not a user's playback identity.
// Playback events must use an access token of the user whose UserData should
// receive PlaybackPositionTicks.
const JELLYFIN_USER_TOKEN = process.env.JELLYFIN_USER_TOKEN || '';

let cachedUserId = null;
const lookupCache = new Map();
const LOOKUP_CACHE_TTL_MS = 60 * 1000;

function getBaseUrl() {
  if (!JELLYFIN_URL) throw new Error('Jellyfin не настроен (JELLYFIN_URL)');
  let base = JELLYFIN_URL.startsWith('http') ? JELLYFIN_URL : `http://${JELLYFIN_URL}`;
  // Remove trailing slash
  base = base.replace(/\/+$/, '');
  // Append port only if specified
  if (JELLYFIN_PORT) base += `:${JELLYFIN_PORT}`;
  return base;
}

function jellyfinHeaders(extra = {}) {
  return {
    'X-Emby-Token': JELLYFIN_API_KEY,
    ...extra,
  };
}

function playbackClientHeaders(deviceId) {
  const safeDeviceId = String(deviceId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  if (!safeDeviceId) throw new Error('Некорректный Jellyfin DeviceId');
  return {
    // Jellyfin uses this header to associate Playing/Progress/Stopped events
    // with the same client that requested PlaybackInfo. The API key remains in
    // X-Emby-Token and never leaves KinoLike's backend.
    'X-Emby-Authorization': `MediaBrowser Client="KinoLike", Device="Web Browser", DeviceId="${safeDeviceId}", Version="1.0.0"`,
  };
}

function playbackUserHeaders() {
  return JELLYFIN_USER_TOKEN ? { 'X-Emby-Token': JELLYFIN_USER_TOKEN } : {};
}

function removeApiKeyParameters(url) {
  // Jellyfin uses both api_key and ApiKey depending on endpoint/version.
  // URLSearchParams keys are case-sensitive, so remove every spelling.
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase() === 'api_key' || key.toLowerCase() === 'apikey') url.searchParams.delete(key);
  }
}

async function jellyfinFetch(pathOrUrl, options = {}) {
  if (!JELLYFIN_API_KEY) throw new Error('Jellyfin не настроен (JELLYFIN_API_KEY)');
  const base = getBaseUrl();
  const url = new URL(pathOrUrl, `${base}/`);
  if (url.origin !== new URL(base).origin) throw new Error('Некорректный URL Jellyfin');
  // Старые версии Jellyfin иногда возвращают api_key в TranscodingUrl. Ключ
  // никогда не должен покидать backend, поэтому авторизуемся только заголовком.
  removeApiKeyParameters(url);
  return fetch(url, { ...options, headers: jellyfinHeaders(options.headers) });
}

async function getUserId() {
  if (cachedUserId) return cachedUserId;
  const response = await jellyfinFetch(JELLYFIN_USER_TOKEN ? '/Users/Me' : '/Users', {
    headers: playbackUserHeaders(),
  });
  if (!response.ok) throw new Error(`Jellyfin Users: ${response.status}`);
  const result = await response.json();
  const users = Array.isArray(result) ? result : [result];
  if (!users[0]?.Id) throw new Error('В Jellyfin нет пользователей');
  cachedUserId = users[0].Id;
  return cachedUserId;
}

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('ru')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function itemHasFile(item) {
  return item?.IsVirtualItem !== true
    && item?.LocationType !== 'Virtual'
    && ((Array.isArray(item?.MediaSources) && item.MediaSources.length > 0) || Boolean(item?.Path));
}

function fallbackItemMatches(item, { title, originalTitle, year, mediaType }) {
  if (item?.Type !== (mediaType === 'tv' ? 'Series' : 'Movie')) return false;
  const wantedTitles = [title, originalTitle].map(normalizeTitle).filter(Boolean);
  const jellyfinTitles = [item.Name, item.OriginalTitle].map(normalizeTitle).filter(Boolean);
  if (!wantedTitles.some((candidate) => jellyfinTitles.includes(candidate))) return false;
  const wantedYear = Number(year);
  const itemYear = Number(item.ProductionYear);
  // If KinoLike knows the year, do not accept a title-only fallback: remakes
  // commonly share an exact localized or original name.
  return !wantedYear || (Boolean(itemYear) && wantedYear === itemYear);
}

async function fetchItems(params) {
  const userId = await getUserId();
  const query = new URLSearchParams({
    Recursive: 'true',
    Fields: 'ProviderIds,OriginalTitle,ProductionYear,Path,MediaSources',
    EnableImages: 'false',
    Limit: '50',
    ...params,
  });
  const response = await jellyfinFetch(`/Users/${encodeURIComponent(userId)}/Items?${query}`);
  if (!response.ok) throw new Error(`Jellyfin Items: ${response.status}`);
  return (await response.json()).Items || [];
}

/** Find a movie/series, preferring the stable TMDB ProviderId. */
async function findItem({ tmdbId, mediaType, title, originalTitle, year, useCache = true }) {
  const jellyfinType = mediaType === 'tv' ? 'Series' : 'Movie';
  const cacheKey = `${mediaType}:${tmdbId || ''}:${normalizeTitle(title)}:${Number(year) || ''}`;
  const cached = lookupCache.get(cacheKey);
  if (useCache && cached && cached.expiresAt > Date.now()) return cached.value;

  let found = null;
  if (Number.isInteger(Number(tmdbId)) && Number(tmdbId) > 0) {
    const byProvider = await fetchItems({
      IncludeItemTypes: jellyfinType,
      AnyProviderIdEquals: `Tmdb.${Number(tmdbId)}`,
    });
    found = byProvider.find((item) => String(item.ProviderIds?.Tmdb || '') === String(Number(tmdbId))) || null;
  }

  if (!found) {
    const candidates = [];
    for (const searchTitle of [...new Set([title, originalTitle].filter(Boolean))]) {
      const items = await fetchItems({ IncludeItemTypes: jellyfinType, SearchTerm: String(searchTitle) });
      for (const item of items) if (!candidates.some((entry) => entry.Id === item.Id)) candidates.push(item);
    }
    found = candidates.find((item) => fallbackItemMatches(item, { title, originalTitle, year, mediaType })) || null;
  }

  // Movie must have a concrete media source. A Series is a container and is
  // checked for concrete episodes by the seasons endpoint.
  if (found && mediaType === 'movie' && !itemHasFile(found)) found = null;
  const value = found ? { itemId: found.Id, itemName: found.Name, itemType: found.Type } : null;
  lookupCache.set(cacheKey, { value, expiresAt: Date.now() + LOOKUP_CACHE_TTL_MS });
  return value;
}

// Kept for torrent-library synchronization callers. New UI calls findItem
// with TMDB metadata instead of relying on this title-only compatibility path.
async function searchItem(title, mediaType) {
  try {
    const found = await findItem({ title, mediaType, useCache: false });
    if (!found) return null;
    return {
      ...found,
      playbackItemId: found.itemId,
      jellyfinUrl: `${getBaseUrl()}/web/index.html#/details?id=${found.itemId}`,
    };
  } catch (err) {
    console.error('[Jellyfin] Ошибка поиска:', err.message);
    return null;
  }
}

async function getItem(itemId) {
  const userId = await getUserId();
  const response = await jellyfinFetch(`/Users/${encodeURIComponent(userId)}/Items/${encodeURIComponent(itemId)}?fields=ProviderIds,Path,MediaSources,UserData`);
  if (!response.ok) throw new Error(`Jellyfin Item: ${response.status}`);
  return response.json();
}

async function getPlaybackPosition(itemId) {
  const item = await getItem(itemId);
  const ticks = Number(item.UserData?.PlaybackPositionTicks ?? item.PlaybackPositionTicks ?? 0);
  return Number.isFinite(ticks) && ticks > 0 ? Math.round(ticks) : 0;
}

async function assertSeries(seriesId, tmdbId) {
  const series = await getItem(seriesId);
  if (series.Type !== 'Series' || String(series.ProviderIds?.Tmdb || '') !== String(Number(tmdbId))) {
    throw new Error('Jellyfin Series не соответствует объекту KinoLike');
  }
  return series;
}

async function getSeasonEpisodes(seriesId, seasonId) {
  const userId = await getUserId();
  const query = new URLSearchParams({
    userId,
    seasonId,
    fields: 'Path,MediaSources',
    enableImages: 'false',
  });
  const response = await jellyfinFetch(`/Shows/${encodeURIComponent(seriesId)}/Episodes?${query}`);
  if (!response.ok) throw new Error(`Jellyfin Episodes: ${response.status}`);
  const data = await response.json();
  return (data.Items || [])
    .filter(itemHasFile)
    .map((episode) => ({
      id: episode.Id,
      name: episode.Name || `Эпизод ${episode.IndexNumber || ''}`.trim(),
      season: episode.ParentIndexNumber ?? 0,
      episode: episode.IndexNumber ?? 0,
      seasonId: episode.SeasonId || episode.ParentId || seasonId,
    }))
    .sort((a, b) => a.episode - b.episode);
}

function sortEpisodesForAutoplay(episodes) {
  return [...episodes]
    .filter((episode) => Number(episode.season) > 0)
    .sort((a, b) => Number(a.season) - Number(b.season)
      || Number(a.episode) - Number(b.episode)
      || String(a.id).localeCompare(String(b.id)));
}

async function getSeriesEpisodes(seriesId) {
  const userId = await getUserId();
  const query = new URLSearchParams({
    userId,
    fields: 'Path,MediaSources',
    enableImages: 'false',
  });
  const response = await jellyfinFetch(`/Shows/${encodeURIComponent(seriesId)}/Episodes?${query}`);
  if (!response.ok) throw new Error(`Jellyfin Episodes: ${response.status}`);
  const data = await response.json();
  return sortEpisodesForAutoplay((data.Items || [])
    .filter(itemHasFile)
    .map((episode) => ({
      id: episode.Id,
      name: episode.Name || `Эпизод ${episode.IndexNumber || ''}`.trim(),
      season: episode.ParentIndexNumber ?? 0,
      episode: episode.IndexNumber ?? 0,
      seasonId: episode.SeasonId || episode.ParentId || '',
    })));
}

async function getSeasons(seriesId) {
  const response = await jellyfinFetch(`/Shows/${encodeURIComponent(seriesId)}/Seasons?fields=Path&enableImages=false`);
  if (!response.ok) throw new Error(`Jellyfin Seasons: ${response.status}`);
  const data = await response.json();
  const seasons = [];
  for (const season of data.Items || []) {
    if (season.IsVirtualItem === true || season.LocationType === 'Virtual') continue;
    const episodes = await getSeasonEpisodes(seriesId, season.Id);
    if (!episodes.length) continue;
    seasons.push({
      id: season.Id,
      name: (season.IndexNumber ?? 0) === 0 ? 'Спецвыпуски' : (season.Name || `Сезон ${season.IndexNumber}`),
      number: season.IndexNumber ?? 0,
    });
  }
  return seasons.sort((a, b) => a.number - b.number);
}

async function validatePlaybackItem(itemId, tmdbId, mediaType) {
  const item = await getItem(itemId);
  if (mediaType === 'movie') {
    if (item.Type !== 'Movie' || String(item.ProviderIds?.Tmdb || '') !== String(Number(tmdbId)) || !itemHasFile(item)) {
      throw new Error('Jellyfin ItemId не соответствует фильму KinoLike');
    }
    return item;
  }
  if (item.Type !== 'Episode' || !itemHasFile(item) || !item.SeriesId) throw new Error('Для сериала требуется доступный Episode ItemId');
  await assertSeries(item.SeriesId, tmdbId);
  return item;
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
    const resp = await jellyfinFetch('/Library/Refresh', {
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
    const resp = await jellyfinFetch('/System/Info');
    return resp.ok;
  } catch {
    return false;
  }
}

function isValidDeviceProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return false;
  if (JSON.stringify(profile).length > 100000) return false;
  const requiredArrays = ['DirectPlayProfiles', 'TranscodingProfiles', 'CodecProfiles', 'SubtitleProfiles'];
  return requiredArrays.every((key) => Array.isArray(profile[key]));
}

async function getEpisodes(seriesId) {
  const userId = await getUserId();
  const response = await jellyfinFetch(`/Shows/${encodeURIComponent(seriesId)}/Episodes?userId=${encodeURIComponent(userId)}&fields=MediaSources,MediaStreams&enableImages=false`);
  if (!response.ok) throw new Error(`Jellyfin Episodes: ${response.status}`);
  const data = await response.json();
  return (data.Items || []).map((episode) => ({
    id: episode.Id,
    name: episode.Name,
    season: episode.ParentIndexNumber ?? 0,
    episode: episode.IndexNumber ?? 0,
  }));
}

function streamLabel(stream) {
  const language = stream.DisplayLanguage || stream.Language || 'Не указан';
  const title = stream.Title && !String(stream.Title).toLowerCase().includes(String(language).toLowerCase())
    ? ` — ${stream.Title}` : '';
  const codec = String(stream.Codec || '').toUpperCase();
  const channels = stream.ChannelLayout || (stream.Channels ? `${stream.Channels}.0` : '');
  return `${language}${title}${codec ? ` — ${codec}` : ''}${channels ? ` ${channels}` : ''}`;
}

function playbackDiagnostics(itemName, browser, source, audioStream, videoStream) {
  let transcodingParams;
  try {
    transcodingParams = source.TranscodingUrl ? new URL(source.TranscodingUrl, 'http://jellyfin.local').searchParams : null;
  } catch {
    transcodingParams = null;
  }
  const urlReasons = (transcodingParams?.get('TranscodeReasons') || '').split(',').filter(Boolean);
  const reasons = [...new Set([...(source.TranscodingReasons || []), ...urlReasons])];
  const hasTranscodingUrl = Boolean(source.TranscodingUrl);
  const targetVideoCodecs = (transcodingParams?.get('VideoCodec') || 'h264').split(',').map((codec) => codec.toLowerCase());
  const targetAudioCodecs = (transcodingParams?.get('AudioCodec') || 'aac').split(',').map((codec) => codec.toLowerCase());
  const sourceVideoCodec = String(videoStream?.Codec || '').toLowerCase();
  const sourceAudioCodec = String(audioStream?.Codec || '').toLowerCase();
  const videoMustTranscode = reasons.some((reason) => /VideoCodec|VideoProfile|VideoLevel|VideoRange|BitDepth|RefFrames|Width|Height|Bitrate/i.test(reason))
    || (hasTranscodingUrl && sourceVideoCodec && !targetVideoCodecs.includes(sourceVideoCodec));
  const audioMustTranscode = reasons.some((reason) => /AudioCodec|AudioChannels|AudioProfile|AudioBitrate/i.test(reason))
    || (hasTranscodingUrl && sourceAudioCodec && !targetAudioCodecs.includes(sourceAudioCodec));
  const directPlay = !hasTranscodingUrl;
  const targetVideo = (transcodingParams?.get('VideoCodec') || 'h264').split(',')[0].toUpperCase();
  const targetAudio = (transcodingParams?.get('AudioCodec') || 'aac').split(',')[0].toUpperCase();
  const videoMode = directPlay ? 'Direct Play / Copy' : videoMustTranscode ? `Transcode ${String(videoStream?.Codec || '?').toUpperCase()} → ${targetVideo}` : 'Direct Stream / Copy';
  const audioMode = directPlay ? 'Direct Play / Copy' : audioMustTranscode ? `Transcode ${String(audioStream?.Codec || '?').toUpperCase()} → ${targetAudio}` : 'Copy';
  return {
    item: itemName,
    browser,
    container: String(source.Container || '').toUpperCase(),
    video: String(videoStream?.Codec || '').toUpperCase(),
    audio: String(audioStream?.Codec || '').toUpperCase(),
    videoMode,
    audioMode,
    protocol: hasTranscodingUrl ? 'HLS' : 'HTTP',
    reasons,
  };
}

async function getPlaybackInfo(itemId, options) {
  if (!isValidDeviceProfile(options.deviceProfile)) throw new Error('Некорректный DeviceProfile');
  const userId = await getUserId();
  const body = {
    UserId: userId,
    DeviceProfile: options.deviceProfile,
    DeviceId: options.deviceId,
    MediaSourceId: options.mediaSourceId || undefined,
    AudioStreamIndex: Number.isInteger(options.audioStreamIndex) ? options.audioStreamIndex : undefined,
    SubtitleStreamIndex: Number.isInteger(options.subtitleStreamIndex) ? options.subtitleStreamIndex : -1,
    // This is deliberately part of PlaybackInfo, rather than a seek after the
    // manifest has been attached.  For STRM/TorrServer that makes Jellyfin
    // open the source at the requested byte/time range.
    StartTimeTicks: Number.isSafeInteger(options.startTimeTicks) && options.startTimeTicks > 0 ? options.startTimeTicks : undefined,
    EnableDirectPlay: true,
    EnableDirectStream: true,
    EnableTranscoding: true,
    AllowVideoStreamCopy: true,
    AllowAudioStreamCopy: true,
  };
  // Jellyfin Web supplies these as query parameters.  Keep StartTimeTicks in
  // the DTO as well: older server versions bind it from the query, while the
  // current API also exposes it on PlaybackInfoDto.
  const playbackInfoQuery = new URLSearchParams({
    userId,
    StartTimeTicks: String(body.StartTimeTicks || 0),
    IsPlayback: 'true',
    AutoOpenLiveStream: 'true',
  });
  const response = await jellyfinFetch(`/Items/${encodeURIComponent(itemId)}/PlaybackInfo?${playbackInfoQuery}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...playbackClientHeaders(options.deviceId) },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Jellyfin PlaybackInfo ${response.status}: ${message.slice(0, 300)}`);
  }
  const playback = await response.json();
  const sources = playback.MediaSources || [];
  const source = sources.find((entry) => entry.Id === options.mediaSourceId) || sources[0];
  if (!source) throw new Error('Jellyfin не вернул источник воспроизведения');
  const streams = source.MediaStreams || [];
  const audioStreams = streams.filter((stream) => stream.Type === 'Audio');
  const subtitleStreams = streams.filter((stream) => stream.Type === 'Subtitle');
  const videoStream = streams.find((stream) => stream.Type === 'Video');
  const audioStream = audioStreams.find((stream) => stream.Index === options.audioStreamIndex)
    || audioStreams.find((stream) => stream.Index === source.DefaultAudioStreamIndex)
    || audioStreams[0];
  const selectedSubtitle = subtitleStreams.find((stream) => stream.Index === options.subtitleStreamIndex);
  const rawUpstreamPath = source.TranscodingUrl || `/Videos/${encodeURIComponent(itemId)}/stream?Static=true&mediaSourceId=${encodeURIComponent(source.Id)}&deviceId=${encodeURIComponent(options.deviceId)}&playSessionId=${encodeURIComponent(playback.PlaySessionId || '')}`;
  const safeUpstreamUrl = resolveUpstreamPath(rawUpstreamPath);
  const isHls = /\.m3u8(?:\?|$)/i.test(safeUpstreamUrl.pathname) || String(source.TranscodingSubProtocol).toLowerCase() === 'hls';
  // StartTimeTicks is negotiated in PlaybackInfo above. Do not append it to
  // Jellyfin's returned TranscodingUrl: the parameter is propagated into HLS
  // child segment URLs, where this Jellyfin version rejects it with HTTP 400.
  const upstreamPath = `${safeUpstreamUrl.pathname}${safeUpstreamUrl.search}`;
  const type = isHls ? 'm3u8' : 'video';
  const subtitleCanBeExternal = selectedSubtitle && !selectedSubtitle.IsExternalUrl
    && !['pgssub', 'pgs', 'dvdsub', 'dvbsub', 'vobsub'].includes(String(selectedSubtitle.Codec || '').toLowerCase());
  const subtitlePath = subtitleCanBeExternal
    ? `/Videos/${encodeURIComponent(itemId)}/${encodeURIComponent(source.Id)}/Subtitles/${selectedSubtitle.Index}/Stream.vtt`
    : null;
  const diagnostics = playbackDiagnostics(options.itemName || itemId, options.browser || 'Unknown', source, audioStream, videoStream);

  console.info('[Jellyfin Playback]\n' + [
    `Item: ${diagnostics.item}`,
    `Browser: ${diagnostics.browser}`,
    `MediaSourceId: ${source.Id}`,
    `PlaySessionId: ${playback.PlaySessionId}`,
    `StartTimeTicks: ${body.StartTimeTicks || 0}`,
    `AudioStream: ${audioStream?.Index ?? 'default'}`,
    `SubtitleStream: ${selectedSubtitle?.Index ?? -1}`,
    `HLS URL: ${type === 'm3u8' ? upstreamPath : 'n/a'}`,
    `Container: ${diagnostics.container}`,
    `Video: ${diagnostics.video}`,
    `Audio: ${diagnostics.audio}`,
    'Playback:',
    `Video → ${diagnostics.videoMode}`,
    `Audio → ${diagnostics.audioMode}`,
    `Protocol → ${diagnostics.protocol}`,
    diagnostics.reasons.length ? `Reasons → ${diagnostics.reasons.join(', ')}` : '',
  ].filter(Boolean).join('\n'));

  return {
    playSessionId: playback.PlaySessionId,
    mediaSourceId: source.Id,
    startSeconds: body.StartTimeTicks ? body.StartTimeTicks / 10_000_000 : 0,
    runtimeSeconds: Number(source.RunTimeTicks || 0) / 10_000_000,
    upstreamPath,
    type,
    audioStreamIndex: audioStream?.Index ?? null,
    subtitleStreamIndex: selectedSubtitle?.Index ?? -1,
    audioTracks: audioStreams.map((stream) => ({ index: stream.Index, label: streamLabel(stream), codec: stream.Codec, language: stream.Language, channels: stream.Channels })),
    subtitleTracks: subtitleStreams.map((stream) => ({ index: stream.Index, label: streamLabel(stream), codec: stream.Codec, language: stream.Language, external: Boolean(stream.IsExternal) })),
    subtitlePath,
    diagnostics,
    playMethod: source.TranscodingUrl ? 'Transcode' : 'DirectPlay',
  };
}

function secondsToTicks(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 10_000_000);
}

function buildPlaybackEvent(session, { positionSeconds = 0, isPaused = false } = {}) {
  return {
    ItemId: session.jellyfin_item_id,
    MediaSourceId: session.media_source_id,
    PlaySessionId: session.play_session_id,
    PositionTicks: secondsToTicks(positionSeconds),
    PlayMethod: session.play_method || 'DirectPlay',
    CanSeek: true,
    IsPaused: Boolean(isPaused),
    AudioStreamIndex: Number.isInteger(session.audio_stream_index) ? session.audio_stream_index : undefined,
    SubtitleStreamIndex: Number.isInteger(session.subtitle_stream_index) ? session.subtitle_stream_index : undefined,
  };
}

function buildPlaybackStopEvent(session, { positionSeconds = 0, failed = false } = {}) {
  return {
    ItemId: session.jellyfin_item_id,
    MediaSourceId: session.media_source_id,
    PlaySessionId: session.play_session_id,
    PositionTicks: secondsToTicks(positionSeconds),
    Failed: Boolean(failed),
  };
}

async function reportPlayback(path, session, state, payloadBuilder = buildPlaybackEvent) {
  if (!JELLYFIN_USER_TOKEN) {
    console.warn('[Playback] JELLYFIN_USER_TOKEN is not configured; an API key may acknowledge playback events without updating UserData.PlaybackPositionTicks');
  }
  const payload = {
    ...payloadBuilder(session, state),
    // The server-side API key may be administrative. Explicitly bind reports
    // to the Jellyfin user whose UserData supplies PlaybackPositionTicks.
    UserId: await getUserId(),
  };
  const eventName = path.endsWith('/Stopped') ? 'Stop' : path.endsWith('/Progress') ? 'Progress' : 'Start';
  console.info(`[Playback ${eventName}]\nItemId: ${payload.ItemId}\nMediaSourceId: ${payload.MediaSourceId}\nPlaySessionId: ${payload.PlaySessionId}\nPositionTicks: ${payload.PositionTicks}\nIsPaused: ${payload.IsPaused ?? false}`);
  const response = await jellyfinFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...playbackClientHeaders(session.device_id), ...playbackUserHeaders() },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Jellyfin ${path} ${response.status}: ${message.slice(0, 300)}`);
  }
}

const reportPlaybackStart = (session, state) => reportPlayback('/Sessions/Playing', session, state);
const reportPlaybackProgress = (session, state) => reportPlayback('/Sessions/Playing/Progress', session, state);
const reportPlaybackStopped = (session, state) => reportPlayback('/Sessions/Playing/Stopped', session, state, buildPlaybackStopEvent);

function resolveUpstreamPath(pathOrUrl) {
  const base = getBaseUrl();
  const url = new URL(pathOrUrl, `${base}/`);
  if (url.origin !== new URL(base).origin) throw new Error('Некорректный URL Jellyfin');
  removeApiKeyParameters(url);
  return url;
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

module.exports = {
  findItem,
  searchItem,
  refreshLibrary,
  checkStatus,
  waitForItem,
  getEpisodes,
  getSeasons,
  getSeasonEpisodes,
  getSeriesEpisodes,
  assertSeries,
  validatePlaybackItem,
  getItem,
  getPlaybackPosition,
  getPlaybackInfo,
  reportPlaybackStart,
  reportPlaybackProgress,
  reportPlaybackStopped,
  jellyfinFetch,
  resolveUpstreamPath,
  playbackDiagnostics,
  normalizeTitle,
  fallbackItemMatches,
  itemHasFile,
  sortEpisodesForAutoplay,
  secondsToTicks,
  buildPlaybackEvent,
  buildPlaybackStopEvent,
};
