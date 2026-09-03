// API обёртка для запросов к backend
const API = {
  // Базовый запрос
  async request(url, options = {}) {
    const config = {
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      credentials: 'include',
      ...options,
    };
    
    try {
      const response = await fetch(url, config);
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || 'Ошибка запроса');
      }
      
      return data;
    } catch (error) {
      if (error.message === 'Failed to fetch') {
        throw new Error('Проверьте подключение к интернету');
      }
      throw error;
    }
  },

  // GET
  async get(url) {
    return this.request(url);
  },

  // POST
  async post(url, body) {
    return this.request(url, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  // PUT
  async put(url, body) {
    return this.request(url, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  },

  // DELETE
  async delete(url) {
    return this.request(url, { method: 'DELETE' });
  },

  // ===== Auth =====
  auth: {
    async register(username, email, password) {
      return API.post('/api/auth/register', { username, email, password });
    },
    async login(email, password) {
      return API.post('/api/auth/login', { email, password });
    },
    async logout() {
      return API.post('/api/auth/logout');
    },
    async me() {
      return API.get('/api/auth/me');
    },
    async updateProfile(data) {
      return API.put('/api/auth/profile', data);
    },
    async changePassword(currentPassword, newPassword) {
      return API.put('/api/auth/password', { currentPassword, newPassword });
    },
  },

  // ===== Lists =====
  lists: {
    async get(params = {}) {
      const query = new URLSearchParams(params).toString();
      return API.get(`/api/lists${query ? '?' + query : ''}`);
    },
    async add(tmdb_id, media_type, status) {
      return API.post('/api/lists', { tmdb_id, media_type, status });
    },
    async update(id, data) {
      return API.put(`/api/lists/${id}`, data);
    },
    async remove(id) {
      return API.delete(`/api/lists/${id}`);
    },
    async exportAll() {
      return API.get('/api/lists/export');
    },
    async importAll(items) {
      return API.post('/api/lists/import', { items });
    },
  },

  // ===== Watched =====
  watched: {
    async get(params = {}) {
      const query = new URLSearchParams(params).toString();
      return API.get(`/api/watched${query ? '?' + query : ''}`);
    },
    async rate(id, data) {
      return API.put(`/api/watched/${id}/rate`, data);
    },
    async stats() {
      return API.get('/api/watched/stats');
    },
  },

  // ===== Recommendations =====
  recommendations: {
    async get(refresh = false) {
      return API.get(`/api/recommendations${refresh ? '?refresh=true' : ''}`);
    },
    async generate() {
      return API.post('/api/recommendations/generate');
    },
    async custom(query) {
      return API.post('/api/recommendations/custom', { query });
    },
    async genres() {
      return API.get('/api/recommendations/genres');
    },
    async favoriteGenre() {
      return API.get('/api/recommendations/favorite-genre');
    },
    async clearCache() {
      return API.delete('/api/recommendations/cache');
    },
    async discover(params) {
      const qs = new URLSearchParams();
      Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') qs.set(k, v); });
      return API.get(`/api/recommendations/discover?${qs.toString()}`);
    },
  },

  // ===== Stats =====
  stats: {
    async overview() {
      return API.get('/api/stats/overview');
    },
  },

  // ===== TMDB =====
  tmdb: {
    async search(query, type = 'multi', page = 1) {
      return API.get(`/api/tmdb/search?query=${encodeURIComponent(query)}&type=${type}&page=${page}`);
    },
    async popularMovies() {
      return API.get('/api/tmdb/movie/popular');
    },
    async popularMoviesLastYear() {
      return API.get('/api/tmdb/movie/last_year');
    },
    async popularTvLastYear() {
      return API.get('/api/tmdb/tv/last_year');
    },
    async trendingMoviesWeek() {
      return API.get('/api/tmdb/trending/movie/week');
    },
    async trendingTvWeek() {
      return API.get('/api/tmdb/trending/tv/week');
    },
    async nowPlaying() {
      return API.get('/api/tmdb/movie/now_playing');
    },
    async upcoming() {
      return API.get('/api/tmdb/movie/upcoming');
    },
    async topRatedMovies() {
      return API.get('/api/tmdb/movie/top_rated');
    },
    async topRatedTv() {
      return API.get('/api/tmdb/tv/top_rated');
    },
    async movie(id) {
      return API.get(`/api/tmdb/movie/${id}`);
    },
    async movieCredits(id) {
      return API.get(`/api/tmdb/movie/${id}/credits`);
    },
    async movieSimilar(id) {
      return API.get(`/api/tmdb/movie/${id}/similar`);
    },
    async movieVideos(id) {
      return API.get(`/api/tmdb/movie/${id}/videos`);
    },
    async popularTv() {
      return API.get('/api/tmdb/tv/popular');
    },
    async onTheAir() {
      return API.get('/api/tmdb/tv/on_the_air');
    },
    async tv(id) {
      return API.get(`/api/tmdb/tv/${id}`);
    },
    async tvCredits(id) {
      return API.get(`/api/tmdb/tv/${id}/credits`);
    },
    async tvSimilar(id) {
      return API.get(`/api/tmdb/tv/${id}/similar`);
    },
    async tvVideos(id) {
      return API.get(`/api/tmdb/tv/${id}/videos`);
    },
    async genres() {
      return API.get('/api/tmdb/genres');
    },
    async person(id) {
      return API.get(`/api/tmdb/person/${id}`);
    },
    async refreshMetadata(type, id) {
      return API.request(`/api/tmdb/metadata/${type}/${id}`, { method: 'DELETE' });
    },
  },

  // ===== Streaming (Jackett + TorrServer) =====
  streaming: {
    async search(query, type = 'movie') {
      return API.post('/api/streaming/search', { query, type });
    },
    async play(magnet, title, poster, tmdbId, mediaType, fileIndex = 0) {
      return API.post('/api/streaming/play', { magnet, title, poster, tmdbId, mediaType, fileIndex });
    },
    async saveSeries(hash, title, season, files, tmdbId) {
      return API.post('/api/streaming/save-series', { hash, title, season, files, tmdbId });
    },
    async info(hash) {
      return API.post('/api/streaming/info', { hash });
    },
    async status() {
      return API.get('/api/streaming/status');
    },
    async getLink(type, tmdbId) {
      return API.get(`/api/streaming/link/${type}/${tmdbId}`);
    },
    async deleteLink(type, tmdbId) {
      return API.delete(`/api/streaming/link/${type}/${tmdbId}`);
    },
    async refreshJellyfin(type, tmdbId) {
      return API.post(`/api/streaming/refresh-jellyfin/${type}/${tmdbId}`);
    },
  },

  // ===== Phantom (онлайн-источник) =====
  phantom: {
    async search(title, year, mediaType, tmdbId) {
      return API.post('/api/phantom/search', { title, year, mediaType, tmdbId });
    },
    async stream(tokenMovie, idFile) {
      return API.get(`/api/phantom/stream?tokenMovie=${encodeURIComponent(tokenMovie)}&idFile=${encodeURIComponent(idFile)}`);
    },
  },
  vkvideo: {
    async search(title, year) {
      return API.post('/api/vkvideo/search', { title, year });
    },
  },
};

// Утилиты для изображений (через серверный прокси)
const IMG = {
  poster(path, size = 'w342') {
    if (!path) return '';
    return `/api/tmdb/image?path=${encodeURIComponent(path)}&size=${size}`;
  },
  backdrop(path, size = 'w1280') {
    if (!path) return '';
    return `/api/tmdb/image?path=${encodeURIComponent(path)}&size=${size}`;
  },
  profile(path, size = 'w185') {
    if (!path) return '';
    return `/api/tmdb/image?path=${encodeURIComponent(path)}&size=${size}`;
  },
};
