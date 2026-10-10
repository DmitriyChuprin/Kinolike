// Роутинг и навигация (SPA hash-based)
const App = {
  currentPage: null,
  currentUser: null,
  genres: null, // кэш жанров

  // Инициализация
  async init() {
    this.initTheme();
    this.initThemeToggle();
    this.initSidebar();
    this.initBottomNav();
    this.initTopbar();
    this.initUserMenu();
    this.initSearch();
    this.initLogout();
    this.initKeyboardShortcuts();

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
    const sidebarUserName = document.getElementById('sidebarUserName');

    if (authButtons) authButtons.style.display = this.currentUser ? 'none' : 'block';
    if (userActions) userActions.style.display = this.currentUser ? 'block' : 'none';
    if (dropdownUser && this.currentUser) dropdownUser.textContent = this.currentUser.username;
    if (sidebarUserName) sidebarUserName.textContent = this.currentUser ? this.currentUser.username : 'Войти';
  },

  // Тема
  initTheme() {
    const saved = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
  },

  // Переключатель темы (sidebar)
  initThemeToggle() {
    const btn = document.getElementById('themeToggle');
    if (!btn) return;

    btn.addEventListener('click', () => {
      const html = document.documentElement;
      const current = html.getAttribute('data-theme') || 'dark';
      const next = current === 'dark' ? 'light' : 'dark';
      html.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
    });
  },

  // Sidebar (overlay close)
  initSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');

    if (!sidebar || !overlay) return;

    const closeSidebar = () => {
      sidebar.classList.remove('active');
      overlay.classList.remove('active');
      document.body.style.overflow = '';
    };

    // Закрытие при клике на overlay
    overlay.addEventListener('click', closeSidebar);

    // Закрытие при клике на ссылку в sidebar
    sidebar.querySelectorAll('.sidebar-link').forEach(link => {
      link.addEventListener('click', () => {
        if (window.innerWidth <= 768) {
          closeSidebar();
        }
      });
    });
  },

  // Меню пользователя (sidebar)
  initUserMenu() {
    const btn = document.getElementById('sidebarUserBtn');
    const dropdown = document.getElementById('sidebarUserDropdown');

    if (!btn || !dropdown) return;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('active');
    });

    document.addEventListener('click', () => dropdown.classList.remove('active'));
    dropdown.addEventListener('click', (e) => e.stopPropagation());
  },

  // Выход
  initLogout() {
    const logoutBtn = document.getElementById('logoutBtn');
    if (!logoutBtn) return;

    logoutBtn.addEventListener('click', async () => {
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

  // Bottom navigation (мобильное нижнее меню)
  initBottomNav() {
    const bottomNav = document.getElementById('bottomNav');
    if (!bottomNav) return;

    // Close sidebar on mobile when bottom nav link clicked
    bottomNav.querySelectorAll('.bottom-nav-link').forEach(link => {
      link.addEventListener('click', () => {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebarOverlay');
        if (sidebar) sidebar.classList.remove('active');
        if (overlay) overlay.classList.remove('active');
        document.body.style.overflow = '';
      });
    });
  },

  // Topbar (поиск и переключатель темы)
  initTopbar() {
    const topbarSearch = document.getElementById('topbarSearchInput');
    const themeToggleTop = document.getElementById('themeToggleTop');

    // Topbar search → navigate to search page on Enter
    if (topbarSearch) {
      topbarSearch.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && topbarSearch.value.trim()) {
          window.location.hash = '#/search?q=' + encodeURIComponent(topbarSearch.value.trim());
          topbarSearch.value = '';
          topbarSearch.blur();
        }
      });
    }

    // Topbar theme toggle (synced with sidebar toggle)
    if (themeToggleTop) {
      themeToggleTop.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme');
        const next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('theme', next);
      });
    }
  },

  // Поиск
  initSearch() {
    const input = document.getElementById('searchInput');
    const results = document.getElementById('searchResults');
    let debounceTimer;

    // Переход на страницу поиска по Enter (только для header search)
    if (input && results) {
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

    } // end if (input && results)

    // Sidebar поиск — клик переводит фокус на основной input или открывает страницу поиска
    const sidebarSearch = document.getElementById('sidebarSearch');
    if (sidebarSearch) {
      sidebarSearch.addEventListener('click', () => {
        // Если на странице есть input поиска — фокусируемся
        if (input && document.getElementById('app').contains(input)) {
          input.focus();
        } else {
          window.location.hash = '#/search';
        }
      });
    }

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

  // Горячие клавиши
  initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Ctrl+K — фокус на поиск или переход на страницу поиска
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        // Try topbar search first, then sidebar search, then navigate
        const topbarSearch = document.getElementById('topbarSearchInput');
        const searchInput = document.getElementById('searchInput');
        if (topbarSearch && document.getElementById('topbar') && document.getElementById('topbar').contains(topbarSearch)) {
          topbarSearch.focus();
          topbarSearch.select();
        } else if (searchInput && document.getElementById('app').contains(searchInput)) {
          searchInput.focus();
          searchInput.select();
        } else {
          window.location.hash = '#/search';
        }
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
