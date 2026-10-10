import type { ExtendedStatistics, ListStatus, MediaType, Movie, PersonWork, User, WrappedStatistics } from '../types';

type Json = Record<string, any>;
export type TmdbItem = Json & { id: number; media_type?: MediaType | 'person'; title?: string; name?: string; release_date?: string; first_air_date?: string; profile_path?: string; known_for_department?: string; genre_ids?: number[] };
type ListItem = Json & { id: number; tmdb_id: number; media_type: MediaType; status: ListStatus; details?: Json | null };
export type JellyfinEpisode = { id: string; name: string; season: number; episode: number; seasonId?: string };
export type JellyfinSeason = { id: string; name: string; number: number };
export type JellyfinCheck = { found: boolean; itemId?: string; title?: string; itemType?: 'Movie' | 'Series' };
export type JellyfinTrack = { index: number; label: string; codec: string; language?: string; channels?: number };
export type JellyfinPlayback = {
  url: string;
  type: 'm3u8' | 'video';
  mediaSourceId: string;
  playSessionId: string;
  /** Position used to create this Jellyfin stream, in seconds. */
  startSeconds: number;
  runtimeSeconds: number;
  audioStreamIndex: number | null;
  subtitleStreamIndex: number;
  audioTracks: JellyfinTrack[];
  subtitleTracks: JellyfinTrack[];
  subtitleUrl: string | null;
  diagnostics: { item: string; browser: string; container: string; video: string; audio: string; videoMode: string; audioMode: string; protocol: string; reasons: string[] };
};
export type JellyfinWatchPosition = { position: number; duration: number; cleared?: boolean };
export type JellyfinLifecycleEvent = {
  playSessionId: string;
  clientSessionId: string;
  position: number;
  duration: number;
  isPaused?: boolean;
  reason?: string;
};
export type PhantomVoice = { id: string; name: string; quality?: string };
export type PhantomEpisode = { id: string; season: number; episode: number; name: string; voice?: string };
export type PhantomCheck = { available: boolean; unavailable?: boolean; source: 'phantom' | 'videohub'; type?: 'movie' | 'series'; voices?: PhantomVoice[]; seasons?: number[] };
export type PhantomPlayback = { url: string; type: 'm3u8'; source?: 'phantom' | 'videohub'; season?: number | null; episode?: number | null; translation?: string | null };
export type PhantomWatchPosition = { position: number; duration: number; updatedAt: string | null; revision: number; completed: boolean; translationId: string | null };
export type StreamingSegment = { start: number; end: number };
export type StreamingSegments = { intro: StreamingSegment | null; credits: StreamingSegment | null; source: string };
export type PhantomContinuePosition = { tmdbId: number; mediaType: MediaType; season: number | null; episode: number | null; position: number; duration: number; translationId: string | null; updatedAt: string };
export type ReviewSummary = { summary: string | null; sourceCount: number; language?: string; cached?: boolean; generatedAt?: string };
export type Trailer = { source: 'youtube' | 'vk' | 'rutube' | 'vimeo'; videoId?: string | null; url: string; embedUrl?: string | null; language?: string | null; type?: string | null; official: boolean; title?: string | null; score: number };
export type RecommendationItem = Json & { tmdb_id: number; media_type: MediaType; recommendation_id?: number; structured_reasons?: Json };
export type StreamingTrendingItem = { position: number; tmdbId: number; mediaType: MediaType };
export type StreamingTrending = { service: 'kion' | 'wink' | 'premier'; updatedAt: string | null; items: StreamingTrendingItem[]; unavailable?: boolean };

export const imageUrl = (path: unknown, size = 'w342') =>
  typeof path === 'string' && path ? `/api/tmdb/image?path=${encodeURIComponent(path)}&size=${size}` : '';

export function toMovie(raw: Json | null | undefined, mediaType?: MediaType): Movie {
  const item = raw || {};
  const type = (mediaType || item.media_type || (item.title ? 'movie' : 'tv')) as MediaType;
  const title = String(item.title || item.name || 'Без названия');
  const date = String(item.release_date || item.first_air_date || '');
  const genres = Array.isArray(item.genres)
    ? item.genres.map((genre: any) => typeof genre === 'object' && genre ? String(genre.name || '') : String(genre)).filter(Boolean)
    : Array.isArray(item.genre_names) ? item.genre_names.map(String) : [];
  const crew = item.credits?.crew;
  const castData = item.credits?.cast;
  const director = Array.isArray(crew) ? String(crew.find((person: any) => person.job === 'Director')?.name || '') : String(item.director || '');
  const cast = Array.isArray(castData) ? castData.slice(0, 6).map((person: any) => String(person.name || '')).filter(Boolean) : Array.isArray(item.cast) ? item.cast.map(String) : [];
  const duration = type === 'tv' ? (item.number_of_seasons ? `${item.number_of_seasons} сез.` : '') : (item.runtime ? `${Math.floor(Number(item.runtime) / 60)} ч ${Number(item.runtime) % 60} мин` : '');

  return {
    id: Number(item.id), mediaType: type, title, originalTitle: String(item.original_title || item.original_name || ''),
    year: Number(date.slice(0, 4)) || 0, duration, seasons: Number(item.number_of_seasons) || undefined, rating: Number(item.vote_average) || 0,
    votes: item.vote_count ? `${Number(item.vote_count).toLocaleString('ru-RU')} оценок` : '', genres,
    poster: imageUrl(item.poster_path), posterPath: String(item.poster_path || ''), backdrop: imageUrl(item.backdrop_path, 'w1280'), backdropPath: String(item.backdrop_path || ''), overview: String(item.overview || ''),
    tagline: String(item.tagline || ''), director, cast,
    imdbId: item.imdb_id ? String(item.imdb_id) : undefined,
    imdbRating: item.imdb_rating === null || item.imdb_rating === undefined ? undefined : Number(item.imdb_rating),
    imdbVotes: item.imdb_votes === null || item.imdb_votes === undefined ? undefined : Number(item.imdb_votes),
    imdbUpdatedAt: item.imdb_updated_at ? String(item.imdb_updated_at) : undefined,
  };
}

function queryString(params: Record<string, string | number | undefined>) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => value !== undefined && query.set(key, String(value)));
  const result = query.toString();
  return result ? `?${result}` : '';
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const token = window.localStorage.getItem('authToken');
  const headers = new Headers(options.headers);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(url, { credentials: 'include', ...options, headers });
  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 401 && text.includes('INVALID_TOKEN')) window.localStorage.removeItem('authToken');
    let message = response.status === 401 ? 'Требуется авторизация' : response.status === 403 ? 'Недостаточно прав для этого действия' : response.status === 404 ? 'Запрошенные данные не найдены' : response.status >= 500 ? 'Сервис временно недоступен. Попробуйте ещё раз.' : 'Не удалось выполнить запрос';
    try {
      const payload: unknown = text ? JSON.parse(text) : null;
      if (payload && typeof payload === 'object') {
        const error = 'error' in payload ? payload.error : undefined;
        if (typeof error === 'string' && error.length <= 240) message = error;
        else if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' && error.message.length <= 240) message = error.message;
      }
    } catch { /* Non-JSON error bodies are intentionally not exposed to users. */ }
    throw new Error(message);
  }
  if (!contentType.includes('application/json')) {
    throw new Error('Сервис вернул некорректный ответ. Попробуйте ещё раз.');
  }
  let data: Json;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error('Сервис вернул некорректный ответ. Попробуйте ещё раз.');
  }
  if (url === '/api/auth/me' || url === '/api/auth/login' || url === '/api/auth/register') window.localStorage.removeItem('authToken');
  return data as T;
}

export const api = {
  home: {
    russianNew: () => request<{ results: TmdbItem[]; generatedAt?: string; unavailable?: boolean }>('/api/home/russian-new'),
  },
  trending: {
    streaming: (service: StreamingTrending['service']) => request<StreamingTrending>(`/api/trending/streaming?service=${encodeURIComponent(service)}`),
  },
  auth: {
    me: () => request<{ user: User }>('/api/auth/me'),
    login: (email: string, password: string) => request<{ user: User }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
    register: (username: string, email: string, password: string) => request<{ user: User }>('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, email, password }) }),
    logout: () => request<{ message: string }>('/api/auth/logout', { method: 'POST' }),
    updateProfile: (data: Partial<Pick<User, 'username' | 'email' | 'avatar_url' | 'preferred_streaming_source'>>) => request<{ user: User }>('/api/auth/profile', { method: 'PUT', body: JSON.stringify(data) }),
    changePassword: (currentPassword: string, newPassword: string) => request<{ message: string }>('/api/auth/password', { method: 'PUT', body: JSON.stringify({ currentPassword, newPassword }) }),
  },
  admin: {
    users: () => request<{ users: User[] }>('/api/admin/users'),
    setJellyfinEnabled: (id: number, enabled: boolean) => request<{ user: User }>(`/api/admin/users/${id}/jellyfin`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
  },
  lists: {
    get: (status?: ListStatus, params: Record<string, string | number | undefined> = {}) => request<{ items: ListItem[] }>('/api/lists' + queryString({ ...params, status })),
    getItem: (mediaType: MediaType, tmdbId: number) => request<{ item: ListItem | null }>(`/api/lists/item/${mediaType}/${tmdbId}`),
    add: (tmdb_id: number, media_type: MediaType, status: ListStatus = 'want_to_watch') => request<{ item: ListItem }>('/api/lists', { method: 'POST', body: JSON.stringify({ tmdb_id, media_type, status }) }),
    update: (id: number, data: Partial<Pick<ListItem, 'status' | 'rating' | 'notes' | 'watched_at'>>) => request<{ item: ListItem }>(`/api/lists/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    remove: (id: number) => request<{ message: string }>(`/api/lists/${id}`, { method: 'DELETE' }),
    exportAll: () => request<ListItem[]>('/api/lists/export'),
    importAll: (items: unknown[]) => request<{ message: string; count: number }>('/api/lists/import', { method: 'POST', body: JSON.stringify({ items }) }),
  },
  watched: {
    get: (params: Record<string, string | number | undefined> = {}) => request<{ items: ListItem[] }>('/api/watched' + queryString(params)),
    rate: (id: number, data: { rating?: number | null; notes?: string; watched_at?: string }) => request<{ item: ListItem }>(`/api/watched/${id}/rate`, { method: 'PUT', body: JSON.stringify(data) }),
    stats: () => request<{ total: number; movies: number; tv: number; avgRating: number }>('/api/watched/stats'),
  },
  stats: {
    overview: () => request<{ total: number; counts: Record<string, number>; avgRating: number }>('/api/stats/overview'),
    extended: () => request<ExtendedStatistics>('/api/stats/extended'),
    wrapped: (year: number) => request<WrappedStatistics>(`/api/stats/wrapped/${year}`),
  },
  tasteProfile: {
    get: (refresh = false) => request<{ profile: Json }>(`/api/taste-profile${refresh ? '?refresh=true' : ''}`),
    update: (preferences: Json) => request<{ preferences: Json }>('/api/taste-profile/preferences', { method: 'PUT', body: JSON.stringify(preferences) }),
  },
  tmdb: {
    search: (query: string, type = 'multi', page = 1, filters: { year?: string; sort?: string } = {}) => request<{ results: TmdbItem[]; total_pages: number; total_results: number }>(`/api/tmdb/search${queryString({ query, type, page, ...filters })}`),
    catalog: (params: Record<string, string | number | undefined>) => request<{ results: TmdbItem[]; total_pages: number; total_results: number }>(`/api/tmdb/catalog${queryString(params)}`),
    popular: () => request<{ results: TmdbItem[] }>('/api/tmdb/movie/popular'),
    popularTv: () => request<{ results: TmdbItem[] }>('/api/tmdb/tv/popular'),
    trending: (type: MediaType) => request<{ results: TmdbItem[] }>(`/api/tmdb/trending/${type}/week`),
    nowPlaying: () => request<{ results: TmdbItem[] }>('/api/tmdb/movie/now_playing'),
    upcoming: () => request<{ results: TmdbItem[] }>('/api/tmdb/movie/upcoming'),
    topRated: () => request<{ results: TmdbItem[] }>('/api/tmdb/movie/top_rated'),
    detail: (type: MediaType, id: number) => request<Json>(`/api/tmdb/${type}/${id}`),
    similar: (type: MediaType, id: number) => request<{ results: TmdbItem[] }>(`/api/tmdb/${type}/${id}/similar`),
    reviewSummary: (type: MediaType, id: number) => request<ReviewSummary>(`/api/tmdb/${type}/${id}/review-summary`),
    person: (id: number) => request<Json>(`/api/tmdb/person/${id}`),
    refreshMetadata: (type: MediaType, id: number) => request<Json>(`/api/tmdb/metadata/${type}/${id}`, { method: 'DELETE' }),
    genres: () => request<{ movie: { id: number; name: string }[]; tv: { id: number; name: string }[] }>('/api/tmdb/genres'),
  },
  trailers: {
    get: (type: MediaType, tmdbId: number) => request<{ found: boolean; trailer: Trailer | null; cached?: boolean }>(`/api/trailers/${type}/${tmdbId}`),
    unavailable: (type: MediaType, tmdbId: number, trailer: Pick<Trailer, 'source' | 'videoId'>) => request<{ found: boolean; trailer: Trailer | null }>(`/api/trailers/${type}/${tmdbId}/unavailable`, { method: 'POST', body: JSON.stringify(trailer) }),
  },
  recommendations: {
    get: (refresh = false) => request<{ recommendations: (Json & { tmdb_id: number; media_type: MediaType })[]; pending?: boolean }>(`/api/recommendations${refresh ? '?refresh=true' : ''}`),
    generate: () => request<{ recommendations: Json[] }>('/api/recommendations/generate', { method: 'POST' }),
    custom: (query: string) => request<{ recommendations: (Json & { tmdb_id: number; media_type: MediaType })[] }>('/api/recommendations/search', { method: 'POST', body: JSON.stringify({ query }) }),
    genres: () => request<{ collections: { key: string; title: string; media_type: MediaType; items: TmdbItem[] }[] }>('/api/recommendations/genres'),
    favoriteGenre: () => request<{ collection: { title: string; media_type: MediaType; items: TmdbItem[] } | null }>('/api/recommendations/favorite-genre'),
    discover: (params: Record<string, string | number | undefined>) => request<{ items: TmdbItem[]; total_results: number; total_pages: number }>(`/api/recommendations/discover${queryString(params)}`),
    clearCache: () => request<{ message: string }>('/api/recommendations/cache', { method: 'DELETE' }),
    ask: (query: string) => request<{ query: string; recommendations: RecommendationItem[] }>('/api/recommendations/ask', { method: 'POST', body: JSON.stringify({ query }) }),
    more: (query: string, exclude: { tmdb_id: number; media_type: MediaType }[]) => request<{ query: string; recommendations: RecommendationItem[] }>('/api/recommendations/more', { method: 'POST', body: JSON.stringify({ query, exclude }) }),
    feedback: (data: { tmdb_id: number; media_type: MediaType; recommendation_id?: number; action: string; reason?: string }) => request<Json>('/api/recommendations/feedback', { method: 'POST', body: JSON.stringify(data) }),
    collections: () => request<{ collections: { key: string; title: string; items: RecommendationItem[] }[] }>('/api/recommendations/collections'),
    history: () => request<{ items: Json[] }>('/api/recommendations/history'),
  },
  streaming: {
    search: (query: string, type: MediaType) => request<{ results: Json[] }>('/api/streaming/search', { method: 'POST', body: JSON.stringify({ query, type }) }),
    play: (magnet: string, title: string, poster: string, tmdbId: number, mediaType: MediaType, fileIndex = 0) => request<Json>('/api/streaming/play', { method: 'POST', body: JSON.stringify({ magnet, title, poster, tmdbId, mediaType, fileIndex }) }),
    files: (hash: string) => request<{ files: { id: number; name: string; size: number }[] }>('/api/streaming/files', { method: 'POST', body: JSON.stringify({ hash }) }),
    saveSeries: (data: { hash: string; title: string; season?: number; files: { id: number; name: string }[]; tmdbId: number }) => request<Json>('/api/streaming/save-series', { method: 'POST', body: JSON.stringify(data) }),
    info: (hash: string) => request<Json>('/api/streaming/info', { method: 'POST', body: JSON.stringify({ hash }) }),
    status: () => request<Json>('/api/streaming/status'),
    getLink: (type: MediaType, tmdbId: number) => request<{ link: Json | null }>(`/api/streaming/link/${type}/${tmdbId}`),
    deleteLink: (type: MediaType, tmdbId: number) => request<Json>(`/api/streaming/link/${type}/${tmdbId}`, { method: 'DELETE' }),
    refreshJellyfin: (type: MediaType, tmdbId: number) => request<Json>(`/api/streaming/refresh-jellyfin/${type}/${tmdbId}`, { method: 'POST' }),
    checkJellyfin: (data: { tmdbId: number; mediaType: MediaType; title: string; originalTitle?: string; year?: number }) => request<JellyfinCheck>('/api/streaming/jellyfin/check' + queryString({ tmdb_id: data.tmdbId, media_type: data.mediaType, title: data.title, original_title: data.originalTitle, year: data.year })),
    jellyfinSeasons: (seriesId: string, tmdbId: number) => request<{ seasons: JellyfinSeason[] }>(`/api/streaming/jellyfin/series/${encodeURIComponent(seriesId)}/seasons${queryString({ tmdb_id: tmdbId })}`),
    jellyfinSeriesEpisodes: (seriesId: string, tmdbId: number) => request<{ episodes: JellyfinEpisode[] }>(`/api/streaming/jellyfin/series/${encodeURIComponent(seriesId)}/episodes${queryString({ tmdb_id: tmdbId })}`),
    jellyfinEpisodes: (seriesId: string, seasonId: string, tmdbId: number) => request<{ episodes: JellyfinEpisode[] }>(`/api/streaming/jellyfin/series/${encodeURIComponent(seriesId)}/seasons/${encodeURIComponent(seasonId)}/episodes${queryString({ tmdb_id: tmdbId })}`),
    resolveJellyfin: (type: MediaType, tmdbId: number) => request<{ itemId: string; seriesId: string | null; title: string; episodes: JellyfinEpisode[] }>(`/api/streaming/jellyfin/resolve/${type}/${tmdbId}`),
    jellyfinPlayback: (itemId: string, data: Json & { startTimeTicks?: number }) => request<JellyfinPlayback>(`/api/streaming/jellyfin/playback/${encodeURIComponent(itemId)}`, { method: 'POST', body: JSON.stringify(data) }),
    startJellyfinPlayback: (data: JellyfinLifecycleEvent) => request<{ ok: boolean; state: string }>('/api/streaming/jellyfin/session/start', { method: 'POST', body: JSON.stringify(data) }),
    progressJellyfinPlayback: (data: JellyfinLifecycleEvent, keepalive = false) => request<{ ok: boolean; state: string }>('/api/streaming/jellyfin/session/progress', { method: 'POST', body: JSON.stringify(data), keepalive }),
    stopJellyfinPlayback: (data: JellyfinLifecycleEvent, keepalive = false) => request<{ ok: boolean; stopped: boolean; alreadyStopped: boolean }>('/api/streaming/jellyfin/session/stop', { method: 'POST', body: JSON.stringify(data), keepalive }),
    jellyfinProgress: (itemId: string) => request<JellyfinWatchPosition>(`/api/streaming/jellyfin/progress/${encodeURIComponent(itemId)}`),
    segments: (data: { tmdbId: number; imdbId?: string; mediaType: MediaType; season?: number; episode?: number; duration: number }) => request<StreamingSegments>('/api/streaming/segments' + queryString({ tmdb_id: data.tmdbId, imdb_id: data.imdbId, media_type: data.mediaType, season: data.season, episode: data.episode, duration: data.duration })),
    phantomCheck: (data: { tmdbId: number; mediaType: MediaType; title: string; originalTitle?: string; imdbId?: string; kinopoiskId?: string; year?: number; originalLanguage?: string }) => request<PhantomCheck>('/api/streaming/phantom/check' + queryString({ tmdb_id: data.tmdbId, media_type: data.mediaType, title: data.title, original_title: data.originalTitle, imdb_id: data.imdbId, kinopoisk_id: data.kinopoiskId, year: data.year, original_language: data.originalLanguage })),
    phantomVoices: (data: { tmdbId: number; title: string; originalTitle?: string; imdbId?: string; kinopoiskId?: string; year?: number; season: number; source?: 'phantom' | 'videohub' }) => request<{ available: boolean; source: 'phantom' | 'videohub'; voices: PhantomVoice[] }>('/api/streaming/phantom/voices' + queryString({ tmdb_id: data.tmdbId, media_type: 'tv', title: data.title, original_title: data.originalTitle, imdb_id: data.imdbId, kinopoisk_id: data.kinopoiskId, year: data.year, season: data.season, source: data.source })),
    phantomEpisodes: (data: { tmdbId: number; title: string; originalTitle?: string; imdbId?: string; kinopoiskId?: string; year?: number; season: number; translationId: string; source?: 'phantom' | 'videohub' }) => request<{ available: boolean; source: 'phantom' | 'videohub'; episodes: PhantomEpisode[] }>('/api/streaming/phantom/episodes' + queryString({ tmdb_id: data.tmdbId, media_type: 'tv', title: data.title, original_title: data.originalTitle, imdb_id: data.imdbId, kinopoisk_id: data.kinopoiskId, year: data.year, season: data.season, translation_id: data.translationId, source: data.source })),
    phantomPlayback: (data: Json & { tmdb_id: number; media_type: MediaType; title: string; season?: number; translation_id?: string; episode?: number }) => request<PhantomPlayback>('/api/streaming/phantom/playback', { method: 'POST', body: JSON.stringify({
      ...data,
      // The streaming backend contract is snake_case.  Metadata originates
      // from the React model, where these fields are camelCase.
      imdb_id: data.imdb_id ?? data.imdbId,
      kinopoisk_id: data.kinopoisk_id ?? data.kinopoiskId,
      original_title: data.original_title ?? data.originalTitle,
      original_language: data.original_language ?? data.originalLanguage,
    }) }),
    phantomProgress: (data: { tmdbId: number; mediaType: MediaType; season?: number; episode?: number }) => request<PhantomWatchPosition>('/api/streaming/progress' + queryString(data)),
    phantomContinue: () => request<{ items: PhantomContinuePosition[] }>('/api/streaming/progress/continue'),
    removePhantomProgress: (data: { tmdbId: number; mediaType: MediaType; season?: number; episode?: number }) => request<{ ok: boolean }>('/api/streaming/progress' + queryString(data), { method: 'DELETE' }),
    savePhantomProgress: (data: { tmdbId: number; mediaType: MediaType; season?: number; episode?: number; position: number; duration: number; baseRevision: number; translationId?: string }, keepalive = false) => request<PhantomWatchPosition>('/api/streaming/progress', { method: 'PUT', body: JSON.stringify(data), keepalive }),
  },
};

export function listItemToMovie(item: ListItem): Movie {
  const details = item.details || {};
  const raw = { ...details, id: item.tmdb_id, title: item.media_title || details.title || details.name, poster_path: item.poster_path || details.poster_path, overview: item.overview || details.overview, genre_names: item.genre_names || details.genre_names, director: item.director_names?.[0] || details.director, cast: item.actor_names || details.cast };
  return { ...toMovie(raw, item.media_type), id: item.tmdb_id, mediaType: item.media_type, status: item.status, userRating: item.rating ? Number(item.rating) : undefined, notes: String(item.notes || ''), watchedAt: item.watched_at ? new Date(String(item.watched_at)).toLocaleDateString('ru-RU') : undefined, listId: item.id };
}

export function recommendationToMovie(item: Json & { tmdb_id: number; media_type: MediaType }): Movie {
  const movie = toMovie({ ...item, id: item.tmdb_id, ...(item.details || {}) }, item.media_type);
  return { ...movie, recommendationScore: Number(item.score) || undefined, recommendationReason: String(item.reason || ''), recommendationId: item.recommendation_id ? Number(item.recommendation_id) : undefined, structuredReasons: item.structured_reasons || undefined };
}

export function tmdbListToMovies(items: TmdbItem[] = [], mediaType?: MediaType) { return items.map((item) => toMovie(item, mediaType || (item.media_type === 'tv' ? 'tv' : 'movie'))); }

export function personWorkToMovie(work: PersonWork): Movie {
  return {
    id: Number(work.tmdb_id) || 0,
    mediaType: work.media_type || 'movie',
    title: work.title || 'Без названия',
    originalTitle: work.original_title || undefined,
    year: Number(work.year) || 0,
    rating: Number(work.tmdb_rating) || 0,
    votes: work.tmdb_vote_count ? `${Number(work.tmdb_vote_count).toLocaleString('ru-RU')} оценок TMDB` : '',
    genres: work.genres || [],
    poster: imageUrl(work.poster_path),
    posterPath: work.poster_path || undefined,
    overview: work.overview || undefined,
    imdbId: work.imdb_title_id || undefined,
    imdbRating: work.imdb_rating === null || work.imdb_rating === undefined ? undefined : Number(work.imdb_rating),
    imdbVotes: work.imdb_votes === null || work.imdb_votes === undefined ? undefined : Number(work.imdb_votes),
    character: work.characters || work.job || undefined,
    category: work.category,
    workScore: work.work_score,
    status: work.status || undefined,
    listId: work.list_id || undefined,
    canAdd: work.can_add,
  };
}
