// UI утилиты: модалки, тосты, анимации

const UI = {
  // ===== Toast уведомления =====
  toast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    
    setTimeout(() => {
      toast.classList.add('removing');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  },

  // ===== Модальное окно =====
  modal: {
    open(content) {
      const overlay = document.getElementById('modalOverlay');
      const modalContent = document.getElementById('modalContent');
      modalContent.innerHTML = content;
      overlay.classList.add('active');
      document.body.style.overflow = 'hidden';
    },
    
    close() {
      const overlay = document.getElementById('modalOverlay');
      overlay.classList.remove('active');
      document.body.style.overflow = '';
    },
    
    // Модалка добавления в список
    addToList(tmdbId, mediaType, title, currentStatus) {
      const statuses = [
        { value: 'want_to_watch', label: 'Хочу посмотреть' },
        { value: 'watched', label: 'Просмотрено' },
      ];
      
      const html = `
        <h3 class="modal-title">Добавить «${UI.escapeHtml(title)}»</h3>
        <div class="form-group">
          <label>Статус</label>
          <select id="modalStatus">
            ${statuses.map(s => `
              <option value="${s.value}" ${s.value === currentStatus ? 'selected' : ''}>${s.label}</option>
            `).join('')}
          </select>
        </div>
        <div id="modalRatingGroup" style="display:${currentStatus === 'watched' ? 'block' : 'none'}">
          <div class="form-group">
            <label>Оценка (1-10)</label>
            <div class="rating-scale" id="modalRating">
              ${Array.from({length: 10}, (_, i) => `
                <div class="rating-number r-${i+1}" data-value="${i+1}">${i+1}</div>
              `).join('')}
            </div>
          </div>
          <div class="form-group">
            <label>Заметка</label>
            <textarea id="modalNotes" rows="3" style="width:100%;padding:8px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-primary);color:var(--text-primary);font-family:inherit;resize:vertical"></textarea>
          </div>
        </div>
        <button class="btn btn-primary" id="modalSave" style="width:100%;justify-content:center">Сохранить</button>
      `;
      
      this.open(html);
      
      // Привязываем события
      const statusSelect = document.getElementById('modalStatus');
      const ratingGroup = document.getElementById('modalRatingGroup');
      const ratingEl = document.getElementById('modalRating');
      let selectedRating = null;
      
      statusSelect.addEventListener('change', () => {
        ratingGroup.style.display = statusSelect.value === 'watched' ? 'block' : 'none';
      });
      
      // Выбор оценки
      ratingEl.addEventListener('click', (e) => {
        const num = e.target.closest('.rating-number');
        if (!num) return;
        selectedRating = parseInt(num.dataset.value);
        ratingEl.querySelectorAll('.rating-number').forEach(n => n.classList.remove('active'));
        num.classList.add('active');
      });
      
      // Сохранение
      document.getElementById('modalSave').addEventListener('click', async () => {
        try {
          const status = statusSelect.value;
          const notes = document.getElementById('modalNotes')?.value || '';
          
          const data = { status };
          if (status === 'watched') {
            data.rating = selectedRating;
            data.notes = notes;
            data.watched_at = new Date().toISOString();
          }
          
          await API.lists.add(tmdbId, mediaType, status);
          
          // Если есть оценка — обновляем
          if (status === 'watched' && selectedRating) {
            const list = await API.lists.get({ status: 'watched', media_type: mediaType });
            const item = list.items.find(i => i.tmdb_id === tmdbId);
            if (item) {
              await API.lists.update(item.id, data);
            }
          }
          
          UI.toast('Добавлено в список');
          UI.modal.close();
          
          // Обновляем страницу если нужно
          if (typeof App !== 'undefined' && App.refresh) {
            App.refresh();
          }
        } catch (err) {
          UI.toast(err.message, 'error');
        }
      });
    },
  },

  // ===== Loading =====
  showLoader(container) {
    container.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';
  },

  // ===== Пустое состояние =====
  emptyState(container, message, subtitle = '') {
    container.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z"/>
        </svg>
        <h3>${message}</h3>
        ${subtitle ? `<p>${subtitle}</p>` : ''}
      </div>
    `;
  },

  // ===== Карточка фильма =====
  movieCard(item, { showStatus = false, statusLabel = '' } = {}) {
    const title = item.title || item.name || 'Без названия';
    const year = (item.release_date || item.first_air_date || '').slice(0, 4);
    const rating = item.vote_average ? item.vote_average.toFixed(1) : null;
    const ratingClass = rating > 7 ? 'rating-high' : rating > 5 ? 'rating-mid' : 'rating-low';
    const genres = (item.genre_ids || []).slice(0, 3);
    const mediaType = item.media_type || (item.title ? 'movie' : 'tv');
    const id = item.id || item.tmdb_id;
    
    return `
      <div class="movie-card stagger-item" data-id="${id}" data-type="${mediaType}">
        ${showStatus && statusLabel ? `<div class="movie-card-status">${statusLabel}</div>` : ''}
        ${item.poster_path 
          ? `<img class="movie-card-poster" src="${IMG.poster(item.poster_path)}" alt="${title}" loading="lazy">`
          : `<div class="movie-card-poster no-poster"></div>`
        }
        <div class="movie-card-info">
          <div class="movie-card-title">${title}</div>
          <div class="movie-card-meta">
            ${rating ? `<span class="movie-card-rating ${ratingClass}">${rating}</span>` : ''}
            ${year ? `<span>${year}</span>` : ''}
          </div>
        </div>
        <div class="status-btn" title="Добавить в список">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </div>
      </div>
    `;
  },

  // ===== Карточка с жанрами (из TMDB) =====
  movieCardWithGenres(item, genres = []) {
    const title = item.title || item.name || 'Без названия';
    const year = (item.release_date || item.first_air_date || '').slice(0, 4);
    const rating = item.vote_average ? item.vote_average.toFixed(1) : null;
    const ratingClass = rating > 7 ? 'rating-high' : rating > 5 ? 'rating-mid' : 'rating-low';
    const mediaType = item.media_type || (item.title ? 'movie' : 'tv');
    const id = item.id || item.tmdb_id;
    const itemGenres = (item.genre_ids || []).map(gid => {
      const g = genres.find(x => x.id === gid);
      return g ? g.name : '';
    }).filter(Boolean).slice(0, 3);
    
    return `
      <div class="movie-card stagger-item" data-id="${id}" data-type="${mediaType}">
        ${item.poster_path 
          ? `<img class="movie-card-poster" src="${IMG.poster(item.poster_path)}" alt="${title}" loading="lazy">`
          : `<div class="movie-card-poster no-poster"></div>`
        }
        <div class="movie-card-info">
          <div class="movie-card-title">${title}</div>
          <div class="movie-card-meta">
            ${rating ? `<span class="movie-card-rating ${ratingClass}">${rating}</span>` : ''}
            ${year ? `<span>${year}</span>` : ''}
          </div>
          ${itemGenres.length ? `<div class="movie-card-genres">${itemGenres.join(', ')}</div>` : ''}
        </div>
        <div class="status-btn" title="Добавить в список">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </div>
        <button class="card-refresh list-refresh" title="Обновить метаданные"
                data-tmdb-id="${id}" data-media-type="${mediaType}"
                onclick="event.stopPropagation()">↻</button>
      </div>
    `;
  },

  // ===== Шкала оценок =====
  ratingScale(currentRating, interactive = false) {
    return `
      <div class="rating-scale${interactive ? ' interactive' : ''}" ${interactive ? 'data-interactive="true"' : ''}>
        ${Array.from({length: 10}, (_, i) => `
          <div class="rating-number r-${i+1}${currentRating === i+1 ? ' active' : ''}" data-value="${i+1}">${i+1}</div>
        `).join('')}
      </div>
    `;
  },

  // ===== Навигация (активная ссылка) =====
  setActiveNav(page) {
    document.querySelectorAll('.nav-link, .mobile-nav-link').forEach(link => {
      link.classList.toggle('active', link.dataset.page === page);
    });
  },

  // ===== Экранирование HTML =====
  escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
};

// Закрытие модалки
document.getElementById('modalClose').addEventListener('click', () => UI.modal.close());
document.getElementById('modalOverlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) UI.modal.close();
});
