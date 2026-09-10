// Рекомендации — жанровые подборки + фильтры Discover
const Recommendations = {
  filters: {
    media_type: '',
    genre: '',
    country: '',
    year_from: '',
    year_to: '',
    rating_from: '',
    sort_by: 'popularity.desc',
    page: 1,
  },
  allItems: [],
  totalPages: 0,

  async render() {
    if (!App.currentUser) {
      const app = document.getElementById('app');
      UI.emptyState(app, 'Войдите в аккаунт', 'Рекомендации доступны для авторизованных пользователей');
      return;
    }

    const app = document.getElementById('app');

    app.innerHTML = `
      <h1 class="page-title">Рекомендации</h1>

      <!-- AI Поиск -->
      <div class="ai-search-section">
        <div class="ai-search-bar">
          <input type="text" class="ai-search-input" id="aiSearchInput"
                 placeholder="Что хочешь посмотреть?"
                 maxlength="500">
          <button class="ai-search-btn" id="aiSearchBtn">Найти</button>
        </div>
        <div class="ai-search-examples">
          <span class="ai-search-example" data-q="Посоветуй что-нибудь посмотреть на вечер, романтическую комедию">Романтическая комедия на вечер</span>
          <span class="ai-search-example" data-q="Хочу хороший фантастический фильм на 2 часа">Фантастика на 2 часа</span>
          <span class="ai-search-example" data-q="Что-нибудь похожее на Интерстеллар">Похожее на Интерстеллар</span>
          <span class="ai-search-example" data-q="Посоветуй напряжённый триллер без ужасов">Триллер без ужасов</span>
          <span class="ai-search-example" data-q="Хочу лёгкий фильм, чтобы посмотреть вместе с девушкой">Лёгкий фильм вдвоём</span>
          <span class="ai-search-example" data-q="Что-нибудь умное и атмосферное, но не слишком тяжёлое">Умное и атмосферное</span>
          <span class="ai-search-example" data-q="Посоветуй фантастику последних пяти лет">Фантастика 2021–2026</span>
          <span class="ai-search-example" data-q="Хочу фильм с неожиданной концовкой">С неожиданной концовкой</span>
        </div>
        <p class="ai-search-info">AI подберёт фильмы из базы сайта по вашему вкусу</p>
        <div id="aiSearchStatus"></div>
      </div>

      <!-- Фильтры -->
      <div class="recs-filters">
        <div class="recs-type-tabs">
          <button class="recs-type-tab active" data-type="">Все</button>
          <button class="recs-type-tab" data-type="movie">Фильмы</button>
          <button class="recs-type-tab" data-type="tv">Сериалы</button>
        </div>

        <div class="recs-quick-filters">
          <button class="recs-quick-btn" data-filter="country" data-value="RU">🇷🇺 Российские</button>
          <button class="recs-quick-btn" data-filter="country" data-value="!RU">🌍 Зарубежные</button>
          <button class="recs-quick-btn" data-filter="rating_from" data-value="7">⭐ Высокий рейтинг</button>
        </div>

        <div class="recs-dropdowns">
          <select id="recsGenre" class="recs-select">
            <option value="">Все жанры</option>
          </select>
          <select id="recsCountry" class="recs-select">
            <option value="">Все страны</option>
          </select>
          <select id="recsYear" class="recs-select">
            <option value="">Все годы</option>
            <option value="2024-2026">2024–2026</option>
            <option value="2020-2023">2020–2023</option>
            <option value="2015-2019">2015–2019</option>
            <option value="2010-2014">2010–2014</option>
            <option value="2000-2009">2000–2009</option>
            <option value="1990-1999">1990–1999</option>
            <option value="1980-1989">1980–1989</option>
            <option value="1970-1979">1970–1979</option>
            <option value="1960-1969">1960–1969</option>
            <option value="1950-1959">1950–1959</option>
            <option value="1900-1949">До 1950</option>
          </select>
          <select id="recsSort" class="recs-select">
            <option value="popularity.desc">По популярности</option>
            <option value="vote_average.desc">По рейтингу</option>
            <option value="primary_release_date.desc">По дате (новые)</option>
            <option value="primary_release_date.asc">По дате (старые)</option>
          </select>
        </div>
      </div>

      <!-- Результаты фильтров -->
      <div id="recsResults" style="display:none">
        <div class="movies-grid" id="recsGrid"></div>
        <div id="recsLoadMore" style="display:none;text-align:center;margin-top:24px">
          <button class="btn btn-secondary" id="recsLoadMoreBtn">Загрузить ещё</button>
        </div>
      </div>

      <!-- Жанровые подборки (персональные) -->
      <div id="recsGenres" style="margin-top:40px">
        <div class="loading-spinner">
          <div class="spinner"></div>
        </div>
        <p style="text-align:center;color:var(--text-secondary)">Подбираем персональные рекомендации...</p>
      </div>
    `;

    this.initFilters();
    this.initAISearch();
    this.populateDropdowns();
    await this.loadGenreCollections();
  },

  // ===== AI Search =====
  _searchAbort: null,

  initAISearch() {
    const input = document.getElementById('aiSearchInput');
    const btn = document.getElementById('aiSearchBtn');
    if (!input || !btn) return;

    const doSearch = () => this.searchAI();

    btn.addEventListener('click', doSearch);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doSearch();
    });

    // Example chips
    document.querySelectorAll('.ai-search-example').forEach(chip => {
      chip.addEventListener('click', () => {
        input.value = chip.dataset.q;
        doSearch();
      });
    });
  },

  async searchAI() {
    const input = document.getElementById('aiSearchInput');
    const status = document.getElementById('aiSearchStatus');
    const query = (input?.value || '').trim();

    if (!query) {
      status.innerHTML = '<p style="color:var(--accent);font-size:0.85rem;margin-top:8px">Введите запрос</p>';
      return;
    }

    const btn = document.getElementById('aiSearchBtn');
    btn.disabled = true;
    btn.textContent = 'Поиск...';
    status.innerHTML = `
      <div class="ai-search-loading">
        <div class="spinner"></div>
        <span class="ai-search-loading-text">AI анализирует запрос и ищет подходящие фильмы...</span>
      </div>`;

    try {
      const data = await API.recommendations.search(query);
      this.renderSearchResults(data, status);
    } catch (err) {
      console.error('AI search error:', err);
      status.innerHTML = `<p style="color:#e74c3c;font-size:0.85rem;margin-top:8px">${err.message || 'Ошибка поиска'}</p>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Найти';
    }
  },

  renderSearchResults(data, container) {
    const { recommendations = [], query: searchQuery, params, refMovie } = data;
    const results = recommendations;
    const genres = App.getAllGenres();

    if (!results || results.length === 0) {
      container.innerHTML = `
        <div class="ai-search-empty">
          <div class="ai-search-empty-icon">🎬</div>
          <div class="ai-search-empty-text">Ничего не найдено. Попробуйте переформулировать запрос.</div>
        </div>`;
      return;
    }

    // Build result cards
    const cards = results.map(item => {
      const year = item.release_year || (item.details?.release_date || '').slice(0, 4);
      const rating = item.vote_average ? Number(item.vote_average).toFixed(1) : '—';
      const scoreClass = item.score >= 70 ? 'high' : item.score >= 45 ? 'medium' : 'low';
      const poster = item.poster_path ? IMG.poster(item.poster_path, 'w342') : '';
      const typeLabel = item.media_type === 'tv' ? 'Сериал' : 'Фильм';

      return `
        <div class="movie-card" data-id="${item.tmdb_id}" data-type="${item.media_type}">
          <div class="movie-card-poster" style="position:relative">
            ${poster
              ? `<img src="${poster}" alt="${item.title || ''}" loading="lazy">`
              : `<div class="no-poster">${item.title || 'Нет постера'}</div>`}
            <span class="ai-score-badge ${scoreClass}">${item.score}</span>
          </div>
          <div class="movie-card-info">
            <div class="movie-card-title">${item.title || 'Без названия'}</div>
            <div class="movie-card-meta">
              <span>${year || '—'}</span>
              <span class="rating-${item.vote_average >= 7 ? 'high' : item.vote_average >= 5 ? 'mid' : 'low'}">${rating}</span>
              <span style="opacity:0.6;font-size:0.72rem">${typeLabel}</span>
            </div>
            ${item.reason ? `<div class="ai-card-reason">${item.reason}</div>` : ''}
          </div>
          <div class="movie-card-actions">
            <button class="btn btn-sm status-btn" data-action="add" data-tmdb="${item.tmdb_id}" data-type="${item.media_type}">+ Добавить</button>
          </div>
        </div>`;
    }).join('');

    const subtitleParts = [];
    if (refMovie) subtitleParts.push(`Похоже на «${refMovie}»`);
    if (params?.genres?.length) subtitleParts.push(`жанры: ${params.genres.length}`);

    container.innerHTML = `
      <div class="ai-search-results">
        <div class="ai-search-results-title">Найдено: ${results.length} ${this._plural(results.length, 'результат', 'результатов', 'результата')}</div>
        ${subtitleParts.length ? `<div class="ai-search-results-subtitle">${subtitleParts.join(' · ')}</div>` : ''}
        <div class="movies-grid">${cards}</div>
      </div>`;

    // Init events
    Movies.initStatusButtons();
    container.querySelectorAll('.movie-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.status-btn')) return;
        const id = card.dataset.id;
        const type = card.dataset.type;
        window.location.hash = `#/${type}/${id}`;
      });
    });
  },

  _plural(n, one, many, few) {
    const abs = Math.abs(n) % 100;
    const lastDigit = abs % 10;
    if (abs > 10 && abs < 20) return many;
    if (lastDigit > 1 && lastDigit < 5) return few;
    if (lastDigit === 1) return one;
    return many;
  },

  // ===== Инициализация фильтров =====
  initFilters() {
    // Тип: Все / Фильмы / Сериалы
    document.querySelectorAll('.recs-type-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.recs-type-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.filters.media_type = tab.dataset.type;
        this.filters.page = 1;
        this.allItems = [];
        this.loadDiscover();
      });
    });

    // Быстрые кнопки: Российские / Зарубежные / Высокий рейтинг
    document.querySelectorAll('.recs-quick-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const filter = btn.dataset.filter;
        const value = btn.dataset.value;

        // Toggle: если уже активна — выключаем
        if (btn.classList.contains('active')) {
          btn.classList.remove('active');
          this.filters[filter] = '';
        } else {
          // Выключаем другие кнопки того же фильтра
          document.querySelectorAll(`.recs-quick-btn[data-filter="${filter}"]`).forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this.filters[filter] = value;
        }

        // Сбрасываем соответствующий dropdown
        if (filter === 'country') {
          document.getElementById('recsCountry').value = '';
        } else if (filter === 'rating_from') {
          // rating_from — отдельный quick filter
        }

        this.filters.page = 1;
        this.allItems = [];
        this.loadDiscover();
      });
    });

    // Dropdowns
    ['recsGenre', 'recsCountry', 'recsYear', 'recsSort'].forEach(id => {
      document.getElementById(id).addEventListener('change', () => {
        this.syncFiltersFromUI();
        this.filters.page = 1;
        this.allItems = [];
        this.loadDiscover();
      });
    });

    // Кнопка «Загрузить ещё»
    document.getElementById('recsLoadMoreBtn').addEventListener('click', () => {
      this.filters.page++;
      this.loadDiscover(true);
    });
  },

  // Синхронизировать фильтры из UI
  syncFiltersFromUI() {
    const genre = document.getElementById('recsGenre').value;
    const country = document.getElementById('recsCountry').value;
    const year = document.getElementById('recsYear').value;
    const sort = document.getElementById('recsSort').value;

    this.filters.genre = genre;
    this.filters.country = country || this.getActiveQuickCountry();
    this.filters.rating_from = this.getActiveQuickRating();
    this.filters.sort_by = sort;

    if (year) {
      const [from, to] = year.split('-');
      this.filters.year_from = from;
      this.filters.year_to = to;
    } else {
      this.filters.year_from = '';
      this.filters.year_to = '';
    }
  },

  getActiveQuickCountry() {
    const active = document.querySelector('.recs-quick-btn[data-filter="country"].active');
    return active ? active.dataset.value : '';
  },

  getActiveQuickRating() {
    const active = document.querySelector('.recs-quick-btn[data-filter="rating_from"].active');
    return active ? active.dataset.value : '';
  },

  // ===== Заполнение dropdowns =====
  populateDropdowns() {
    // Жанры
    const genres = App.getAllGenres();
    const genreSelect = document.getElementById('recsGenre');
    const seen = new Map();
    genres.forEach(g => {
      if (!seen.has(g.id)) {
        seen.set(g.id, g);
        const opt = document.createElement('option');
        opt.value = g.id;
        opt.textContent = g.name;
        genreSelect.appendChild(opt);
      }
    });

    // Страны — популярные
    const countries = [
      { code: 'RU', name: 'Россия' },
      { code: 'US', name: 'США' },
      { code: 'GB', name: 'Великобритания' },
      { code: 'FR', name: 'Франция' },
      { code: 'DE', name: 'Германия' },
      { code: 'IT', name: 'Италия' },
      { code: 'ES', name: 'Испания' },
      { code: 'JP', name: 'Япония' },
      { code: 'KR', name: 'Южная Корея' },
      { code: 'CN', name: 'Китай' },
      { code: 'IN', name: 'Индия' },
      { code: 'BR', name: 'Бразилия' },
      { code: 'CA', name: 'Канада' },
      { code: 'AU', name: 'Австралия' },
      { code: 'SE', name: 'Швеция' },
      { code: 'NO', name: 'Норвегия' },
      { code: 'DK', name: 'Дания' },
      { code: 'FI', name: 'Финляндия' },
      { code: 'NL', name: 'Нидерланды' },
      { code: 'BE', name: 'Бельгия' },
      { code: 'PL', name: 'Польша' },
      { code: 'CZ', name: 'Чехия' },
      { code: 'TR', name: 'Турция' },
      { code: 'IL', name: 'Израиль' },
      { code: 'MX', name: 'Мексика' },
      { code: 'AR', name: 'Аргентина' },
      { code: 'SU', name: 'СССР' },
    ];
    const countrySelect = document.getElementById('recsCountry');
    countries.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.code;
      opt.textContent = c.name;
      countrySelect.appendChild(opt);
    });
  },

  // ===== Discover с фильтрами =====
  async loadDiscover(append = false) {
    const container = document.getElementById('recsResults');
    const grid = document.getElementById('recsGrid');
    const loadMore = document.getElementById('recsLoadMore');

    if (!append) {
      this.syncFiltersFromUI();
      // Проверяем, есть ли активные фильтры
      const hasFilters = this.filters.media_type || this.filters.genre || this.filters.country
        || this.filters.year_from || this.filters.rating_from;
      if (!hasFilters) {
        container.style.display = 'none';
        return;
      }
      container.style.display = '';
      grid.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';
      loadMore.style.display = 'none';
    }

    try {
      const data = await API.recommendations.discover(this.filters);
      this.totalPages = data.total_pages || 0;

      const items = data.items || [];
      if (append) {
        this.allItems.push(...items);
      } else {
        this.allItems = items;
      }

      const genres = App.getAllGenres();
      const cards = items.map(item => UI.movieCardWithGenres(item, genres)).join('');

      if (append) {
        grid.insertAdjacentHTML('beforeend', cards);
      } else {
        grid.innerHTML = cards;
      }

      // Показать «Загрузить ещё» если есть ещё страницы
      if (this.filters.page < this.totalPages && this.filters.page < 20) {
        loadMore.style.display = '';
      } else {
        loadMore.style.display = 'none';
      }

      // Инициализировать события на новых карточках
      this.initGridEvents(grid);

    } catch (err) {
      console.error('Ошибка discover:', err);
      if (!append) grid.innerHTML = '<p style="text-align:center;color:var(--text-secondary)">Ошибка загрузки</p>';
    }
  },

  // События на grid-карточках
  initGridEvents(container) {
    Movies.initStatusButtons();
    container.querySelectorAll('.movie-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.status-btn')) return;
        if (e.target.closest('.card-refresh')) return;
        const id = card.dataset.id;
        const type = card.dataset.type;
        window.location.hash = `#/${type}/${id}`;
      });
    });
  },

  // ===== Жанровые подборки =====
  async loadGenreCollections() {
    const container = document.getElementById('recsGenres');
    if (!container) return;

    try {
      const data = await API.recommendations.genres();
      const genres = App.getAllGenres();
      const collections = (data.collections || []).filter(c => c.items.length);

      if (!collections.length) {
        container.innerHTML = '';
        UI.emptyState(container, 'Нет подборок', 'Не удалось загрузить жанровые подборки');
        return;
      }

      const movieCols = collections.filter(c => c.media_type === 'movie');
      const tvCols = collections.filter(c => c.media_type === 'tv');

      const renderRail = (col) => `
        <div class="section">
          <div class="section-header">
            <h2 class="section-title">${col.title}</h2>
          </div>
          <div class="rail">
            <div class="rail-track">
              ${col.items.map(item => UI.movieCardWithGenres(item, genres)).join('')}
            </div>
            <button class="rail-btn prev" aria-label="Назад">‹</button>
            <button class="rail-btn next" aria-label="Вперёд">›</button>
          </div>
        </div>
      `;

      container.innerHTML = `
        ${movieCols.length ? `
          <h2 class="section-title" style="margin-bottom:20px">Фильмы</h2>
          ${movieCols.map(renderRail).join('')}
        ` : ''}

        ${tvCols.length ? `
          <h2 class="section-title" style="margin:40px 0 20px">Сериалы</h2>
          ${tvCols.map(renderRail).join('')}
        ` : ''}
      `;

      this.initGenreEvents();

    } catch (err) {
      console.error('Ошибка жанровых подборок:', err);
      container.innerHTML = '';
      UI.emptyState(container, 'Не удалось загрузить подборки', err.message);
    }
  },

  // События жанровых подборок
  initGenreEvents() {
    Movies.initRails();
    Movies.initStatusButtons();

    document.querySelectorAll('#recsGenres .movie-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.status-btn')) return;
        if (e.target.closest('.card-refresh')) return;
        const id = card.dataset.id;
        const type = card.dataset.type;
        window.location.hash = `#/${type}/${id}`;
      });
    });
  },
};
