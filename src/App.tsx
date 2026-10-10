import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Icon } from './components/Icon';
import { Sidebar, SearchBar } from './components/ui';
import { api } from './services/api';
import type { User } from './types';

type AuthContextValue = {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (user: User | null) => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.auth.me().then(({ user: currentUser }) => setUser(currentUser)).catch(() => setUser(null)).finally(() => setLoading(false));
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    user, loading, setUser,
    async login(email, password) { const result = await api.auth.login(email, password); localStorage.removeItem('authToken'); setUser(result.user); },
    async register(username, email, password) { const result = await api.auth.register(username, email, password); localStorage.removeItem('authToken'); setUser(result.user); },
    async logout() { await api.auth.logout().catch(() => {}); localStorage.removeItem('authToken'); setUser(null); },
  }), [user, loading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth должен использоваться внутри AuthProvider');
  return context;
}

export function ProtectedRoute() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <LoadingPage />;
  return user ? <Outlet /> : <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
}

export function AppLayout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();
  const search = (query: string) => { if (query) navigate(`/search?q=${encodeURIComponent(query)}`); };
  useEffect(() => { setMenuOpen(false); }, [location.pathname]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, []);
  const initial = user?.username?.[0]?.toUpperCase() || '?';

  return <div className="app-shell">
    <div className={`mobile-scrim ${menuOpen ? 'visible' : ''}`} onClick={() => setMenuOpen(false)} />
    <div className={`sidebar-wrap ${menuOpen ? 'open' : ''}`}><Sidebar user={user} onNavigate={() => setMenuOpen(false)} onLogout={logout} /></div>
    <main className="page-shell">
      <header className="topbar"><button className="mobile-menu-button" onClick={() => setMenuOpen(open => !open)} aria-label={menuOpen ? "Закрыть меню" : "Открыть меню"} aria-expanded={menuOpen}><Icon name="menu" /></button><SearchBar onSubmit={search} /><div className="topbar-actions">{user ? <Link to="/profile" className="profile-chip"><span className="avatar">{initial}</span><span className="profile-name">{user.username}</span></Link> : <Link to="/login" className="secondary-button topbar-login">Войти</Link>}</div></header>
      <div className="route-breadcrumb">{location.pathname !== '/' && <Link to="/">Главная</Link>}{location.pathname !== '/' && <span> / </span>}<span>{location.pathname === '/' ? 'Главная' : location.pathname.startsWith('/taste-profile') ? 'Мои вкусы' : location.pathname.startsWith('/wrapped') ? 'Мой киногод' : location.pathname.startsWith('/stats') ? 'Статистика' : location.pathname.startsWith('/recommendations') ? 'Рекомендации' : location.pathname.startsWith('/watched') ? 'Просмотрено' : location.pathname.startsWith('/want') ? 'Хочу посмотреть' : location.pathname.startsWith('/search') ? 'Поиск' : location.pathname.startsWith('/catalog') ? 'Каталог' : location.pathname.startsWith('/profile') ? 'Профиль' : location.pathname.startsWith('/person') ? 'Персона' : 'О фильме'}</span></div>
      <div className="page-content"><Outlet /></div>
    </main>
    <nav className="mobile-bottom-nav" aria-label="Навигация"><NavLink to="/" end><Icon name="home" /><small>Главная</small></NavLink><NavLink to="/want"><Icon name="bookmark" /><small>Хочу</small></NavLink><NavLink to="/watched"><Icon name="check" /><small>Просмотрено</small></NavLink><NavLink to="/recommendations"><Icon name="star" /><small>Для вас</small></NavLink></nav>
  </div>;
}

export function LoadingPage() { return <div className="empty-page glass-panel"><span className="empty-icon">◌</span><p>Загружаем KinoLike…</p></div>; }
export function NotFoundPage() { return <div className="empty-page glass-panel"><span className="empty-icon">◌</span><h1>Страница не найдена</h1><p>Но хорошее кино всегда где-то рядом.</p><Link className="primary-button" to="/">Вернуться домой</Link></div>; }
