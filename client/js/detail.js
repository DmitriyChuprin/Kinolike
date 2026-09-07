// Детальная страница фильма/сериала

// ===== Plyr video player (with position memory) =====
const VideoPlayer = {
  _key(url, title) {
    const raw = (title || '') + url;
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
      hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
    }
    return 'vp_' + Math.abs(hash).toString(36);
  },

  open(url, title) {
    const overlay = document.getElementById('videoPlayerOverlay');
    const video = document.getElementById('videoPlayerElement');
    const titleEl = document.getElementById('videoPlayerTitle');

    this._stopTracking();
    this._lastKey = this._key(url, title);
    titleEl.textContent = title || '';
    video.src = url;
    video.load();

    // Restore saved position
    const savedPos = localStorage.getItem(this._key(url, title));
    if (savedPos && parseFloat(savedPos) > 1) {
      const restorePosition = parseFloat(savedPos);
      const resumeNote = document.createElement('span');
      resumeNote.className = 'video-resume-note';
      resumeNote.textContent = ` ▶ с ${this._fmtTime(restorePosition)}`;
      titleEl.appendChild(resumeNote);
      video.addEventListener('loadedmetadata', () => {
        video.currentTime = Math.min(restorePosition, video.duration || restorePosition);
      }, { once: true });
    }

    overlay.classList.add('active');
    this.player.play().catch(() => {});

    // Save on pause and periodically
    this._saveInterval = setInterval(() => {
      this._savePosition(video, this._key(url, title));
    }, 5000);

    // Also save on pause
    this._pauseHandler = () => {
      this._savePosition(video, this._key(url, title));
    };
    video.addEventListener('pause', this._pauseHandler);
  },

  close() {
    const overlay = document.getElementById('videoPlayerOverlay');
    const video = document.getElementById('videoPlayerElement');
    // Save final position
    this._savePosition(video, this._lastKey);
    overlay.classList.remove('active');
    this.player.pause();
    // Повторно сохраняем после pause: Plyr может обновить currentTime
    // только в момент остановки воспроизведения.
    this._savePosition(video, this._lastKey);
    video.removeAttribute('src');
    video.load();
    this._stopTracking();
  },

  _fmtTime(s) {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`;
  },

  _savePosition(video, key) {
    const position = Number(video?.currentTime);
    if (key && Number.isFinite(position) && position > 0) {
      localStorage.setItem(key, String(position));
    }
  },

  _stopTracking() {
    const video = document.getElementById('videoPlayerElement');
    if (this._saveInterval) clearInterval(this._saveInterval);
    if (this._pauseHandler && video) video.removeEventListener('pause', this._pauseHandler);
    this._saveInterval = null;
    this._pauseHandler = null;
  },

  init() {
    const video = document.getElementById('videoPlayerElement');
    if (!video || !window.Plyr) return;
    this.player = new Plyr(video, {
      controls: ['play-large', 'rewind', 'play', 'fast-forward', 'progress', 'current-time', 'duration', 'mute', 'volume', 'settings', 'pip', 'airplay', 'fullscreen'],
      seekTime: 10,
      settings: ['speed'],
      speed: { selected: 1, options: [0.75, 1, 1.25, 1.5, 2] },
      i18n: { rewind: 'Назад на {seektime} сек.', fastForward: 'Вперёд на {seektime} сек.' },
    });
  },
};

// Init close button
document.getElementById('videoPlayerClose')?.addEventListener('click', () => VideoPlayer.close());
document.getElementById('videoPlayerOverlay')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) VideoPlayer.close();
});
VideoPlayer.init();

const Detail = {
  async render(path) {
    const app = document.getElementById('app');
    UI.showLoader(app);
    
    const match = path.match(/^\/(movie|tv)\/(\d+)$/);
    if (!match) {
      UI.emptyState(app, 'Некорректный URL');
      return;
    }
    
    const type = match[1];
    const id = match[2];
    
    try {
      const details = type === 'movie' 
        ? await API.tmdb.movie(id)
        : await API.tmdb.tv(id);
      
      const title = details.title || details.name || 'Без названия';
      const originalTitle = details.original_title || details.original_name || '';
      const year = (details.release_date || details.first_air_date || '').slice(0, 4);
      const rating = details.vote_average?.toFixed(1);
      const ratingClass = rating > 7 ? 'rating-high' : rating > 5 ? 'rating-mid' : 'rating-low';
      const genres = details.genres || [];
      const description = details.overview || 'Описание отсутствует';
      
      let seasonsInfo = '';
      if (type === 'tv' && details.number_of_seasons) {
        seasonsInfo = `<span class="detail-meta-item">Сезонов: ${details.number_of_seasons}</span>`;
        if (details.number_of_episodes) {
          seasonsInfo += `<span class="detail-meta-item">Серий: ${details.number_of_episodes}</span>`;
        }
      }
      
      let durationInfo = '';
      if (type === 'movie' && details.runtime) {
        durationInfo = `<span class="detail-meta-item">${details.runtime} мин</span>`;
      }
      
      let financialInfo = '';
      if (type === 'movie') {
        if (details.budget) financialInfo += `<span class="detail-meta-item">Бюджет: $${(details.budget/1e6).toFixed(0)}M</span>`;
        if (details.revenue) financialInfo += `<span class="detail-meta-item">Сборы: $${(details.revenue/1e6).toFixed(0)}M</span>`;
      }
      
      const credits = details.credits || {};
      const cast = (credits.cast || []).slice(0, 10);
      
      const videos = details.videos || {};
      const trailer = (videos.results || []).find(v => v.type === 'Trailer' && v.site === 'YouTube');
      
      let currentStatus = null;
      let listItemId = null;
      let jellyfinUrl = null;
      let hasStreamingLink = false;
      if (App.currentUser) {
        try {
          const list = await API.lists.get({ media_type: type });
          const item = list.items.find(i => i.tmdb_id === parseInt(id));
          if (item) {
            currentStatus = item.status;
            listItemId = item.id;
          }
        } catch (e) {}

        try {
          const linkData = await API.streaming.getLink(type, id);
          if (linkData.link) {
            hasStreamingLink = true;
            if (linkData.link.jellyfin_url) {
              jellyfinUrl = linkData.link.jellyfin_url;
            }
          }
        } catch (e) {}
      }
      
      const posterUrl = details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : '';

      app.innerHTML = `
        <div class="detail-backdrop">
          ${details.backdrop_path 
            ? `<img src="${IMG.backdrop(details.backdrop_path)}" alt="${title}">`
            : `<div style="width:100%;height:100%;background:var(--bg-tertiary)"></div>`
          }
          <div class="detail-backdrop-overlay"></div>
        </div>
        
        <div class="detail-content">
          <div class="detail-poster">
            ${details.poster_path 
              ? `<img src="${IMG.poster(details.poster_path, 'w500')}" alt="${title}">`
              : `<div style="width:100%;aspect-ratio:2/3;background:var(--bg-tertiary);border-radius:var(--radius-lg);display:flex;align-items:center;justify-content:center;font-size:3rem">🎬</div>`
            }
          </div>
          
          <div class="detail-info">
            <h1 class="detail-title">${title}</h1>
            ${originalTitle && originalTitle !== title ? `<div class="detail-original-title">${originalTitle}</div>` : ''}
            
            <div class="detail-meta">
              ${year ? `<span class="detail-meta-item">${year}</span>` : ''}
              ${durationInfo}
              ${seasonsInfo}
              ${rating ? `<span class="detail-rating-big ${ratingClass}">${rating}</span>` : ''}
              ${financialInfo}
            </div>
            
            <div class="detail-genres">
              ${genres.map(g => `<span class="genre-tag">${g.name}</span>`).join('')}
            </div>
            
            <p class="detail-description">${description}</p>
            
            <div class="detail-actions">
              ${this.renderStatusButtons(type, id, title, currentStatus, listItemId)}
              <button class="btn btn-sm btn-primary detail-add-btn"
                      data-type="${type}" data-title="${UI.escapeHtml(title)}" data-id="${id}"
                      data-poster="${posterUrl}" data-year="${year}">
                + Добавить
              </button>

              <button class="btn btn-sm btn-secondary detail-phantom-btn" id="phantomWatchBtn"
                      data-type="${type}" data-title="${UI.escapeHtml(title)}"
                      data-original-title="${UI.escapeHtml(originalTitle)}"
                      data-id="${id}" data-year="${year}"
                      style="display:inline-flex;align-items:center;gap:6px;flex-shrink:0;white-space:nowrap">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z"/>
                </svg>
                Смотреть онлайн
              </button>

              ${jellyfinUrl ? `
                <a href="${jellyfinUrl}" target="_blank" class="btn btn-sm btn-secondary" style="display:inline-flex;align-items:center;gap:6px;text-decoration:none">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z"/>
                  </svg>
                  Смотреть
                </a>
              ` : ''}

              ${hasStreamingLink && !jellyfinUrl ? `
                <button class="btn btn-sm btn-secondary" id="refreshJellyfinBtn" data-type="${type}" data-id="${id}" style="display:inline-flex;align-items:center;gap:6px;flex-shrink:0;white-space:nowrap">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M23 4v6h-6M1 20v-6h6"/>
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                  </svg>
                  Найти в Jellyfin
                </button>
              ` : ''}
            </div>
          </div>
        </div>
        
        ${cast.length ? `
          <div class="detail-section">
            <h3>Актёрский состав</h3>
            <div class="cast-grid">
              ${cast.map(person => `
                <div class="cast-card" data-person-id="${person.id}" style="cursor:pointer">
                  ${person.profile_path 
                    ? `<img src="${IMG.profile(person.profile_path)}" alt="${person.name}">`
                    : `<div style="width:80px;height:80px;border-radius:50%;background:var(--bg-tertiary);margin:0 auto;display:flex;align-items:center;justify-content:center">👤</div>`
                  }
                  <div class="cast-card-name">${person.name}</div>
                  <div class="cast-card-character">${person.character || ''}</div>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
        
        ${trailer ? `
          <div class="detail-section">
            <h3>Трейлер</h3>
            <div class="trailer-container" id="trailerContainer">
              <div id="trailerPlayer" style="position:relative;width:100%;padding-top:56.25%;background:#000;border-radius:var(--radius-lg);overflow:hidden">
                <iframe id="trailerFrame" src="https://www.youtube.com/embed/${trailer.key}?rel=0&modestbranding=1&enablejsapi=1&origin=${encodeURIComponent(location.origin)}" style="position:absolute;top:0;left:0;width:100%;height:100%;border:none" allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture" allowfullscreen></iframe>
              </div>
              <script>
                (function(){
                  var frame = document.getElementById('trailerFrame');
                  if(!frame) return;
                  frame.onerror = function(){
                    var c = document.getElementById('trailerContainer');
                    c.innerHTML = '<a href="https://www.youtube.com/watch?v=${trailer.key}" target="_blank" rel="noopener" style="display:block;text-decoration:none"><img src="https://img.youtube.com/vi/${trailer.key}/hqdefault.jpg" alt="Трейлер" style="width:100%;border-radius:var(--radius-lg)"></a>';
                  };
                })();
              </script>
            </div>
          </div>
        ` : ''}
      `;
      
      this.initStatusButtonEvents(type, id, title);
      this.initAddButton();
      this.initPhantomButton(type, id, title, originalTitle, year);
      this.initCastClickEvents();
      this.initJellyfinRefreshButton(type, id);
      
    } catch (err) {
      console.error('Ошибка загрузки деталей:', err);
      UI.emptyState(app, 'Не удалось загрузить информацию', err.message);
    }
  },

  renderStatusButtons(type, id, title, currentStatus, listItemId) {
    const statuses = [
      { value: 'want_to_watch', label: 'Хочу посмотреть' },
      { value: 'watched', label: 'Просмотрено' },
      { value: 'not_interested', label: 'Не интересно' },
    ];
    
    return statuses.map(s => {
      const isActive = s.value === currentStatus;
      const listIdAttr = isActive && listItemId ? ` data-list-id="${listItemId}"` : '';
      return `
        <button class="btn btn-sm ${isActive ? 'btn-primary' : 'btn-secondary'} detail-status-btn" 
                data-status="${s.value}" data-tmdb-id="${id}" data-media-type="${type}"${listIdAttr}>
          ${s.label}
        </button>
      `;
    }).join('');
  },

  initStatusButtonEvents(type, id, title) {
    document.querySelectorAll('.detail-status-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!App.currentUser) {
          UI.toast('Войдите, чтобы добавить в список', 'error');
          return;
        }
        
        const status = btn.dataset.status;
        const listId = btn.dataset.listId;
        
        // If button has list-id, it's active → remove from list (toggle off)
        if (listId) {
          try {
            await API.lists.remove(parseInt(listId));
            UI.toast(`Удалено из списка`);
            this.render(`/${type}/${id}`);
          } catch (err) {
            UI.toast(err.message, 'error');
          }
          return;
        }
        
        // Otherwise → add to list (toggle on)
        if (status === 'watched') {
          UI.modal.addToList(parseInt(id), type, title, status);
        } else {
          try {
            await API.lists.add(parseInt(id), type, status);
            UI.toast(`Добавлено: ${btn.textContent.trim()}`);
            this.render(`/${type}/${id}`);
          } catch (err) {
            UI.toast(err.message, 'error');
          }
        }
      });
    });
  },

  // ===== Кнопка "Добавить" =====
  initAddButton() {
    const btn = document.querySelector('.detail-add-btn');
    if (!btn) return;

    btn.addEventListener('click', () => {
      const title = btn.dataset.title;
      const type = btn.dataset.type;
      const poster = btn.dataset.poster;
      const year = btn.dataset.year;
      this.openAddModal(title, type, poster, year);
    });
  },

  // ===== Кнопка "Смотреть онлайн" (VkMovie) =====
  initPhantomButton(type, id, title, originalTitle, year) {
    const btn = document.getElementById('phantomWatchBtn');
    if (!btn) return;

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.innerHTML = `
        <div class="spinner" style="width:14px;height:14px;border-width:2px"></div>
        Поиск...
      `;

      try {
        const result = await API.vkvideo.search(title || originalTitle, year);

        if (!result.results || result.results.length === 0) {
          UI.toast('Видео не найдено', 'error');
          btn.disabled = false;
          btn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z"/>
            </svg>
            Смотреть онлайн
          `;
          return;
        }

        this.openVkMoviePicker(result.results, title || originalTitle);
        // Restore button after picker shown
        btn.disabled = false;
        btn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z"/>
          </svg>
          Смотреть онлайн
        `;
      } catch (err) {
        console.error('[VkMovie] search error:', err);
        UI.toast('Ошибка поиска: ' + err.message, 'error');
        btn.disabled = false;
        btn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z"/>
          </svg>
          Смотреть онлайн
        `;
      }
    });
  },

  /**
   * Show video picker modal for VkMovie results
   */
  openVkMoviePicker(results, displayTitle) {
    const items = results.map(r => {
      const quals = r.qualities.map(q => q.quality).join(', ');
      return `
        <div class="online-results-list" style="display:flex;align-items:center;gap:10px;padding:10px;border-bottom:1px solid var(--border);cursor:pointer" 
             data-url="${UI.escapeHtml(r.qualities[0].url)}" data-title="${UI.escapeHtml(r.title)}">
          <div style="flex:1;min-width:0">
            <div style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${UI.escapeHtml(r.title)}</div>
            <div style="font-size:0.8rem;color:var(--text-secondary)">${quals} · ${Math.round(r.duration/60)} мин</div>
          </div>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style="color:var(--primary);flex-shrink:0">
            <path d="M8 5v14l11-7z"/>
          </svg>
        </div>`;
    }).join('');

    const html = `
      <div style="max-width:600px;width:100%">
        <h3 class="modal-title" style="margin-bottom:12px">${UI.escapeHtml(displayTitle)}</h3>
        <p style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:12px">${results.length} вариантов</p>
        <div style="max-height:60vh;overflow-y:auto">${items}</div>
      </div>`;

    UI.modal.open(html);

    document.querySelectorAll('.online-results-list[data-url]').forEach(el => {
      el.addEventListener('click', () => {
        const rawUrl = el.dataset.url;
        const title = el.dataset.title;
        UI.modal.close();
        const proxyUrl = `/api/vkvideo/proxy?url=${encodeURIComponent(rawUrl)}`;
        VideoPlayer.open(proxyUrl, title);
      });
    });
  },

  /**
   * Show content picker modal for Phantom results
   */
  openPhantomPicker(result, displayTitle) {
    const { tokenMovie, content } = result;

    if (content.type === 'movie') {
      // Movie — show translation picker, then play
      if (content.translations.length === 1) {
        // Single translation — play directly
        this.openPhantomStream(tokenMovie, content.translations[0].id, displayTitle);
        return;
      }

      const html = `
        <div style="padding:20px">
          <h3 class="modal-title" style="margin-bottom:12px">${UI.escapeHtml(displayTitle)}</h3>
          <p style="color:var(--text-secondary);margin-bottom:16px;font-size:0.9rem">Выберите озвучку:</p>
          <div class="online-results-list">
            ${content.translations.map((t, i) => `
              <div class="online-result-item" data-index="${i}" style="cursor:pointer">
                <div class="online-result-info">
                  <div class="online-result-title">${UI.escapeHtml(t.name)}</div>
                  <div class="online-result-meta">
                    ${t.quality ? `<span class="online-badge">${t.quality}</span>` : ''}
                    ${t.uhd ? '<span class="online-badge">2160p</span>' : ''}
                  </div>
                </div>
                <button class="btn btn-sm btn-primary online-play-btn" data-index="${i}">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                </button>
              </div>
            `).join('')}
          </div>
        </div>
      `;

      UI.modal.open(html);
      document.querySelectorAll('#modalContent .online-play-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = parseInt(btn.dataset.index);
          this.openPhantomStream(tokenMovie, content.translations[idx].id, displayTitle);
        });
      });
      return;
    }

    // Serial — show season/episode picker
    this.openPhantomSerialPicker(result, displayTitle);
  },

  /**
   * Show serial picker with seasons, episodes, translations
   */
  openPhantomSerialPicker(result, displayTitle) {
    const { tokenMovie, content } = result;
    const seasons = content.seasons || {};
    const seasonKeys = Object.keys(seasons).sort((a, b) => {
      const na = parseInt(a) || 0;
      const nb = parseInt(b) || 0;
      return na - nb;
    });

    if (seasonKeys.length === 0) {
      UI.toast('Сезоны не найдены', 'error');
      return;
    }

    this._phantomResult = result;
    this._phantomDisplayTitle = displayTitle;
    this._phantomCurrentSeason = seasonKeys[0];

    this._renderPhantomSeason(seasonKeys[0]);
  },

  _renderPhantomSeason(seasonKey) {
    const result = this._phantomResult;
    const displayTitle = this._phantomDisplayTitle;
    const { tokenMovie, content } = result;
    const seasons = content.seasons;
    const seasonKeys = Object.keys(seasons).sort((a, b) => (parseInt(a) || 0) - (parseInt(b) || 0));

    const translations = Object.keys(seasons[seasonKey] || {}).sort();
    const episodes = seasons[seasonKey]?.[translations[0]] || [];

    const seasonTabs = seasonKeys.map(sk => `
      <button class="phantom-season-tab ${sk === seasonKey ? 'active' : ''}"
              data-season="${sk}"
              style="padding:6px 12px;border:1px solid var(--border-color);border-radius:var(--radius);
                     background:${sk === seasonKey ? 'var(--accent)' : 'var(--bg-secondary)'};
                     color:${sk === seasonKey ? '#fff' : 'var(--text-primary)'};
                     cursor:pointer;font-size:0.85rem">
        ${sk} сезон
      </button>
    `).join('');

    const transButtons = translations.map((t, i) => `
      <button class="phantom-trans-tab ${i === 0 ? 'active' : ''}" data-voice="${UI.escapeHtml(t)}"
              style="padding:4px 10px;border:1px solid var(--border-color);border-radius:var(--radius);
                     background:${i === 0 ? 'var(--accent)' : 'var(--bg-secondary)'};
                     color:${i === 0 ? '#fff' : 'var(--text-primary)'};
                     cursor:pointer;font-size:0.8rem">
        ${UI.escapeHtml(t)}
      </button>
    `).join('');

    const epList = episodes.map(ep => `
      <div class="online-result-item" data-id="${ep.id}" style="cursor:pointer">
        <div class="online-result-info">
          <div class="online-result-title">${ep.episode} серия</div>
        </div>
        <button class="btn btn-sm btn-primary phantom-play-ep" data-id="${ep.id}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </button>
      </div>
    `).join('');

    const html = `
      <div style="padding:20px;max-height:70vh;overflow-y:auto">
        <h3 class="modal-title" style="margin-bottom:12px">${UI.escapeHtml(displayTitle)}</h3>

        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">${seasonTabs}</div>
        <div id="phantomTransWrap" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">${transButtons}</div>

        <div id="phantomEpisodes" class="online-results-list">
          ${epList}
        </div>
      </div>
    `;

    UI.modal.open(html);

    // Season tabs
    document.querySelectorAll('.phantom-season-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        this._phantomCurrentSeason = tab.dataset.season;
        this._renderPhantomSeason(tab.dataset.season);
      });
    });

    // Translation tabs
    document.querySelectorAll('.phantom-trans-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const voice = tab.dataset.voice;
        document.querySelectorAll('.phantom-trans-tab').forEach(b => {
          b.style.background = 'var(--bg-secondary)';
          b.style.color = 'var(--text-primary)';
          b.classList.remove('active');
        });
        tab.style.background = 'var(--accent)';
        tab.style.color = '#fff';
        tab.classList.add('active');

        const episodes = seasons[seasonKey]?.[voice] || [];
        const epListEl = document.getElementById('phantomEpisodes');
        if (epListEl) {
          epListEl.innerHTML = episodes.map(ep => `
            <div class="online-result-item" data-id="${ep.id}" style="cursor:pointer">
              <div class="online-result-info">
                <div class="online-result-title">${ep.episode} серия</div>
              </div>
              <button class="btn btn-sm btn-primary phantom-play-ep" data-id="${ep.id}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
              </button>
            </div>
          `).join('');
          this._initPhantomEpButtons(tokenMovie, displayTitle);
        }
      });
    });

    this._initPhantomEpButtons(tokenMovie, displayTitle);
  },

  _initPhantomEpButtons(tokenMovie, displayTitle) {
    document.querySelectorAll('.phantom-play-ep').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idFile = btn.dataset.id;
        this.openPhantomStream(tokenMovie, idFile, displayTitle);
      });
    });
  },

  /**
   * Fetch stream URLs and open the HLS player
   */
  async openPhantomStream(tokenMovie, idFile, displayTitle) {
    UI.modal.close();

    // Show loading in a temporary modal
    const loadingHtml = `
      <div style="text-align:center;padding:40px">
        <div class="loading-spinner"><div class="spinner"></div></div>
        <p style="color:var(--text-secondary);margin-top:12px">Загрузка стрима...</p>
      </div>`;
    UI.modal.open(loadingHtml);

    try {
      const result = await API.phantom.stream(tokenMovie, idFile);

      if (!result.streams || result.streams.length === 0) {
        UI.modal.close();
        UI.toast('Стримы не найдены', 'error');
        return;
      }

      UI.modal.close();

      // Open player
      const proxyUrl = result.streams[0].proxyUrl;
      VideoPlayer.open(proxyUrl, displayTitle);

    } catch (err) {
      UI.modal.close();
      console.error('[Phantom] stream error:', err);
      UI.toast('Ошибка загрузки стрима: ' + err.message, 'error');
    }
  },

  openAddModal(title, type, poster, year) {
    this._addTitle = title;
    this._addPoster = poster;
    this._addYear = year;
    this._addType = type;

    const searchQuery = year ? `${title} (${year})` : title;

    const html = `
      <div class="online-modal">
        <h3 class="modal-title">+ Добавить в TorrServer</h3>
        <p style="color:var(--text-secondary);margin-bottom:16px;font-size:0.9rem">
          Поиск торрента: <strong>${UI.escapeHtml(searchQuery)}</strong>
        </p>
        
        <div id="addSearchStatus" style="text-align:center;padding:20px">
          <div class="loading-spinner"><div class="spinner"></div></div>
          <p style="color:var(--text-secondary);margin-top:8px">Поиск...</p>
        </div>
        
        <div id="addResults" style="display:none"></div>
      </div>
    `;

    UI.modal.open(html);
    this.searchForAdd(searchQuery, type);
  },

  async searchForAdd(query, type) {
    const statusEl = document.getElementById('addSearchStatus');
    const resultsEl = document.getElementById('addResults');
    
    try {
      const data = await API.streaming.search(query, type);
      const results = data.results || [];

      statusEl.style.display = 'none';
      resultsEl.style.display = 'block';

      if (results.length === 0) {
        resultsEl.innerHTML = `
          <div style="text-align:center;padding:20px;color:var(--text-secondary)">
            <p>Ничего не найдено</p>
          </div>
        `;
        return;
      }

      const shown = results;

      resultsEl.innerHTML = `
        <div class="online-results-list">
          ${shown.map((r, i) => `
            <div class="online-result-item" data-index="${i}">
              <div class="online-result-info">
                <div class="online-result-title">${UI.escapeHtml(r.title)}</div>
                <div class="online-result-meta">
                  ${r.quality ? `<span class="online-badge">${r.quality}</span>` : ''}
                  ${r.voiceover ? `<span class="online-badge badge-voice">${UI.escapeHtml(r.voiceover)}</span>` : ''}
                  <span>${this.formatSize(r.size)}</span>
                  <span>▲ ${r.seeders}</span>
                </div>
              </div>
              <button class="btn btn-sm btn-primary online-play-btn" data-index="${i}">+</button>
            </div>
          `).join('')}
        </div>
        <p style="color:var(--text-secondary);font-size:0.8rem;margin-top:12px;text-align:center">
          ${results.length} результатов
        </p>
      `;

      resultsEl.querySelectorAll('.online-play-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = parseInt(btn.dataset.index);
          this.addToTorrServer(shown[idx]);
        });
      });

    } catch (err) {
      statusEl.innerHTML = `
        <div style="text-align:center;padding:20px;color:var(--error)">
          <p>Ошибка поиска</p>
          <p style="font-size:0.85rem;margin-top:8px">${UI.escapeHtml(err.message)}</p>
        </div>
      `;
    }
  },

  async addToTorrServer(torrent) {
    const resultsEl = document.getElementById('addResults');
    if (!resultsEl) return;

    const magnet = torrent.magnetUri || torrent.link;
    if (!magnet) {
      UI.toast('Нет ссылки на торрент', 'error');
      return;
    }

    resultsEl.innerHTML = `
      <div style="text-align:center;padding:30px">
        <div class="loading-spinner"><div class="spinner"></div></div>
        <p style="color:var(--text-secondary);margin-top:12px">Добавление в TorrServer...</p>
      </div>
    `;

    try {
      const posterUrl = this._addPoster || '';
      const fullName = this._addTitle || '';
      const type = this._addType || 'movie';

      // Получаем tmdbId из URL
      const urlMatch = window.location.hash.match(/#\/(movie|tv)\/(\d+)/);
      const tmdbId = urlMatch ? parseInt(urlMatch[2]) : null;

      const result = await API.streaming.play(magnet, fullName, posterUrl, tmdbId, type);

      // Показываем успех (фильмы и сериалы — одинаковый flow)
      this.showAddSuccess(fullName, result.strmPath, tmdbId, result.jellyfinUrl, result.count);

    } catch (err) {
      resultsEl.innerHTML = `
        <div style="text-align:center;padding:20px;color:var(--error)">
          <p>Ошибка добавления</p>
          <p style="font-size:0.85rem;margin-top:8px">${UI.escapeHtml(err.message)}</p>
          <button class="btn btn-secondary btn-sm" style="margin-top:12px" onclick="UI.modal.close()">Закрыть</button>
        </div>
      `;
    }
  },

  showAddSuccess(fullName, strmPath, tmdbId, jellyfinUrl = null, count = null) {
    const modalContent = document.getElementById('modalContent');
    if (!modalContent) return;

    const fileCount = count || (strmPath ? 1 : 0);
    const fileWord = fileCount === 1 ? 'файл' : (fileCount > 1 && fileCount < 5 ? 'файла' : 'файлов');

    modalContent.innerHTML = `
      <div style="text-align:center;padding:20px">
        <div style="font-size:3rem;margin-bottom:12px">✅</div>
        <h3 class="modal-title">Добавлено!</h3>
        <p style="color:var(--text-secondary);margin-bottom:16px">${UI.escapeHtml(fullName)}</p>

        <p style="color:var(--text-secondary);font-size:0.85rem;margin-bottom:16px">
          Создано <strong>${fileCount}</strong> .strm ${fileWord}
        </p>

        ${strmPath ? `
          <div style="margin-bottom:16px">
            <p style="color:var(--text-secondary);font-size:0.85rem;margin-bottom:8px">
              .strm файл сохранён:
            </p>
            <div style="background:var(--bg-tertiary);padding:10px;border-radius:var(--radius);word-break:break-all;font-family:monospace;font-size:0.75rem;color:var(--text-primary)">
              ${strmPath}
            </div>
          </div>
        ` : ''}

        ${jellyfinUrl ? `
          <a href="${jellyfinUrl}" target="_blank" class="btn btn-secondary" style="width:100%;justify-content:center;margin-bottom:8px;text-decoration:none;display:flex;align-items:center;gap:8px">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z"/>
            </svg>
            Смотреть в Jellyfin
          </a>
        ` : ''}

        <button class="btn btn-primary" onclick="UI.modal.close()" style="width:100%;justify-content:center;margin-top:8px">OK</button>
      </div>
    `;

    if (tmdbId) {
      const urlMatch = window.location.hash.match(/#\/(movie|tv)\/(\d+)/);
      if (urlMatch) {
        setTimeout(() => this.render(`/${urlMatch[1]}/${tmdbId}`), 1000);
      }
    }
  },

  showSeriesSetup(result, title, tmdbId) {
    const modalContent = document.getElementById('modalContent');
    if (!modalContent) return;

    // Пытаемся угадать сезон из имён файлов
    const guessedSeason = this.guessSeason(result.files);

    const html = `
      <div style="padding:20px">
        <h3 class="modal-title" style="margin-bottom:8px">Настройка сериала</h3>
        <p style="color:var(--text-secondary);margin-bottom:16px;font-size:0.9rem">
          Найдено файлов: <strong>${result.files.length}</strong>
        </p>

        <div style="margin-bottom:16px">
          <label style="display:block;color:var(--text-secondary);font-size:0.85rem;margin-bottom:6px">
            Номер сезона:
          </label>
          <select id="seriesSeason" style="
            width:100%;padding:8px 12px;border-radius:var(--radius);
            background:var(--bg-tertiary);color:var(--text-primary);
            border:1px solid var(--border);font-size:0.95rem;
          ">
            ${[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15].map(n =>
              `<option value="${n}" ${n === guessedSeason ? 'selected' : ''}>Сезон ${n}</option>`
            ).join('')}
          </select>
        </div>

        <div style="margin-bottom:16px">
          <div style="color:var(--text-secondary);font-size:0.85rem;margin-bottom:8px">
            Файлы в торренте:
          </div>
          <div style="
            max-height:200px;overflow-y:auto;
            background:var(--bg-tertiary);border-radius:var(--radius);
            padding:8px 12px;font-size:0.8rem;color:var(--text-secondary);
          ">
            ${result.files.map((f, i) => {
              const parsed = this._parseEpisode(f.name);
              const size = f.size > 1024*1024*1024
                ? (f.size / (1024*1024*1024)).toFixed(1) + ' GB'
                : f.size > 1024*1024
                  ? (f.size / (1024*1024)).toFixed(0) + ' MB'
                  : '';
              return `
                <div style="padding:3px 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
                  <span style="word-break:break-all;flex:1;margin-right:8px">
                    ${UI.escapeHtml(f.name)}
                  </span>
                  <span style="white-space:nowrap;color:var(--text-tertiary);font-size:0.75rem">
                    ${parsed ? `<span style="color:var(--accent);margin-right:6px">${parsed}</span>` : ''}
                    ${size}
                  </span>
                </div>
              `;
            }).join('')}
          </div>
        </div>

        <div style="margin-bottom:12px;color:var(--text-secondary);font-size:0.85rem" id="seriesPreview">
          Будет создано: <strong>${result.files.length}</strong> .strm файлов
          в <code>serials/${UI.escapeHtml(title)}/Season ${String(guessedSeason).padStart(2, '0')}/</code>
        </div>

        <button class="btn btn-primary" id="saveSeriesBtn" style="width:100%;justify-content:center">
          Сохранить ${result.files.length} .strm файлов
        </button>
      </div>
    `;

    modalContent.innerHTML = html;

    // Обновление превью при смене сезона
    document.getElementById('seriesSeason').addEventListener('change', (e) => {
      const s = parseInt(e.target.value);
      document.getElementById('seriesPreview').innerHTML = `
        Будет создано: <strong>${result.files.length}</strong> .strm файлов
        в <code>serials/${UI.escapeHtml(title)}/Season ${String(s).padStart(2, '0')}/</code>
      `;
    });

    // Кнопка сохранения
    document.getElementById('saveSeriesBtn').addEventListener('click', async () => {
      const season = parseInt(document.getElementById('seriesSeason').value);
      const btn = document.getElementById('saveSeriesBtn');
      btn.disabled = true;
      btn.textContent = 'Сохранение...';

      try {
        const created = await API.streaming.saveSeries(
          result.hash, title, season, result.files, tmdbId
        );

        const jellyfinUrl = created.jellyfinUrl || result.jellyfinUrl;

        modalContent.innerHTML = `
          <div style="text-align:center;padding:20px">
            <div style="font-size:3rem;margin-bottom:12px">✅</div>
            <h3 class="modal-title">Сохранено!</h3>
            <p style="color:var(--text-secondary);margin-bottom:16px">
              Создано <strong>${created.count}</strong> .strm файлов
            </p>
            <div style="
              background:var(--bg-tertiary);padding:12px;border-radius:var(--radius);
              text-align:left;font-size:0.75rem;max-height:200px;overflow-y:auto;
              margin-bottom:16px;font-family:monospace;color:var(--text-secondary);
            ">
              ${(created.created || []).map(f => `S${String(f.season).padStart(2,'0')}E${String(f.episode).padStart(2,'0')} → ${f.path}`).join('<br>')}
            </div>
            ${jellyfinUrl ? `
              <a href="${jellyfinUrl}" target="_blank" class="btn btn-secondary" style="width:100%;justify-content:center;margin-bottom:8px;text-decoration:none;display:flex;align-items:center;gap:8px">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z"/>
                </svg>
                Смотреть в Jellyfin
              </a>
            ` : ''}
            <button class="btn btn-primary" onclick="UI.modal.close()" style="width:100%;justify-content:center">OK</button>
          </div>
        `;

        if (tmdbId) {
          const urlMatch = window.location.hash.match(/#\/(movie|tv)\/(\d+)/);
          if (urlMatch) {
            setTimeout(() => this.render(`/${urlMatch[1]}/${tmdbId}`), 1000);
          }
        }
      } catch (err) {
        btn.disabled = false;
        btn.textContent = `Сохранить ${result.files.length} .strm файлов`;
        UI.toast('Ошибка сохранения: ' + err.message, 'error');
      }
    });
  },

  /**
   * Попытка угадать сезон по именам файлов торрента
   */
  guessSeason(files) {
    for (const f of files) {
      const name = f.name || '';
      // S01E01 → сезон 1
      const m = name.match(/S(\d{1,2})E/i);
      if (m) return parseInt(m[1]);
      // Season 01 → сезон 1
      const s = name.match(/Season[\s._-]*(\d{1,2})/i);
      if (s) return parseInt(s[1]);
    }
    return 1;
  },

  /**
   * Парсинг эпизода из имени файла для отображения в UI
   */
  _parseEpisode(name) {
    if (!name) return null;
    const m = name.match(/S(\d{1,2})E(\d{1,3})/i);
    if (m) return `S${m[1].padStart(2,'0')}E${m[2].padStart(2,'0')}`;
    const b = name.match(/\[(\d{1,3})\]/);
    if (b) return `Ep ${b[1]}`;
    return null;
  },

  // ===== Клик по актёру =====
  initCastClickEvents() {
    document.querySelectorAll('.cast-card[data-person-id]').forEach(card => {
      card.addEventListener('click', () => {
        const personId = card.dataset.personId;
        if (personId) this.showPersonModal(personId);
      });
    });
  },

  initJellyfinRefreshButton(type, id) {
    const btn = document.getElementById('refreshJellyfinBtn');
    if (!btn) return;

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.innerHTML = `
        <div class="loading-spinner" style="width:16px;height:16px"><div class="spinner" style="width:16px;height:16px;border-width:2px"></div></div>
        Поиск...
      `;

      try {
        const result = await API.streaming.refreshJellyfin(type, id);
        
        if (result.jellyfinUrl) {
          UI.toast('Ссылка найдена!', 'success');
          // Перезагружаем страницу чтобы показать кнопку "Смотреть"
          setTimeout(() => this.render(`/${type}/${id}`), 1000);
        } else {
          UI.toast('Не найдено в Jellyfin', 'error');
          btn.disabled = false;
          btn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M23 4v6h-6M1 20v-6h6"/>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
            </svg>
            Повторить
          `;
        }
      } catch (err) {
        UI.toast('Ошибка: ' + err.message, 'error');
        btn.disabled = false;
        btn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M23 4v6h-6M1 20v-6h6"/>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
          </svg>
          Повторить
        `;
      }
    });
  },

  async showPersonModal(personId) {
    // Показываем загрузку
    UI.modal.open(`
      <div style="text-align:center;padding:40px">
        <div class="loading-spinner"><div class="spinner"></div></div>
        <p style="color:var(--text-secondary);margin-top:12px">Загрузка...</p>
      </div>
    `);

    try {
      const person = await API.tmdb.person(personId);

      const name = person.name || 'Неизвестно';
      const photo = person.profile_path
        ? IMG.profile(person.profile_path, 'h632')
        : '';
      const bio = person.biography || 'Биография отсутствует';
      const birthday = person.birthday || '';
      const birthplace = person.place_of_birth || '';
      const knownFor = person.known_for_department || 'Актёрское мастерство';

      // Собираем фильмы и сериалы, сортируем по дате (новые сверху)
      const movies = (person.movie_credits?.cast || [])
        .filter(m => m.release_date)
        .sort((a, b) => b.release_date.localeCompare(a.release_date));

      const tvShows = (person.tv_credits?.cast || [])
        .filter(t => t.first_air_date)
        .sort((a, b) => b.first_air_date.localeCompare(a.first_air_date));

      const renderFilmography = (items, isTv) => {
        if (!items.length) return '<p style="color:var(--text-secondary);font-size:0.85rem">Нет данных</p>';
        return items.map(item => {
          const title = item.title || item.name || 'Без названия';
          const date = isTv ? item.first_air_date : item.release_date;
          const year = date ? date.slice(0, 4) : '';
          const rating = item.vote_average ? item.vote_average.toFixed(1) : '';
          const character = item.character || '';
          const tmdbType = isTv ? 'tv' : 'movie';
          return `
            <div class="person-film-item" onclick="UI.modal.close();window.location.hash='#/${tmdbType}/${item.id}'" style="cursor:pointer">
              <div class="person-film-info">
                <span class="person-film-title">${UI.escapeHtml(title)}</span>
                ${character ? `<span class="person-film-character"> как ${UI.escapeHtml(character)}</span>` : ''}
              </div>
              <div class="person-film-meta">
                ${year ? `<span class="person-film-year">${year}</span>` : ''}
                ${rating ? `<span class="person-film-rating">${rating}</span>` : ''}
              </div>
            </div>
          `;
        }).join('');
      };

      const html = `
        <div class="person-modal">
          <div class="person-header">
            ${photo
              ? `<img src="${photo}" alt="${UI.escapeHtml(name)}" class="person-photo">`
              : `<div class="person-photo-placeholder">👤</div>`
            }
            <div class="person-info">
              <h2 class="person-name">${UI.escapeHtml(name)}</h2>
              <div class="person-meta">
                <span>${UI.escapeHtml(knownFor)}</span>
                ${birthday ? `<span>📅 ${birthday}</span>` : ''}
              </div>
              ${birthplace ? `<div class="person-birthplace">📍 ${UI.escapeHtml(birthplace)}</div>` : ''}
            </div>
          </div>

          ${bio && bio !== 'Биография отсутствует' ? `
            <div class="person-section">
              <h4>Биография</h4>
              <p class="person-bio">${UI.escapeHtml(bio)}</p>
            </div>
          ` : ''}

          ${movies.length ? `
            <div class="person-section">
              <h4>Фильмы (${movies.length})</h4>
              <div class="person-filmography">${renderFilmography(movies, false)}</div>
            </div>
          ` : ''}

          ${tvShows.length ? `
            <div class="person-section">
              <h4>Сериалы (${tvShows.length})</h4>
              <div class="person-filmography">${renderFilmography(tvShows, true)}</div>
            </div>
          ` : ''}
        </div>
      `;

      UI.modal.open(html);

    } catch (err) {
      console.error('Ошибка загрузки актёра:', err);
      UI.modal.open(`
        <div style="text-align:center;padding:30px">
          <p style="color:var(--error)">Не удалось загрузить информацию</p>
          <p style="color:var(--text-secondary);font-size:0.85rem;margin-top:8px">${UI.escapeHtml(err.message)}</p>
          <button class="btn btn-secondary btn-sm" style="margin-top:16px" onclick="UI.modal.close()">Закрыть</button>
        </div>
      `);
    }
  },

  formatSize(bytes) {
    if (!bytes) return '';
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) return gb.toFixed(1) + ' GB';
    const mb = bytes / (1024 * 1024);
    return mb.toFixed(0) + ' MB';
  },
};
