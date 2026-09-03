// Списки: хочу посмотреть, смотрю, отложено
const Lists = {
  currentStatus: null,
  allItems: [], // кэш для клиентской фильтрации
  
  async render(status) {
    this.currentStatus = status;
    
    if (!App.currentUser) {
      const app = document.getElementById('app');
      UI.emptyState(app, 'Войдите в аккаунт', 'Чтобы управлять списками, необходимо авторизоваться');
      return;
    }
    
    const app = document.getElementById('app');
    UI.showLoader(app);
    
    try {
      const { items, statusCounts } = await API.lists.get({ status });
      
      // Метаданные уже приходят с сервера из media_metadata (один SQL-запрос)
      const itemsWithDetails = items.map(item => ({
        ...item,
        details: item.details || { title: `TMDB #${item.tmdb_id}`, poster_path: null },
      }));
      
      this.allItems = itemsWithDetails;
      
      const statusLabels = {
        'want_to_watch': 'Хочу посмотреть',
      };
      
      const statusActions = {
        'want_to_watch': { label: 'Просмотрено', newStatus: 'watched' },
      };
      
      const action = statusActions[status];
      
      app.innerHTML = `
        <h1 class="page-title">${statusLabels[status] || status}</h1>
        
        <!-- Бейджи статусов -->
        <div class="tabs">
          ${Object.entries(statusLabels).map(([key, label]) => `
            <a href="#/${key === 'want_to_watch' ? 'want' : key}" 
               class="tab ${key === status ? 'active' : ''}">
              ${label}
              <span class="badge">${statusCounts[key] || 0}</span>
            </a>
          `).join('')}
        </div>
        
        <!-- Фильтры -->
        <div class="filter-bar">
          <select id="filterType">
            <option value="">Все типы</option>
            <option value="movie">Фильмы</option>
            <option value="tv">Сериалы</option>
          </select>
          <select id="filterGenre">
            <option value="">Все жанры</option>
          </select>
          <select id="filterSort">
            <option value="added_at">По дате добавления</option>
            <option value="rating">По рейтингу TMDB</option>
          </select>
        </div>
        
        <!-- Счётчик -->
        <p style="color:var(--text-secondary);margin-bottom:16px;font-size:0.9rem" id="listCounter">
          ${items.length} ${this.pluralize(items.length, 'элемент', 'элемента', 'элементов')}
        </p>
        
        <!-- Сетка -->
        <div class="movies-grid" id="listGrid"></div>
      `;
      
      this.renderGrid(itemsWithDetails, action);
      this.initFilters();
      
    } catch (err) {
      console.error('Ошибка загрузки списка:', err);
      UI.emptyState(app, 'Не удалось загрузить список', err.message);
    }
  },
  
  renderGrid(items, action) {
    const grid = document.getElementById('listGrid');
    if (!grid) return;
    
    if (items.length === 0) {
      grid.innerHTML = '';
      UI.emptyState(document.getElementById('app'), 'Список пуст', 'Добавьте фильмы или сериалы из каталога');
      return;
    }
    
    const counter = document.getElementById('listCounter');
    if (counter) {
      counter.textContent = `${items.length} ${this.pluralize(items.length, 'элемент', 'элемента', 'элементов')}`;
    }
    
    grid.innerHTML = items.map(item => {
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
        <div class="movie-card stagger-item" data-id="${item.tmdb_id}" data-type="${item.media_type}" data-list-id="${item.id}">
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
          </div>
          <div class="movie-card-actions">
            ${action ? `<button class="btn btn-sm btn-primary list-action" data-list-id="${item.id}" data-new-status="${action.newStatus}">${action.label}</button>` : ''}
            <button class="btn btn-sm btn-secondary list-remove" data-list-id="${item.id}">Удалить</button>
            <button class="btn btn-sm btn-secondary list-refresh" data-tmdb-id="${item.tmdb_id}" data-media-type="${item.media_type}">↻ Обновить</button>
          </div>
        </div>
      `;
    }).join('');
    
    this.initActions();
    this.initCardClicks();
  },
  
  applyClientFilters() {
    const type = document.getElementById('filterType')?.value || '';
    const genre = document.getElementById('filterGenre')?.value || '';
    const sort = document.getElementById('filterSort')?.value || 'added_at';
    
    let filtered = [...this.allItems];
    
    // Фильтр по типу
    if (type) {
      filtered = filtered.filter(item => item.media_type === type);
    }
    
    // Фильтр по жанру
    if (genre) {
      filtered = filtered.filter(item => {
        const genres = item.details?.genres || [];
        return genres.some(g => String(g.id) === genre);
      });
    }
    
    // Сортировка
    if (sort === 'rating') {
      filtered.sort((a, b) => (b.details?.vote_average || 0) - (a.details?.vote_average || 0));
    } else {
      // По дате добавления (новые сверху)
      filtered.sort((a, b) => (b.added_at || '').localeCompare(a.added_at || ''));
    }
    
    const statusActions = {
      'want_to_watch': { label: 'Просмотрено', newStatus: 'watched' },
    };
    
    this.renderGrid(filtered, statusActions[this.currentStatus]);
  },
  
  // Построить список жанров из текущих элементов списка
  populateGenreFilter() {
    const select = document.getElementById('filterGenre');
    if (!select) return;
    
    const genreMap = new Map();
    for (const item of this.allItems) {
      const genres = item.details?.genres || [];
      for (const g of genres) {
        genreMap.set(String(g.id), g.name);
      }
    }
    
    const sorted = [...genreMap.entries()].sort((a, b) => a[1].localeCompare(b[1], 'ru'));
    
    const currentVal = select.value;
    select.innerHTML = '<option value="">Все жанры</option>' +
      sorted.map(([id, name]) => `<option value="${id}">${UI.escapeHtml(name)}</option>`).join('');
    select.value = currentVal;
  },
  
  initFilters() {
    const filterType = document.getElementById('filterType');
    const filterGenre = document.getElementById('filterGenre');
    const filterSort = document.getElementById('filterSort');
    
    this.populateGenreFilter();
    
    if (filterType) {
      filterType.addEventListener('change', () => this.applyClientFilters());
    }
    if (filterGenre) {
      filterGenre.addEventListener('change', () => this.applyClientFilters());
    }
    if (filterSort) {
      filterSort.addEventListener('change', () => this.applyClientFilters());
    }
  },

  initActions() {
    // Кнопки смены статуса
    document.querySelectorAll('.list-action').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const listId = btn.dataset.listId;
        const newStatus = btn.dataset.newStatus;

        // При переносе в «Просмотрено» — сначала модалка с оценкой
        if (newStatus === 'watched') {
          this.openRatingModal(listId, btn);
          return;
        }

        try {
          await API.lists.update(listId, { status: newStatus });
          UI.toast('Статус обновлён');
          this.render(this.currentStatus);
        } catch (err) {
          UI.toast(err.message, 'error');
        }
      });
    });
    
    // Кнопки удаления
    document.querySelectorAll('.list-remove').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const listId = btn.dataset.listId;
        
        try {
          await API.lists.remove(listId);
          UI.toast('Удалено');
          this.render(this.currentStatus);
        } catch (err) {
          UI.toast(err.message, 'error');
        }
      });
    });
  },

  // Модалка с оценкой при переносе в «Просмотрено»
  openRatingModal(listId, btn) {
    const card = btn.closest('.movie-card');
    const title = card?.querySelector('.movie-card-title')?.textContent || '';

    const html = `
      <h3 class="modal-title">Оценить «${UI.escapeHtml(title)}»</h3>
      <div class="form-group">
        <label>Оценка (1-10, необязательно)</label>
        <div class="rating-scale" id="rateModalRating">
          ${Array.from({length: 10}, (_, i) => `
            <div class="rating-number r-${i+1}" data-value="${i+1}">${i+1}</div>
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

    let selectedRating = null;
    const ratingEl = document.getElementById('rateModalRating');

    ratingEl.addEventListener('click', (e) => {
      const num = e.target.closest('.rating-number');
      if (!num) return;
      selectedRating = parseInt(num.dataset.value);
      ratingEl.querySelectorAll('.rating-number').forEach(n => n.classList.remove('active'));
      num.classList.add('active');
    });

    document.getElementById('rateModalSave').addEventListener('click', async () => {
      try {
        const updateData = {
          status: 'watched',
          watched_at: new Date().toISOString(),
        };
        if (selectedRating) updateData.rating = selectedRating;
        const notes = document.getElementById('rateModalNotes').value.trim();
        if (notes) updateData.notes = notes;

        await API.lists.update(listId, updateData);
        UI.toast('Перенесено в просмотренные');
        UI.modal.close();
        this.render(this.currentStatus);
      } catch (err) {
        UI.toast(err.message, 'error');
      }
    });
  },

  initCardClicks() {
    document.querySelectorAll('#listGrid .movie-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.list-action') || e.target.closest('.list-remove') || e.target.closest('.list-refresh')) return;
        const id = card.dataset.id;
        const type = card.dataset.type;
        window.location.hash = `#/${type}/${id}`;
      });
    });
  },

  pluralize(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 19) return many;
    if (mod10 === 1) return one;
    if (mod10 >= 2 && mod10 <= 4) return few;
    return many;
  },
};
