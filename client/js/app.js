// Роутинг и навигация (SPA hash-based)
const App = {
  currentPage: null,
  currentUser: null,
  genres: null, // кэш жанров

  // Инициализация
  async init() {
    this.initTheme();
    this.initHamburger();
    this.initUserMenu();
    this.initSearch();
    this.initLogout();
    
    // Проверяем авторизацию
    try {
      const data = await API.auth.me();
      this.currentUser = data.user;
      this.updateUserUI();
    } catch (e) {
      this.currentUser = null;
      this.updateUserUI();
    }
    
    // Загружаем жанры
    try {
      this.genres = await API.tmdb.genres();
    } catch (e) {
      this.genres = { movie: [], tv: [] };
    }
    
    // Глобальный обработчик кнопки «Обновить» (для каталога/поиска)
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest('.list-refresh');
      if (!btn) return;
      e.stopPropagation();
      const tmdbId = btn.dataset.tmdbId;
      const mediaType = btn.dataset.mediaType;
      if (!tmdbId || !mediaType) return;
      btn.disabled = true;
      btn.textContent = '⏳';
      try {
        await API.tmdb.refreshMetadata(mediaType, tmdbId);
        UI.toast('Кэш очищен, загружаю свежие данные…');
        if (mediaType === 'movie') {
          await API.tmdb.movie(tmdbId);
        } else {
          await API.tmdb.tv(tmdbId);
        }
        UI.toast('Метаданные обновлены');
        // Перезагружаем текущую страницу
        App.route();
      } catch (err) {
        UI.toast('Ошибка: ' + err.message, 'error');
        btn.disabled = false;
        btn.textContent = '↻';
      }
    });
    
    // Роутинг
    window.addEventListener('hashchange', () => this.route());
    this.route();
  },

  // Роутер
  route() {
    const hash = window.location.hash || '#/';
    const path = hash.slice(1);

    // Эти страницы используют данные, привязанные к пользователю. После
    // миграции JWT из старой сессии может стать недействительным: не даём
    // вместо понятного входа отрисовывать ошибку API на пустой странице.
    const requiresAuth = ['/want', '/watched', '/recommendations', '/profile'];
    if (requiresAuth.includes(path) && !this.currentUser) {
      UI.toast('Сессия истекла. Войдите снова, чтобы увидеть свои данные.', 'error');
      window.location.hash = '#/login';
      return;
    }

    // Карточки фильмов и сериалов доступны только авторизованным пользователям.
    // Проверка работает и при клике по карточке, и при прямом переходе по ссылке.
    const isDetailPage = path.startsWith('/movie/') || path.startsWith('/tv/');
    if (isDetailPage && !this.currentUser) {
      UI.toast('Войдите в аккаунт, чтобы открыть карточку фильма', 'error');
      window.location.hash = '#/login';
      return;
    }
    
    // Определяем страницу
    if (path === '/' || path === '') {
      this.renderPage('home', () => Movies.render());
    } else if (path === '/want') {
      this.renderPage('want', () => Lists.render('want_to_watch'));
    } else if (path === '/watched') {
      this.renderPage('watched', () => Watched.render());
    } else if (path === '/recommendations') {
      this.renderPage('recommendations', () => Recommendations.render());
    } else if (path.startsWith('/movie/') || path.startsWith('/tv/')) {
      this.renderPage('detail', () => Detail.render(path));
    } else if (path === '/login') {
      this.renderPage('login', () => Auth.renderLogin());
    } else if (path === '/register') {
      this.renderPage('register', () => Auth.renderRegister());
    } else if (path === '/profile') {
      this.renderPage('profile', () => Stats.renderProfile());
    } else if (path === '/search') {
      this.renderPage('search', () => Search.renderPage());
    } else {
      this.renderPage('404', () => {
        document.getElementById('app').innerHTML = `
          <div class="empty-state">
            <h3>Страница не найдена</h3>
            <a href="#/" class="btn btn-primary" style="margin-top:16px">На главную</a>
          </div>
        `;
      });
    }
  },

  // Рендер страницы
  renderPage(page, renderFn) {
    this.currentPage = page;
    UI.setActiveNav(page);
    
    const app = document.getElementById('app');
    app.innerHTML = '';
    app.classList.add('page-enter');
    
    setTimeout(() => app.classList.remove('page-enter'), 300);
    
    renderFn();
  },

  // Обновить UI пользователя
  updateUserUI() {
    const authButtons = document.getElementById('authButtons');
    const userActions = document.getElementById('userActions');
    const dropdownUser = document.getElementById('dropdownUser');
    
    if (this.currentUser) {
      authButtons.style.display = 'none';
      userActions.style.display = 'block';
      dropdownUser.textContent = this.currentUser.username;
    } else {
      authButtons.style.display = 'block';
      userActions.style.display = 'none';
    }
  },

  // Тема
  initTheme() {
    const saved = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
  },

  // Гамбургер
  initHamburger() {
    const hamburger = document.getElementById('hamburger');
    const mobileNav = document.getElementById('mobileNav');

    hamburger.addEventListener('click', () => {
      mobileNav.classList.toggle('active');
    });

    // Закрытие при клике на ссылку
    mobileNav.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => mobileNav.classList.remove('active'));
    });

    // Закрытие при скролле
    let lastScroll = 0;
    window.addEventListener('scroll', () => {
      const currentScroll = window.scrollY;
      if (mobileNav.classList.contains('active') && currentScroll !== lastScroll) {
        mobileNav.classList.remove('active');
      }
      lastScroll = currentScroll;
    }, { passive: true });
  },

  // Меню пользователя
  initUserMenu() {
    const btn = document.getElementById('userBtn');
    const dropdown = document.getElementById('userDropdown');
    
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('active');
    });
    
    document.addEventListener('click', () => dropdown.classList.remove('active'));
    dropdown.addEventListener('click', (e) => e.stopPropagation());
  },

  // Выход
  initLogout() {
    document.getElementById('logoutBtn').addEventListener('click', async () => {
      try {
        await API.auth.logout();
        localStorage.removeItem('authToken');
        this.currentUser = null;
        this.updateUserUI();
        UI.toast('Вы вышли из аккаунта');
        window.location.hash = '#/';
      } catch (err) {
        UI.toast(err.message, 'error');
      }
    });
  },

  // Поиск
  initSearch() {
    const input = document.getElementById('searchInput');
    const results = document.getElementById('searchResults');
    let debounceTimer;

    // Переход на страницу поиска по Enter
    const goToSearchPage = () => {
      const query = input.value.trim();
      if (query.length >= 2) {
        window.location.hash = `#/search?q=${encodeURIComponent(query)}`;
        results.classList.remove('active');
      }
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        goToSearchPage();
      }
    });

    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      const query = input.value.trim();
      
      if (query.length < 2) {
        results.classList.remove('active');
        return;
      }
      
      debounceTimer = setTimeout(async () => {
        try {
          const data = await API.tmdb.search(query);
          const items = (data.results || []).slice(0, 8);
          
          if (items.length === 0) {
            results.innerHTML = '<div style="padding:12px;color:var(--text-secondary);font-size:0.85rem">Ничего не найдено. Нажмите Enter для полного поиска</div>';
          } else {
            results.innerHTML = items.map(item => {
              const title = item.title || item.name || '';
              const year = (item.release_date || item.first_air_date || '').slice(0, 4);
              const type = item.media_type === 'tv' ? 'Сериал' : 'Фильм';
              return `
                <div class="search-result-item" data-id="${item.id}" data-type="${item.media_type || 'movie'}">
                  ${item.poster_path 
                    ? `<img src="${IMG.backdrop(item.poster_path, 'w185')}" alt="${title}" style="width:80px;height:45px;object-fit:cover;border-radius:6px">`
                    : `<div style="width:80px;height:45px;background:var(--bg-tertiary);border-radius:4px;display:flex;align-items:center;justify-content:center">🎬</div>`
                  }
                  <div class="search-result-info">
                    <div class="search-result-title">${UI.escapeHtml(title)}</div>
                    <div class="search-result-meta">${type} · ${year}</div>
                  </div>
                </div>
              `;
            }).join('');
          }
          
          results.classList.add('active');
          
          // Клик на результат
          results.querySelectorAll('.search-result-item').forEach(el => {
            el.addEventListener('click', () => {
              const id = el.dataset.id;
              const type = el.dataset.type;
              window.location.hash = `#/${type}/${id}`;
              results.classList.remove('active');
              input.value = '';
            });
          });
        } catch (err) {
          console.error('Ошибка поиска:', err);
        }
      }, 300);
    });
    
    // Закрытие результатов при клике вне
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search-wrapper')) {
        results.classList.remove('active');
      }
    });

    // Мобильный поиск
    this.initMobileSearch();
  },

  // Мобильный поиск
  initMobileSearch() {
    const btn = document.getElementById('mobileSearchBtn');
    const overlay = document.getElementById('mobileSearchOverlay');
    const closeBtn = document.getElementById('mobileSearchClose');
    const input = document.getElementById('mobileSearchInput');
    const results = document.getElementById('mobileSearchResults');
    let debounceTimer;

    if (!btn || !overlay) return;

    btn.addEventListener('click', () => {
      overlay.classList.add('active');
      input.focus();
    });

    closeBtn.addEventListener('click', () => {
      overlay.classList.remove('active');
      input.value = '';
      results.innerHTML = '';
    });

    // Поиск при вводе
    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      const query = input.value.trim();

      if (query.length < 2) {
        results.innerHTML = '';
        return;
      }

      debounceTimer = setTimeout(async () => {
        try {
          const data = await API.tmdb.search(query);
          const items = (data.results || []).slice(0, 20);

          if (items.length === 0) {
            results.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-secondary)">Ничего не найдено</div>';
          } else {
            results.innerHTML = items.map(item => {
              const title = item.title || item.name || '';
              const year = (item.release_date || item.first_air_date || '').slice(0, 4);
              const type = item.media_type === 'tv' ? 'Сериал' : 'Фильм';
              return `
                <div class="search-result-item" data-id="${item.id}" data-type="${item.media_type || 'movie'}">
                  ${item.poster_path
                    ? `<img src="${IMG.poster(item.poster_path, 'w92')}" alt="${title}">`
                    : `<div style="width:40px;height:60px;background:var(--bg-tertiary);border-radius:4px;display:flex;align-items:center;justify-content:center">🎬</div>`
                  }
                  <div class="search-result-info">
                    <div class="search-result-title">${UI.escapeHtml(title)}</div>
                    <div class="search-result-meta">${type} · ${year}</div>
                  </div>
                </div>
              `;
            }).join('');
          }

          // Клик на результат
          results.querySelectorAll('.search-result-item').forEach(el => {
            el.addEventListener('click', () => {
              const id = el.dataset.id;
              const type = el.dataset.type;
              overlay.classList.remove('active');
              input.value = '';
              results.innerHTML = '';
              window.location.hash = `#/${type}/${id}`;
            });
          });
        } catch (err) {
          console.error('Ошибка мобильного поиска:', err);
        }
      }, 300);
    });

    // Закрытие по Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.classList.contains('active')) {
        overlay.classList.remove('active');
        input.value = '';
        results.innerHTML = '';
      }
    });
  },

  // Принудительное обновление
  refresh() {
    this.route();
  },

  // Получить все жанры
  getAllGenres() {
    if (!this.genres) return [];
    return [...(this.genres.movie || []), ...(this.genres.tv || [])];
  },
};

// Запуск
document.addEventListener('DOMContentLoaded', () => App.init());
