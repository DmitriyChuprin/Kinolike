// Статистика и профиль
const Stats = {
  async renderProfile() {
    if (!App.currentUser) {
      const app = document.getElementById('app');
      UI.emptyState(app, 'Войдите в аккаунт');
      return;
    }
    
    const app = document.getElementById('app');
    UI.showLoader(app);
    
    try {
      const [stats, watchedStats] = await Promise.all([
        API.stats.overview(),
        API.watched.stats(),
      ]);
      
      const user = App.currentUser;
      const avatarInitial = user.username ? user.username[0].toUpperCase() : '?';
      
      app.innerHTML = `
        <!-- Заголовок профиля -->
        <div class="profile-header">
          <div class="profile-avatar">
            ${user.avatar_url 
              ? `<img src="${user.avatar_url}" alt="${user.username}">`
              : avatarInitial
            }
          </div>
          <div>
            <h1 style="font-size:1.4rem">${user.username}</h1>
            <p style="color:var(--text-secondary);font-size:0.9rem">${user.email}</p>
          </div>
        </div>
        
        <!-- Статистика -->
        <h2 style="margin-bottom:16px">Статистика</h2>
        <div class="profile-stats">
          <div class="profile-stat">
            <div class="profile-stat-value">${stats.total || 0}</div>
            <div class="profile-stat-label">Всего в списке</div>
          </div>
          <div class="profile-stat">
            <div class="profile-stat-value">${stats.counts?.want_to_watch || 0}</div>
            <div class="profile-stat-label">Хочу посмотреть</div>
          </div>
          <div class="profile-stat">
            <div class="profile-stat-value">${stats.counts?.watching || 0}</div>
            <div class="profile-stat-label">Смотрю</div>
          </div>
          <div class="profile-stat">
            <div class="profile-stat-value">${stats.counts?.watched || 0}</div>
            <div class="profile-stat-label">Просмотрено</div>
          </div>
          <div class="profile-stat">
            <div class="profile-stat-value">${stats.counts?.on_hold || 0}</div>
            <div class="profile-stat-label">Отложено</div>
          </div>
          <div class="profile-stat">
            <div class="profile-stat-value">${stats.avgRating || '—'}</div>
            <div class="profile-stat-label">Средняя оценка</div>
          </div>
        </div>
        
        <!-- Распределение оценок -->
        ${stats.ratingDistribution?.length ? `
          <h2 style="margin-bottom:16px">Распределение оценок</h2>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:32px">
            ${stats.ratingDistribution.map(r => `
              <div style="text-align:center;padding:8px 12px;background:var(--bg-secondary);border-radius:var(--radius);min-width:50px">
                <div style="font-weight:700;font-size:1.1rem;color:${r.rating >= 8 ? 'var(--success)' : r.rating >= 5 ? 'var(--warning)' : 'var(--error)'}">${r.rating}</div>
                <div style="font-size:0.75rem;color:var(--text-secondary)">${r.count}</div>
              </div>
            `).join('')}
          </div>
        ` : ''}
        
        <!-- Настройки -->
        <h2 style="margin-bottom:16px">Настройки</h2>
        <div style="max-width:400px">
          <!-- Тема -->
          <div class="form-group">
            <label>Тема оформления</label>
            <select id="themeSelect" style="width:100%;padding:10px;border-radius:var(--radius);border:1px solid var(--border);background:var(--bg-primary);color:var(--text-primary)">
              <option value="dark" ${document.documentElement.getAttribute('data-theme') === 'dark' ? 'selected' : ''}>Тёмная</option>
              <option value="light" ${document.documentElement.getAttribute('data-theme') === 'light' ? 'selected' : ''}>Светлая</option>
            </select>
          </div>
          
          <!-- Смена пароля -->
          <div class="form-group">
            <label>Сменить пароль</label>
            <input type="password" id="currentPassword" placeholder="Текущий пароль">
            <input type="password" id="newPassword" placeholder="Новый пароль" style="margin-top:8px">
            <button class="btn btn-primary btn-sm" id="changePasswordBtn" style="margin-top:8px">Изменить пароль</button>
          </div>
          
          <!-- Экспорт/импорт -->
          <div class="form-group">
            <label>Данные</label>
            <div style="display:flex;gap:8px">
              <button class="btn btn-secondary btn-sm" id="exportBtn">Экспорт JSON</button>
              <label class="btn btn-secondary btn-sm" style="margin:0">
                Импорт JSON
                <input type="file" id="importFile" accept=".json" style="display:none">
              </label>
            </div>
          </div>
        </div>
      `;
      
      this.initEvents();
      
    } catch (err) {
      console.error('Ошибка загрузки профиля:', err);
      UI.emptyState(app, 'Не удалось загрузить профиль', err.message);
    }
  },

  initEvents() {
    // Тема
    document.getElementById('themeSelect')?.addEventListener('change', (e) => {
      document.documentElement.setAttribute('data-theme', e.target.value);
      localStorage.setItem('theme', e.target.value);
    });
    
    // Смена пароля
    document.getElementById('changePasswordBtn')?.addEventListener('click', async () => {
      const current = document.getElementById('currentPassword').value;
      const newPass = document.getElementById('newPassword').value;
      
      if (!current || !newPass) {
        UI.toast('Заполните оба поля', 'error');
        return;
      }
      
      try {
        await API.auth.changePassword(current, newPass);
        UI.toast('Пароль изменён');
        document.getElementById('currentPassword').value = '';
        document.getElementById('newPassword').value = '';
      } catch (err) {
        UI.toast(err.message, 'error');
      }
    });
    
    // Экспорт
    document.getElementById('exportBtn')?.addEventListener('click', async () => {
      try {
        const data = await API.lists.exportAll();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `kinolike-export-${new Date().toISOString().slice(0,10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        UI.toast('Экспорт завершён');
      } catch (err) {
        UI.toast(err.message, 'error');
      }
    });
    
    // Импорт
    document.getElementById('importFile')?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      
      try {
        const text = await file.text();
        const items = JSON.parse(text);
        await API.lists.importAll(items);
        UI.toast(`Импортировано ${items.length} элементов`);
        this.renderProfile();
      } catch (err) {
        UI.toast('Ошибка импорта: ' + err.message, 'error');
      }
    });
  },
};
