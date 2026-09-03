// Поиск — отдельная страница
const Search = {
  currentPage: 1,
  totalPages: 1,
  currentQuery: '',
  allResults: [], // все загруженные результаты
  
  async renderPage() {
    const app = document.getElementById('app');
    
    // Получаем query из URL
    const hash = window.location.hash;
    const queryMatch = hash.match(/[?&]q=([^&]+)/);
    const query = queryMatch ? decodeURIComponent(queryMatch[1]) : '';
    
    app.innerHTML = `
      <div class="search-page">
        <!-- Поле поиска -->
        <div class="search-page-input-wrap">
          <input type="text" id="searchPageInput" class="search-page-input" 
                 placeholder="Поиск фильмов и сериалов..." 
                 value="${UI.escapeHtml(query)}"
                 autofocus>
          <button class="btn btn-primary" id="searchPageBtn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px">
              <circle cx="11" cy="11" r="8"/>
              <path d="M21 21l-4.35-4.35"/>
            </svg>
          </button>
        </div>
        
        <div id="searchPageContent">
          ${query ? '<div class="loading-spinner"><div class="spinner"></div></div>' : ''}
        </div>
      </div>
    `;
    
    this.initPageEvents();
    
    if (query) {
      await this.executeSearch(query);
    }
  },

  initPageEvents() {
    const input = document.getElementById('searchPageInput');
    const btn = document.getElementById('searchPageBtn');
    
    if (!input || !btn) return;
    
    const submit = () => {
      const query = input.value.trim();
      if (query.length >= 2) {
        this.currentQuery = query;
        this.currentPage = 1;
        this.allResults = [];
        window.location.hash = `#/search?q=${encodeURIComponent(query)}`;
      }
    };
    
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    });
  },

  async executeSearch(query, append = false) {
    const content = document.getElementById('searchPageContent');
    if (!content) return;
    
    if (!append) {
      content.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';
      this.currentPage = 1;
      this.allResults = [];
    }
    
    try {
      const data = await API.tmdb.search(query, 'multi', this.currentPage);
      const results = data.results || [];
      this.totalPages = data.total_pages || 1;
      
      if (!append) {
        this.allResults = results;
      } else {
        this.allResults = [...this.allResults, ...results];
      }
      
      if (this.allResults.length === 0) {
        content.innerHTML = '';
        UI.emptyState(content, 'Ничего не найдено', `По запросу «${query}» ничего не найдено`);
        return;
      }
      
      await this.renderResults(query);
      
    } catch (err) {
      console.error('Ошибка поиска:', err);
      if (!append) {
        content.innerHTML = '';
        UI.emptyState(content, 'Ошибка поиска', err.message);
      }
    }
  },

  async renderResults(query) {
    const content = document.getElementById('searchPageContent');
    if (!content) return;
    
    // Применяем фильтры и сортировку
    const filtered = this.applyFiltersAndSort();
    
    // Получаем список пользователя для индикации статуса
    const userListMap = await this.getUserListMap();
    
    content.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin:20px 0 16px;flex-wrap:wrap;gap:12px">
        <p style="color:var(--text-secondary);font-size:0.9rem">
          Найдено: ${this.allResults.length}${this.totalPages > 1 ? ` (стр. ${this.currentPage} из ${this.totalPages})` : ''}
        </p>
        <div class="filter-bar" style="margin:0;flex-wrap:wrap">
          <select id="searchFilterType">
            <option value="">Все типы</option>
            <option value="movie">Фильмы</option>
            <option value="tv">Сериалы</option>
          </select>
          <select id="searchFilterYear">
            <option value="">Все годы</option>
          </select>
          <select id="searchSortBy">
            <option value="popularity">По популярности</option>
            <option value="vote_average">По рейтингу</option>
            <option value="release_date">По дате выхода</option>
          </select>
        </div>
      </div>
      
      <div class="movies-grid" id="searchResultsGrid">
        ${filtered.map(item => {
          const type = item.media_type || (item.title ? 'movie' : 'tv');
          const userStatus = userListMap.get(`${item.id}_${type}`);
          return this.renderSearchCard({...item, media_type: type}, userStatus);
        }).join('')}
      </div>
      
      ${this.currentPage < this.totalPages ? `
        <div style="text-align:center;margin:32px 0">
          <button class="btn btn-secondary" id="loadMoreBtn">
            Загрузить ещё (стр. ${this.currentPage + 1} из ${this.totalPages})
          </button>
        </div>
      ` : ''}
    `;
    
    this.populateYearFilter();
    this.initCardClicks();
    this.initFilters();
    this.initLoadMore(query);
  },

  renderSearchCard(item, userStatus) {
    const genres = App.getAllGenres();
    const title = item.title || item.name || '';
    const year = (item.release_date || item.first_air_date || '').slice(0, 4);
    const rating = item.vote_average ? item.vote_average.toFixed(1) : null;
    const ratingClass = rating > 7 ? 'rating-high' : rating > 5 ? 'rating-mid' : 'rating-low';
    
    // Бейдж статуса пользователя
    let statusBadge = '';
    if (userStatus === 'want_to_watch') {
      statusBadge = '<div class="search-status-badge want">Хочу посмотреть</div>';
    } else if (userStatus === 'watched') {
      statusBadge = '<div class="search-status-badge watched">Просмотрено</div>';
    }
    
    return `
      <div class="movie-card stagger-item" data-id="${item.id}" data-type="${item.media_type}">
        ${item.poster_path 
          ? `<img class="movie-card-poster" src="${IMG.poster(item.poster_path)}" alt="${title}" loading="lazy">`
          : `<div class="movie-card-poster no-poster">🎬</div>`
        }
        <div class="movie-card-info">
          <div class="movie-card-title">${UI.escapeHtml(title)}</div>
          <div class="movie-card-meta">
            ${rating ? `<span class="movie-card-rating ${ratingClass}">${rating}</span>` : ''}
            ${year ? `<span>${year}</span>` : ''}
          </div>
          ${statusBadge}
        </div>
        <div class="movie-card-actions">
          <button class="btn btn-sm btn-primary status-btn" data-tmdb-id="${item.id}" data-media-type="${item.media_type}">
            ${userStatus ? '✓ В списке' : '+ Добавить'}
          </button>
        </div>
      </div>
    `;
  },

  async getUserListMap() {
    // Загружаем списки пользователя и создаём карту tmdb_id+media_type -> status
    const map = new Map();
    if (!App.currentUser) return map;
    
    try {
      const [wantData, watchedData] = await Promise.all([
        API.lists.get({ status: 'want_to_watch' }).catch(() => ({ items: [] })),
        API.watched.get().catch(() => ({ items: [] })),
      ]);
      
      for (const item of wantData.items || []) {
        map.set(`${item.tmdb_id}_${item.media_type}`, 'want_to_watch');
      }
      for (const item of watchedData.items || []) {
        map.set(`${item.tmdb_id}_${item.media_type}`, 'watched');
      }
    } catch (err) {
      console.error('Ошибка загрузки списков:', err);
    }
    
    return map;
  },

  populateYearFilter() {
    const select = document.getElementById('searchFilterYear');
    if (!select) return;
    
    const years = new Set();
    for (const item of this.allResults) {
      const date = item.release_date || item.first_air_date;
      if (date) {
        const year = date.slice(0, 4);
        if (year && year !== '0000') {
          years.add(year);
        }
      }
    }
    
    const sortedYears = [...years].sort((a, b) => b - a);
    select.innerHTML = '<option value="">Все годы</option>' +
      sortedYears.map(y => `<option value="${y}">${y}</option>`).join('');
  },

  applyFiltersAndSort() {
    const type = document.getElementById('searchFilterType')?.value || '';
    const year = document.getElementById('searchFilterYear')?.value || '';
    const sortBy = document.getElementById('searchSortBy')?.value || 'popularity';
    
    let filtered = [...this.allResults];
    
    // Фильтр по типу
    if (type) {
      filtered = filtered.filter(item => item.media_type === type);
    }
    
    // Фильтр по году
    if (year) {
      filtered = filtered.filter(item => {
        const date = item.release_date || item.first_air_date;
        return date && date.slice(0, 4) === year;
      });
    }
    
    // Сортировка
    if (sortBy === 'vote_average') {
      filtered.sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));
    } else if (sortBy === 'release_date') {
      filtered.sort((a, b) => {
        const dateA = a.release_date || a.first_air_date || '';
        const dateB = b.release_date || b.first_air_date || '';
        return dateB.localeCompare(dateA);
      });
    } else {
      // По популярности (по умолчанию)
      filtered.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    }
    
    return filtered;
  },

  initCardClicks() {
    document.querySelectorAll('#searchResultsGrid .movie-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.status-btn') || e.target.closest('.list-refresh')) return;
        const id = card.dataset.id;
        const type = card.dataset.type;
        window.location.hash = `#/${type}/${id}`;
      });
    });
  },

  initFilters() {
    const filterType = document.getElementById('searchFilterType');
    const filterYear = document.getElementById('searchFilterYear');
    const sortBy = document.getElementById('searchSortBy');
    
    const applyFilters = async () => {
      const filtered = this.applyFiltersAndSort();
      const grid = document.getElementById('searchResultsGrid');
      const userListMap = await this.getUserListMap();
      
      grid.innerHTML = filtered.map(item => {
        const type = item.media_type || (item.title ? 'movie' : 'tv');
        const userStatus = userListMap.get(`${item.id}_${type}`);
        return this.renderSearchCard({...item, media_type: type}, userStatus);
      }).join('');
      
      this.initCardClicks();
    };
    
    if (filterType) filterType.addEventListener('change', applyFilters);
    if (filterYear) filterYear.addEventListener('change', applyFilters);
    if (sortBy) sortBy.addEventListener('change', applyFilters);
  },

  initLoadMore(query) {
    const btn = document.getElementById('loadMoreBtn');
    if (!btn) return;
    
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Загрузка...';
      this.currentPage++;
      await this.executeSearch(query, true);
    });
  },
};
