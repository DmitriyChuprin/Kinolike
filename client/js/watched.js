// Просмотренные: оценки, фильтры, сортировка, статистика
const Watched = {
  allItems: [], // кэх всех элементов для клиентской фильтрации
  
  async render() {
    if (!App.currentUser) {
      const app = document.getElementById('app');
      UI.emptyState(app, 'Войдите в аккаунт', 'Чтобы видеть просмотренные, необходимо авторизоваться');
      return;
    }
    
    const app = document.getElementById('app');
    UI.showLoader(app);
    
    try {
      const [watchedData, statsData] = await Promise.all([
        API.watched.get(),
        API.watched.stats(),
      ]);
      
      // Метаданные уже приходят с сервера из media_metadata (один SQL-запрос)
      const itemsWithDetails = watchedData.items.map(item => ({
        ...item,
        details: item.details || { title: `TMDB #${item.tmdb_id}`, poster_path: null },
      }));
      
      this.allItems = itemsWithDetails;
      this.renderGrid(itemsWithDetails);
      this.renderStats(statsData);
      this.initFilters();
      this.initRateButtons();
      this.initCardClicks();
      
    } catch (err) {
      console.error('Ошибка загрузки просмотренных:', err);
      UI.emptyState(app, 'Не удалось загрузить', err.message);
    }
  },
  
  renderStats(statsData) {
    const statsEl = document.getElementById('watchedStats');
    if (!statsEl) return;
    statsEl.innerHTML = `
      <div class="watched-stat">
        <span class="watched-stat-value">${statsData.total}</span>
        <span class="watched-stat-label">всего</span>
      </div>
      <div class="watched-stat">
        <span class="watched-stat-value">${statsData.movies}</span>
        <span class="watched-stat-label">фильмов</span>
      </div>
      <div class="watched-stat">
        <span class="watched-stat-value">${statsData.tv}</span>
        <span class="watched-stat-label">сериалов</span>
      </div>
      <div class="watched-stat">
        <span class="watched-stat-value">${statsData.avgRating || '—'}</span>
        <span class="watched-stat-label">средняя оценка</span>
      </div>
    `;
  },
  
  renderGrid(items) {
    const app = document.getElementById('app');
    
    if (items.length === 0 && this.allItems.length === 0) {
      app.innerHTML = `
        <h1 class="page-title">Просмотренные</h1>
        <div id="watchedStats" class="watched-stats"></div>
        <div class="filter-bar">
          <select id="filterType">
            <option value="">Все типы</option>
            <option value="movie">Фильмы</option>
            <option value="tv">Сериалы</option>
          </select>
          <select id="filterSort">
            <option value="watched_at">По дате просмотра</option>
            <option value="rating">По оценке</option>
            <option value="rating_asc">По оценке (низкая)</option>
          </select>
          <select id="filterRating">
            <option value="">Все оценки</option>
            <option value="min=8">8-10 (отлично)</option>
            <option value="min=6&max=7">6-7 (хорошо)</option>
            <option value="min=4&max=5">4-5 (средне)</option>
            <option value="max=3">1-3 (плохо)</option>
          </select>
        </div>
      `;
      UI.emptyState(app, 'Нет просмотренных', 'Отметьте фильмы как «Просмотрено»');
      return;
    }
    
    // Обновляем только сетку (не перерисовываем всю страницу)
    const grid = document.getElementById('watchedGrid');
    if (!grid) {
      // Первая отрисовка — создаём всю разметку
      app.innerHTML = `
        <h1 class="page-title">Просмотренные</h1>
        <div id="watchedStats" class="watched-stats"></div>
        <div class="filter-bar">
          <select id="filterType">
            <option value="">Все типы</option>
            <option value="movie">Фильмы</option>
            <option value="tv">Сериалы</option>
          </select>
          <select id="filterSort">
            <option value="watched_at">По дате просмотра</option>
            <option value="rating">По оценке</option>
            <option value="rating_asc">По оценке (низкая)</option>
          </select>
          <select id="filterRating">
            <option value="">Все оценки</option>
            <option value="min=8">8-10 (отлично)</option>
            <option value="min=6&max=7">6-7 (хорошо)</option>
            <option value="min=4&max=5">4-5 (средне)</option>
            <option value="max=3">1-3 (плохо)</option>
          </select>
        </div>
        <div class="movies-grid" id="watchedGrid"></div>
      `;
    }
    
    const gridEl = document.getElementById('watchedGrid');
    gridEl.innerHTML = items.map(item => {
      const title = item.details?.title || item.details?.name || `TMDB #${item.tmdb_id}`;
      const rating = item.details?.vote_average?.toFixed(1);
      const year = (item.details?.release_date || item.details?.first_air_date || '').slice(0, 4);
      // Режиссёр (фильм) или создатель (сериал)
      let director = '';
      if (item.media_type === 'movie' && item.details?.credits?.crew) {
        const dir = item.details.credits.crew.find(c => c.job === 'Director');
        director = dir?.name || '';
      } else if (item.media_type === 'tv' && item.details?.created_by?.length) {
        director = item.details.created_by.map(c => c.name).join(', ');
      }
      
      return `
        <div class="movie-card stagger-item" data-id="${item.tmdb_id}" data-type="${item.media_type}" data-list-id="${item.id}" data-rating="${item.rating || 0}">
          ${item.details?.poster_path 
            ? `<img class="movie-card-poster" src="${IMG.poster(item.details.poster_path)}" alt="${title}" loading="lazy">`
            : `<div class="movie-card-poster no-poster">🎬</div>`
          }
          <div class="movie-card-info">
            <div class="movie-card-title">${title}</div>
            <div class="movie-card-meta">
              ${rating ? `<span class="movie-card-rating ${parseFloat(rating) > 7 ? 'rating-high' : parseFloat(rating) > 5 ? 'rating-mid' : 'rating-low'}">${rating}</span>` : ''}
              ${year ? `<span>${year}</span>` : ''}
            </div>
            ${director ? `<div class="movie-card-director">${director}</div>` : ''}
            ${item.rating ? `
              <div class="movie-card-user-rating">
                <span class="movie-card-user-rating-label">Моя оценка:</span>
                <span class="movie-card-user-rating-value" style="color:${item.rating >= 8 ? 'var(--success)' : item.rating >= 5 ? 'var(--warning)' : 'var(--error)'}">${item.rating}/10</span>
              </div>
            ` : ''}
            ${item.notes ? `<div class="movie-card-notes">${UI.escapeHtml(item.notes)}</div>` : ''}
          </div>
          <div class="movie-card-actions">
            <button class="btn btn-sm btn-secondary watched-rate" data-list-id="${item.id}" data-current-rating="${item.rating || ''}">Оценить</button>
            <button class="btn btn-sm btn-secondary list-refresh" data-tmdb-id="${item.tmdb_id}" data-media-type="${item.media_type}">↻ Обновить</button>
          </div>
        </div>
      `;
    }).join('');
    
    this.initRateButtons();
    this.initCardClicks();
  },
  
  applyClientFilters() {
    const filterType = document.getElementById('filterType')?.value || '';
    const filterSort = document.getElementById('filterSort')?.value || 'watched_at';
    const filterRating = document.getElementById('filterRating')?.value || '';
    
    let filtered = [...this.allItems];
    
    // Фильтр по типу
    if (filterType) {
      filtered = filtered.filter(item => item.media_type === filterType);
    }
    
    // Фильтр по оценке
    if (filterRating) {
      const params = new URLSearchParams(filterRating);
      const min = params.get('min') ? parseInt(params.get('min')) : null;
      const max = params.get('max') ? parseInt(params.get('max')) : null;
      filtered = filtered.filter(item => {
        const r = item.rating || 0;
        if (min && r < min) return false;
        if (max && r > max) return false;
        return true;
      });
    }
    
    // Сортировка
    if (filterSort === 'rating') {
      filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    } else if (filterSort === 'rating_asc') {
      filtered.sort((a, b) => (a.rating || 0) - (b.rating || 0));
    } else {
      // По дате просмотра (новые сверху)
      filtered.sort((a, b) => {
        const da = a.watched_at || a.updated_at || '';
        const db = b.watched_at || b.updated_at || '';
        return db.localeCompare(da);
      });
    }
    
    this.renderGrid(filtered);
  },
  
  initFilters() {
    const filterType = document.getElementById('filterType');
    const filterSort = document.getElementById('filterSort');
    const filterRating = document.getElementById('filterRating');
    
    if (filterType) filterType.addEventListener('change', () => this.applyClientFilters());
    if (filterSort) filterSort.addEventListener('change', () => this.applyClientFilters());
    if (filterRating) filterRating.addEventListener('change', () => this.applyClientFilters());
  },

  initRateButtons() {
    document.querySelectorAll('.watched-rate').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const listId = btn.dataset.listId;
        const currentRating = btn.dataset.currentRating;
        
        const html = `
          <h3 class="modal-title">Оценить</h3>
          <div class="form-group">
            <label>Оценка (1-10)</label>
            <div class="rating-scale" id="rateModalRating">
              ${Array.from({length: 10}, (_, i) => `
                <div class="rating-number r-${i+1}${parseInt(currentRating) === i+1 ? ' active' : ''}" data-value="${i+1}">${i+1}</div>
              `).join('')}
            </div>
          </div>
          <div class="form-group">
            <label>Заметка</label>
            <textarea id="rateModalNotes" rows="3" style="width:100%;padding:8px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-primary);color:var(--text-primary);font-family:inherit;resize:vertical"></textarea>
          </div>
          <button class="btn btn-primary" id="rateModalSave" style="width:100%;justify-content:center">Сохранить</button>
        `;
        
        UI.modal.open(html);
        
        let selectedRating = parseInt(currentRating) || null;
        const ratingEl = document.getElementById('rateModalRating');
        
        ratingEl.addEventListener('click', (e) => {
          const num = e.target.closest('.rating-number');
          if (!num) return;
          selectedRating = parseInt(num.dataset.value);
          ratingEl.querySelectorAll('.rating-number').forEach(n => n.classList.remove('active'));
          num.classList.add('active');
        });
        
        document.getElementById('rateModalSave').addEventListener('click', async () => {
          if (!selectedRating) {
            UI.toast('Выберите оценку', 'error');
            return;
          }
          
          try {
            await API.watched.rate(listId, {
              rating: selectedRating,
              notes: document.getElementById('rateModalNotes').value,
              watched_at: new Date().toISOString(),
            });
            UI.toast('Оценка сохранена');
            UI.modal.close();
            this.render();
          } catch (err) {
            UI.toast(err.message, 'error');
          }
        });
      });
    });
  },

  initCardClicks() {
    document.querySelectorAll('#watchedGrid .movie-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.watched-rate')) return;
        if (e.target.closest('.list-refresh')) return;
        const id = card.dataset.id;
        const type = card.dataset.type;
        window.location.hash = `#/${type}/${id}`;
      });
    });
  },
};
