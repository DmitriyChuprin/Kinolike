import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { MovieCard } from '../components/ui';
import { Icon } from '../components/Icon';
import { api, imageUrl, toMovie, type TmdbItem } from '../services/api';
import { useAuth } from '../App';
import type { Movie } from '../types';

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const query = params.get('q') || '';
  const type = params.get('type') || 'multi';
  const year = params.get('year') || '';
  const sort = params.get('sort') || 'relevance';
  const [input, setInput] = useState(query);
  const [yearInput, setYearInput] = useState(year);
  const [results, setResults] = useState<TmdbItem[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const key = JSON.stringify([query, type, year, sort]);
  const [loadedKey, setLoadedKey] = useState(key);
  useEffect(() => { setInput(query); }, [query]);
  useEffect(() => { setYearInput(year); }, [year]);
  useEffect(() => { setResults([]); setTotal(0); setPage(1); setLoadedKey(key); }, [key]);
  useEffect(() => {
    if (loadedKey !== key) return;
    if (query.trim().length < 2) { setLoading(false); setTotalPages(0); setError(''); return; }
    let cancelled = false;
    setLoading(true); setError('');
    api.tmdb.search(query, type, page, { year, sort }).then(data => {
      if (cancelled) return;
      setResults(current => page === 1 ? data.results : [...current, ...data.results].filter((item, index, all) => all.findIndex(other => other.id === item.id && other.media_type === item.media_type) === index));
      setTotal(data.total_results); setTotalPages(data.total_pages);
    }).catch(error => { if (!cancelled) setError(error instanceof Error ? error.message : 'Ошибка поиска'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [query, type, page, year, sort, retry, key, loadedKey]);
  const update = (values: Record<string, string>) => { const next = new URLSearchParams(params); Object.entries(values).forEach(([key, value]) => value ? next.set(key, value) : next.delete(key)); setParams(next); };
  const submit = (event: FormEvent) => { event.preventDefault(); if (input.trim().length >= 2) update({ q: input.trim() }); };
  const requireLogin = () => { navigate(`/login?next=${encodeURIComponent('/search?' + params.toString())}`); };
  const add = async (movie: Movie) => { if (!user) { requireLogin(); return; } await api.lists.add(movie.id, movie.mediaType); };
  return <div className="search-page">
    <form className="search-page-form glass-panel" onSubmit={submit}><input value={input} onChange={event => setInput(event.target.value)} placeholder="Фильмы, сериалы, актёры…" aria-label="Поисковый запрос" minLength={2} maxLength={200} autoFocus /><button className="primary-button"><Icon name="search" /> Найти</button></form>
    <p className="eyebrow">РЕЗУЛЬТАТЫ ПОИСКА</p><h1>Поиск{query && `: ${query}`}</h1>
    <p className="page-subtitle" role="status">{loading && !results.length ? 'Ищем совпадения…' : query ? `Найдено: ${total.toLocaleString('ru-RU')} · показано: ${results.length}` : 'Введите название фильма, сериала или имя актёра'}</p>
    <div className="search-toolbar glass-panel">
      <select aria-label="Тип результата" value={type} onChange={event => update({ type: event.target.value, ...(event.target.value === 'person' ? { year: '', sort: 'relevance' } : {}) })}><option value="multi">Все типы</option><option value="movie">Фильмы</option><option value="tv">Сериалы</option><option value="person">Люди</option></select>
      {type !== 'person' && <input className="year-filter" value={yearInput} onChange={event => { const value = event.target.value.replace(/\D/g, '').slice(0, 4); setYearInput(value); if (!value || /^[1-9]\d{3}$/.test(value)) update({ year: value }); }} placeholder="Год" aria-label="Год выхода" inputMode="numeric" />}
      <select aria-label="Сортировка" value={sort} onChange={event => update({ sort: event.target.value })}><option value="relevance">По совпадению</option><option value="popularity">По популярности</option>{type !== 'person' && <><option value="rating">По рейтингу</option><option value="year">По дате выхода</option></>}</select>
      {(year || type !== 'multi' || sort !== 'relevance') && <button className="filter-reset" onClick={() => update({ year: '', type: '', sort: '' })}>Сбросить</button>}
    </div>
    {yearInput && yearInput !== year && <p className="form-message">Введите год полностью — четыре цифры.</p>}
    {error && <div className="empty-inline glass-panel" role="alert"><p>{error}</p><button className="secondary-button" onClick={() => setRetry(value => value + 1)}>Повторить</button></div>}
    <div className="list-grid search-results" aria-busy={loading}>{results.map(item => item.media_type === 'person'
      ? <Link className="person-search-card glass-panel" key={`person-${item.id}`} to={`/person/${item.id}`}>{item.profile_path ? <img src={imageUrl(item.profile_path)} alt={item.name} loading="lazy" /> : <span className="poster-placeholder"><Icon name="film" /></span>}<h3>{item.name}</h3><p>{item.known_for_department === 'Acting' ? 'Актёр / актриса' : 'Персона'}</p></Link>
      : <MovieCard movie={toMovie(item)} key={`${item.media_type}-${item.id}`} onAdd={add} />)}</div>
    {loading && results.length > 0 && <p className="loading-status" role="status">Загружаем…</p>}
    {!loading && query.length >= 2 && !results.length && !error && <div className="empty-page glass-panel"><Icon name="search" /><h2>Ничего не найдено</h2><p>Попробуйте другой запрос или сбросьте фильтры.</p></div>}
    {page < totalPages && !error && <div className="load-more"><button className="secondary-button" onClick={() => setPage(value => value + 1)} disabled={loading}>{loading ? 'Загружаем…' : 'Загрузить ещё'}</button></div>}
  </div>;
}

export function AuthPage({ register = false }: { register?: boolean }) {
  const { user, login, register: createAccount } = useAuth(); const navigate = useNavigate(); const [params] = useSearchParams(); const next = params.get('next') || '/'; const [username, setUsername] = useState(''); const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { if (user) navigate(next.startsWith('/') ? next : '/', { replace: true }); }, [user, navigate, next]);
  const submit = async (event: FormEvent) => { event.preventDefault(); setError(''); setBusy(true); try { if (register) await createAccount(username.trim(), email.trim(), password); else await login(email.trim(), password); navigate(next.startsWith('/') ? next : '/', { replace: true }); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Не удалось выполнить запрос'); } finally { setBusy(false); } };
  return <div className="auth-page glass-panel"><span className="brand-mark">✣</span><p className="eyebrow">KINOLIKE</p><h1>{register ? 'Создать аккаунт' : 'С возвращением'}</h1><p>{register ? 'Соберите свою личную коллекцию' : 'Войдите, чтобы продолжить'}</p><form onSubmit={submit}>{register && <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Имя пользователя" required minLength={2} autoComplete="username" />}<input value={email} onChange={(event) => setEmail(event.target.value)} type="email" placeholder="Email" required autoComplete="email" /><input value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder="Пароль" required minLength={6} autoComplete={register ? 'new-password' : 'current-password'} />{error && <p className="error-message">{error}</p>}<button className="primary-button" type="submit" disabled={busy}>{busy ? 'Подождите…' : register ? 'Зарегистрироваться' : 'Войти'} <span>→</span></button></form><Link to={register ? '/login' : '/register'}>{register ? 'Уже есть аккаунт' : 'Создать аккаунт'}</Link></div>;
}
