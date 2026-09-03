// Авторизация: логин, регистрация
const Auth = {
  renderLogin() {
    const app = document.getElementById('app');
    app.innerHTML = `
      <div class="auth-form">
        <h2>Вход</h2>
        <form id="loginForm">
          <div class="form-group">
            <label>Email</label>
            <input type="email" id="loginEmail" required autocomplete="email">
          </div>
          <div class="form-group">
            <label>Пароль</label>
            <input type="password" id="loginPassword" required autocomplete="current-password">
          </div>
          <div class="error" id="loginError"></div>
          <button type="submit" class="btn btn-primary">Войти</button>
        </form>
        <p style="text-align:center;margin-top:16px;font-size:0.85rem;color:var(--text-secondary)">
          Нет аккаунта? <a href="#/register" style="color:var(--accent-red)">Зарегистрироваться</a>
        </p>
      </div>
    `;
    
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errorEl = document.getElementById('loginError');
      errorEl.textContent = '';
      
      try {
        const email = document.getElementById('loginEmail').value;
        const password = document.getElementById('loginPassword').value;
        
        const data = await API.auth.login(email, password);
        App.currentUser = data.user;
        App.updateUserUI();
        UI.toast('Добро пожаловать!');
        window.location.hash = '#/';
      } catch (err) {
        errorEl.textContent = err.message;
      }
    });
  },

  renderRegister() {
    const app = document.getElementById('app');
    app.innerHTML = `
      <div class="auth-form">
        <h2>Регистрация</h2>
        <form id="registerForm">
          <div class="form-group">
            <label>Имя пользователя</label>
            <input type="text" id="regUsername" required autocomplete="username">
          </div>
          <div class="form-group">
            <label>Email</label>
            <input type="email" id="regEmail" required autocomplete="email">
          </div>
          <div class="form-group">
            <label>Пароль (минимум 6 символов)</label>
            <input type="password" id="regPassword" required minlength="6" autocomplete="new-password">
          </div>
          <div class="error" id="regError"></div>
          <button type="submit" class="btn btn-primary">Зарегистрироваться</button>
        </form>
        <p style="text-align:center;margin-top:16px;font-size:0.85rem;color:var(--text-secondary)">
          Уже есть аккаунт? <a href="#/login" style="color:var(--accent-red)">Войти</a>
        </p>
      </div>
    `;
    
    document.getElementById('registerForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errorEl = document.getElementById('regError');
      errorEl.textContent = '';
      
      try {
        const username = document.getElementById('regUsername').value;
        const email = document.getElementById('regEmail').value;
        const password = document.getElementById('regPassword').value;
        
        const data = await API.auth.register(username, email, password);
        App.currentUser = data.user;
        App.updateUserUI();
        UI.toast('Аккаунт создан!');
        window.location.hash = '#/';
      } catch (err) {
        errorEl.textContent = err.message;
      }
    });
  },
};
