// HLS Video Player — plays m3u8 streams from Phantom proxy
// Uses hls.js from CDN for cross-browser HLS support
const PhantomPlayer = {
  _hls: null,
  _modal: null,

  /**
   * Open player modal with stream data
   * @param {Object} opts
   * @param {string} opts.title — movie/episode title
   * @param {Array} opts.streams — [{ quality, proxyUrl }]
   * @param {string} opts.defaultUrl — default stream proxy URL
   */
  open({ title, streams, defaultUrl }) {
    if (!streams || streams.length === 0) {
      UI.toast('Нет доступных стримов', 'error');
      return;
    }

    // Sort streams by quality (highest first)
    const sorted = [...streams].sort((a, b) => {
      const qa = parseInt(a.quality) || 0;
      const qb = parseInt(b.quality) || 0;
      return qb - qa;
    });

    const qualityButtons = sorted.map((s, i) =>
      `<button class="phantom-quality-btn ${i === 0 ? 'active' : ''}"
              data-url="${this._escHtml(s.proxyUrl)}"
              data-quality="${this._escHtml(s.quality)}"
              style="padding:6px 14px;border:1px solid var(--border-color);border-radius:var(--radius);
                     background:${i === 0 ? 'var(--accent)' : 'var(--bg-secondary)'};
                     color:${i === 0 ? '#fff' : 'var(--text-primary)'};
                     cursor:pointer;font-size:0.85rem;transition:all 0.2s">
        ${this._escHtml(s.quality)}
      </button>`
    ).join('');

    const html = `
      <div class="phantom-player-modal" style="max-width:800px;width:100%">
        <h3 class="modal-title" style="margin-bottom:12px">${this._escHtml(title)}</h3>

        <div class="phantom-player-container" style="position:relative;width:100%;padding-top:56.25%;background:#000;border-radius:var(--radius-lg);overflow:hidden;margin-bottom:12px">
          <video id="phantomVideo" controls autoplay
                 style="position:absolute;top:0;left:0;width:100%;height:100%;background:#000">
          </video>
          <div id="phantomPlayerOverlay" style="position:absolute;top:0;left:0;width:100%;height:100%;
               display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.7)">
            <div class="loading-spinner"><div class="spinner" style="width:40px;height:40px"></div></div>
          </div>
        </div>

        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
          <span style="color:var(--text-secondary);font-size:0.85rem">Качество:</span>
          ${qualityButtons}
        </div>

        <div id="phantomPlayerStatus" style="color:var(--text-secondary);font-size:0.8rem;min-height:20px"></div>
      </div>
    `;

    UI.modal.open(html);
    this._modal = document.getElementById('modalContent');

    // Init HLS player with first stream
    const initialUrl = defaultUrl || sorted[0].proxyUrl;
    this._initPlayer(initialUrl);

    // Quality button handlers
    this._modal.querySelectorAll('.phantom-quality-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = btn.dataset.url;

        // Update active state
        this._modal.querySelectorAll('.phantom-quality-btn').forEach(b => {
          b.style.background = 'var(--bg-secondary)';
          b.style.color = 'var(--text-primary)';
          b.classList.remove('active');
        });
        btn.style.background = 'var(--accent)';
        btn.style.color = '#fff';
        btn.classList.add('active');

        this._switchStream(url);
      });
    });
  },

  /**
   * Initialize HLS.js player
   */
  _initPlayer(url) {
    this._destroy();

    const video = document.getElementById('phantomVideo');
    const overlay = document.getElementById('phantomPlayerOverlay');
    const status = document.getElementById('phantomPlayerStatus');
    if (!video) return;

    console.log('[PhantomPlayer] loadSource URL length:', url.length, 'URL start:', url.substring(0, 80));

    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      console.log('[PhantomPlayer] Using hls.js version:', Hls.version);
      const hls = new Hls({
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        startFragPrefetch: true,
      });
      this._hls = hls;

      hls.loadSource(url);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, (e, data) => {
        console.log('[PhantomPlayer] MANIFEST_PARSED, levels:', data.levels.length);
        if (overlay) overlay.style.display = 'none';
        video.play().catch(() => {});
        const levels = hls.levels || [];
        if (status) {
          const qualities = levels.map(l => l.height + 'p').join(', ');
          status.textContent = qualities ? `Доступно: ${qualities}` : '';
        }
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        console.error('[PhantomPlayer] HLS ERROR:', data.type, data.details, 'url:', data.url || url, 'response:', data.response ? { status: data.response.status, text: data.response.statusText } : 'none');
        if (data.fatal) {
          console.error('[PhantomPlayer] FATAL:', data.type, data.details);
          if (overlay) {
            overlay.innerHTML = `
              <div style="text-align:center;padding:20px;color:#ff6b6b">
                <p>Ошибка воспроизведения</p>
                <p style="font-size:0.8rem;margin-top:8px">${data.details || data.type}</p>
                <button class="btn btn-sm btn-secondary" style="margin-top:12px"
                        onclick="PhantomPlayer._initPlayer('${this._escHtml(url)}')">
                  Повторить
                </button>
              </div>`;
          }
          if (status) status.textContent = 'Ошибка: ' + (data.details || data.type);
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS (Safari)
      video.src = url;
      video.addEventListener('loadeddata', () => {
        if (overlay) overlay.style.display = 'none';
      });
    } else {
      // No HLS support
      if (overlay) {
        overlay.innerHTML = `
          <div style="text-align:center;padding:20px;color:#ff6b6b">
            <p>Ваш браузер не поддерживает HLS</p>
            <p style="font-size:0.8rem;margin-top:8px">Попробуйте Chrome, Firefox или Safari</p>
          </div>`;
      }
    }
  },

  /**
   * Switch to a different stream
   */
  _switchStream(url) {
    const video = document.getElementById('phantomVideo');
    const overlay = document.getElementById('phantomPlayerOverlay');
    const status = document.getElementById('phantomPlayerStatus');

    if (!video) return;

    if (this._hls) {
      // HLS.js — load new source
      this._hls.loadSource(url);
      if (status) status.textContent = 'Загрузка...';
    } else {
      // Native HLS
      video.src = url;
    }

    if (overlay) {
      overlay.style.display = 'flex';
      overlay.innerHTML = '<div class="loading-spinner"><div class="spinner" style="width:40px;height:40px"></div></div>';
    }
  },

  /**
   * Clean up
   */
  _destroy() {
    if (this._hls) {
      this._hls.destroy();
      this._hls = null;
    }
  },

  /**
   * HTML escape
   */
  _escHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  },
};

// Load hls.js from local bundle
(function loadHlsJs() {
  if (typeof Hls !== 'undefined') return; // Already loaded
  const script = document.createElement('script');
  script.src = '/js/hls.min.js';
  script.onload = () => console.log('[PhantomPlayer] hls.js loaded locally');
  script.onerror = () => console.error('[PhantomPlayer] Failed to load hls.js');
  document.head.appendChild(script);
})();
