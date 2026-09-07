// Каталог: главная страница со слайдером и подборками (Kinopoisk HD style)
const Movies = {
  sliderInterval: null,

  async render() {
    const app = document.getElementById('app');
    UI.showLoader(app);

    try {
      const [trendingMovies, trendingTv, nowPlaying, upcoming, topRatedMovies] = await Promise.all([
        API.tmdb.trendingMoviesWeek().catch(() => ({ results: [] })),
        API.tmdb.trendingTvWeek().catch(() => ({ results: [] })),
        API.tmdb.nowPlaying().catch(() => ({ results: [] })),
        API.tmdb.upcoming().catch(() => ({ results: [] })),
        API.tmdb.topRatedMovies().catch(() => ({ results: [] })),
      ]);

      const genres = App.getAllGenres();

      // Персональные блоки (для авторизованных)
      let wantItems = [];
      let continueWatching = [];
      if (App.currentUser) {
        const [wantData, positionsData] = await Promise.all([
          API.lists.get({ status: 'want_to_watch' }).catch(() => ({ items: [] })),
          API.watchPositions.get().catch(() => ({ items: [] })),
        ]);
        wantItems = (wantData.items || [])
          .map(item => this.mapListItem(item))
          .filter(i => i.poster_path);
        continueWatching = (positionsData.items || []).map(pos => ({
          id: pos.tmdb_id,
          media_type: pos.media_type,
          title: pos.title,
          poster_path: pos.poster_path,
          _position: pos.position,
          _duration: pos.duration,
        }));
      }

      // Слайдер — тренды недели
      const sliderItems = (trendingMovies.results || []).slice(0, 5);

      app.innerHTML = `
        <!-- Hero-слайдер -->
        ${sliderItems.length ? `
          <div class="slider" id="mainSlider">
            <div class="slider-track" id="sliderTrack">
              ${sliderItems.map(item => this.renderSlide(item, genres)).join('')}
            </div>
            <button class="slider-btn prev" id="sliderPrev">‹</button>
            <button class="slider-btn next" id="sliderNext">›</button>
            <div class="slider-dots" id="sliderDots">
              ${sliderItems.map((_, i) => `
                <button class="slider-dot${i === 0 ? ' active' : ''}" data-index="${i}"></button>
              `).join('')}
            </div>
          </div>
        ` : ''}

        <!-- Подборки -->
        <div id="catalogContent">
          ${this.renderContinueWatching(continueWatching)}

          ${this.renderRailSection('Из вашего списка', wantItems, genres)}

          ${this.renderRailSection('В тренде за неделю',
            (trendingMovies.results || []).slice(0, 18), genres)}

          ${this.renderRailSection('Сейчас в кино',
            (nowPlaying.results || []).slice(0, 18), genres)}

          ${this.renderRailSection('Сериалы в тренде',
            (trendingTv.results || []).slice(0, 18).map(i => ({...i, media_type: 'tv'})), genres)}

          ${this.renderRailSection('Классика с высоким рейтингом',
            (topRatedMovies.results || []).slice(0, 18), genres)}

          ${this.renderRailSection('Скоро выйдут',
            (upcoming.results || []).slice(0, 18), genres)}
        </div>
      `;

      this.initSlider(sliderItems.length);
      this.initRails();
      this.initCardClicks();
      this.initStatusButtons();
      this.initContinueWatchingButtons();

    } catch (err) {
      console.error('Ошибка загрузки каталога:', err);
      UI.emptyState(app, 'Не удалось загрузить каталог', 'Попробуйте обновить страницу');
    }
  },

  // Элемент списка «Хочу посмотреть» → формат карточки TMDB
  mapListItem(item) {
    const d = item.details || {};
    return {
      id: item.tmdb_id,
      media_type: item.media_type,
      title: d.title,
      name: d.name,
      poster_path: d.poster_path,
      vote_average: d.vote_average,
      release_date: d.release_date,
      first_air_date: d.first_air_date,
      genre_ids: (d.genres || []).map(g => g.id),
    };
  },

  // Слайд hero-слайдера
  renderSlide(item, genres) {
    const title = item.title || item.name || '';
    const year = (item.release_date || item.first_air_date || '').slice(0, 4);
    const rating = item.vote_average ? item.vote_average.toFixed(1) : null;
    const ratingClass = rating > 7 ? 'rating-high' : rating > 5 ? 'rating-mid' : 'rating-low';
    const itemGenres = (item.genre_ids || []).map(gid => {
      const g = genres.find(x => x.id === gid);
      return g ? g.name : '';
    }).filter(Boolean).slice(0, 2).join(', ');

    return `
      <div class="slider-item" data-id="${item.id}" data-type="movie">
        ${item.backdrop_path
          ? `<img src="${IMG.backdrop(item.backdrop_path)}" alt="${UI.escapeHtml(title)}">`
          : `<div style="width:100%;height:540px;background:var(--bg-tertiary)"></div>`
        }
        <div class="slider-overlay">
          <div class="slider-title">${UI.escapeHtml(title)}</div>
          <div class="slider-meta">
            ${rating ? `<span class="slider-rating ${ratingClass}">${rating}</span>` : ''}
            ${year ? `<span>${year}</span>` : ''}
            ${itemGenres ? `<span>· ${itemGenres}</span>` : ''}
          </div>
          ${item.overview ? `<div class="slider-desc">${UI.escapeHtml(item.overview)}</div>` : ''}
          <button class="btn btn-primary" onclick="window.location.hash='#/movie/${item.id}'">Подробнее</button>
        </div>
      </div>
    `;
  },

  // Секция «Продолжить просмотр»
  renderContinueWatching(items) {
    if (!items.length) return '';
    return `
      <div class="section">
        <div class="section-header">
          <h2 class="section-title">Продолжить просмотр</h2>
        </div>
        <div class="rail">
          <div class="rail-track">
            ${items.map(item => {
              const progress = item._duration > 0 ? Math.min((item._position / item._duration) * 100, 95) : 0;
              const timeLeft = item._duration > 0 ? Math.max(item._duration - item._position, 0) : 0;
              const h = Math.floor(timeLeft / 3600);
              const m = Math.floor((timeLeft % 3600) / 60);
              const remaining = h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
              return `
                <div class="movie-card" data-id="${item.id}" data-type="${item.media_type}" style="position:relative">
                  <button class="cw-remove-btn" data-id="${item.id}" data-type="${item.media_type}" title="Удалить из «Продолжить просмотр»">×</button>
                  <div class="movie-card-poster">
                    ${item.poster_path
                      ? `<img src="${IMG.poster(item.poster_path)}" alt="${UI.escapeHtml(item.title || '')}">`
                      : `<div class="no-poster">🎬</div>`
                    }
                    <div class="progress-bar" style="position:absolute;bottom:0;left:0;right:0;height:3px;background:rgba(255,255,255,0.2)">
                      <div style="height:100%;width:${progress}%;background:var(--primary);border-radius:0 2px 2px 0"></div>
                    </div>
                  </div>
                  <div class="movie-card-info">
                    <div class="movie-card-title">${UI.escapeHtml(item.title || '')}</div>
                    <div style="font-size:0.75rem;color:var(--text-secondary)">Осталось ${remaining}</div>
                  </div>
                </div>`;
            }).join('')}
          </div>
          <button class="rail-btn prev" aria-label="Назад">‹</button>
          <button class="rail-btn next" aria-label="Вперёд">›</button>
        </div>
      </div>
    `;
  },

  // Кнопки удаления из «Продолжить просмотр»
  initContinueWatchingButtons() {
    document.querySelectorAll('.cw-remove-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const type = btn.dataset.type;
        const card = btn.closest('.movie-card');

        await API.watchPositions.remove(id, type).catch(() => {});
        if (card) card.remove();

        // Если секция пуста — убрать целиком
        const section = document.querySelector('.section');
        if (section && !section.querySelector('.movie-card')) {
          section.remove();
        }
      });
    });
  },

  // Секция с горизонтальной подборкой
  renderRailSection(title, items, genres) {
    if (!items.length) return '';
    return `
      <div class="section">
        <div class="section-header">
          <h2 class="section-title">${title}</h2>
        </div>
        <div class="rail">
          <div class="rail-track">
            ${items.map(item => UI.movieCardWithGenres(item, genres)).join('')}
          </div>
          <button class="rail-btn prev" aria-label="Назад">‹</button>
          <button class="rail-btn next" aria-label="Вперёд">›</button>
        </div>
      </div>
    `;
  },

  initSlider(count) {
    if (count <= 1) return;

    // Очищаем предыдущий интервал (защита от утечки)
    if (this.sliderInterval) {
      clearInterval(this.sliderInterval);
      this.sliderInterval = null;
    }

    let current = 0;
    const track = document.getElementById('sliderTrack');
    const dots = document.querySelectorAll('#sliderDots .slider-dot');

    const goTo = (index) => {
      current = (index + count) % count;
      track.style.transform = `translateX(-${current * 100}%)`;
      dots.forEach((d, i) => d.classList.toggle('active', i === current));
    };

    document.getElementById('sliderPrev').addEventListener('click', () => goTo(current - 1));
    document.getElementById('sliderNext').addEventListener('click', () => goTo(current + 1));

    dots.forEach(dot => {
      dot.addEventListener('click', () => goTo(parseInt(dot.dataset.index)));
    });

    // Автопрокрутка
    this.sliderInterval = setInterval(() => goTo(current + 1), 6000);
  },

  // Горизонтальные подборки: стрелки прокрутки
  initRails() {
    document.querySelectorAll('.rail').forEach(rail => {
      const track = rail.querySelector('.rail-track');
      const prev = rail.querySelector('.rail-btn.prev');
      const next = rail.querySelector('.rail-btn.next');
      if (!track || !prev || !next) return;

      const step = () => track.clientWidth * 0.8;

      prev.addEventListener('click', () => {
        track.scrollBy({ left: -step(), behavior: 'smooth' });
      });
      next.addEventListener('click', () => {
        track.scrollBy({ left: step(), behavior: 'smooth' });
      });

      // Скрываем стрелки на краях
      const updateButtons = () => {
        prev.disabled = track.scrollLeft <= 0;
        next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 1;
      };
      track.addEventListener('scroll', updateButtons, { passive: true });
      rail._updateButtons = updateButtons;
      updateButtons();
    });

    // Пересчёт стрелок при ресайзе (один обработчик на всё)
    if (!this._railResizeBound) {
      this._railResizeBound = true;
      window.addEventListener('resize', () => {
        document.querySelectorAll('.rail').forEach(rail => {
          if (rail._updateButtons) rail._updateButtons();
        });
      });
    }
  },

  initCardClicks() {
    document.querySelectorAll('.movie-card').forEach(card => {
      card.addEventListener('click', (e) => {
        // Игнорируем клик по кнопке статуса / обновления / удаления
        if (e.target.closest('.status-btn')) return;
        if (e.target.closest('.card-refresh')) return;
        if (e.target.closest('.cw-remove-btn')) return;

        const id = card.dataset.id;
        const type = card.dataset.type;
        window.location.hash = `#/${type}/${id}`;
      });
    });
  },

  initStatusButtons() {
    document.querySelectorAll('.movie-card .status-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();

        if (!App.currentUser) {
          UI.toast('Войдите, чтобы добавить в список', 'error');
          return;
        }

        const card = btn.closest('.movie-card');
        const id = parseInt(card.dataset.id);
        const type = card.dataset.type;
        const title = card.querySelector('.movie-card-title')?.textContent || '';

        UI.modal.addToList(id, type, title);
      });
    });
  },
};
