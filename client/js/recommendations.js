// Рекомендации — фильтры + жанровые подборки (AI временно отключён)
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

      <section class="personal-recommendations" id="personalRecommendations">
        <div class="section-header">
          <h2 class="section-title">Персонально для вас</h2>
          <button class="btn btn-secondary btn-sm" id="refreshPersonalRecommendations">Обновить</button>
        </div>
        <div class="movies-grid" id="personalRecommendationsGrid">
          <div class="loading-spinner"><div class="spinner"></div></div>
        </div>
      </section>

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

      <!-- Жанровые подборки (внизу) -->
      <div id="recsGenres" style="margin-top:40px">
        <div class="loading-spinner">
          <div class="spinner"></div>
        </div>
        <p style="text-align:center;color:var(--text-secondary)">Собираем подборки по жанрам...</p>
      </div>
    `;

    this.initFilters();
    this.populateDropdowns();
    document.getElementById("refreshPersonalRecommendations")?.addEventListener("click", () => this.loadPersonalRecommendations(true));
    await Promise.all([this.loadPersonalRecommendations(), this.loadGenreCollections()]);
  },

  // ===== Персональные рекомендации =====
  async loadPersonalRecommendations(refresh = false) {
    const grid = document.getElementById("personalRecommendationsGrid");
    const button = document.getElementById("refreshPersonalRecommendations");
    if (!grid) return;
    if (refresh) {
      grid.innerHTML = "<div class=\"loading-spinner\"><div class=\"spinner\"></div></div>";
      if (button) button.disabled = true;
    }
    try {
      const data = await API.recommendations.get(refresh);
      const items = data.items || data.recommendations || [];
      if (!items.length) {
        grid.innerHTML = "<p class=\"recommendations-hint\">" + UI.escapeHtml(data.message || "Оцените минимум два просмотренных фильма, чтобы получить персональные рекомендации.") + "</p>";
        return;
      }
      grid.innerHTML = items.map(item => UI.movieCardWithGenres(item, App.getAllGenres())).join("");
      this.initGridEvents(grid);
    } catch (err) {
      console.error("Ошибка персональных рекомендаций:", err);
      grid.innerHTML = "<p class=\"recommendations-hint\">Не удалось загрузить персональные рекомендации: " + UI.escapeHtml(err.message) + "</p>";
    } finally {
      if (button) button.disabled = false;
    }
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
