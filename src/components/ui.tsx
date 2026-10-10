/* eslint-disable @typescript-eslint/no-unused-expressions */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { NavLink, Link, useNavigate } from 'react-router-dom';
import type { Genre, Movie } from '../types';
import type { User } from '../types';
import { Icon, type IconName } from './Icon';
import { api } from '../services/api';
import { ThemePicker } from '../theme';

const navItems = [
  { to: '/', label: 'Главная', icon: 'home', end: true },
  { to: '/want', label: 'Хочу посмотреть', icon: 'bookmark' },
  { to: '/watched', label: 'Просмотрено', icon: 'check' },
  { to: '/recommendations', label: 'Рекомендации', icon: 'star' },
  { to: '/taste-profile', label: 'Мои вкусы', icon: 'user' },
];

export function Sidebar({ user, onNavigate, onLogout }: { user: User | null; onNavigate?: () => void; onLogout?: () => void }) {
  const initial = user?.username?.[0]?.toUpperCase() || '?';
  return (
    <aside className="sidebar glass-panel">
      <Link className="brand" to="/" onClick={onNavigate}>
        <span className="brand-mark">✣</span>
        <span><strong>KinoLike</strong><small>Больше, чем просто фильмы</small></span>
      </Link>
      <nav className="sidebar-nav" aria-label="Основная навигация">
        {navItems.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} onClick={onNavigate} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            <span className="nav-icon"><Icon name={item.icon as IconName} /></span><span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="sidebar-quote">«Хорошие фильмы<br />делают жизнь лучше»<i>—</i></div>
      <ThemePicker compact />
      {user?.is_admin && <NavLink to="/admin/users" onClick={onNavigate} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}><span className="nav-icon"><Icon name="user" /></span><span>Пользователи</span></NavLink>}
      {user ? <><Link className="sidebar-user" to="/profile" onClick={onNavigate}><span className="avatar">{initial}</span><span>{user.username}<small>Мой профиль</small></span><span className="user-chevron"><Icon name="right" /></span></Link><button className="sidebar-logout" onClick={() => { onLogout?.(); onNavigate?.(); }}>Выйти</button></> : <Link className="sidebar-user" to="/login" onClick={onNavigate}><span className="avatar">?</span><span>Войти<small>В личный кабинет</small></span><span className="user-chevron"><Icon name="right" /></span></Link>}
    </aside>
  );
}

export function SearchBar({ value = '', onChange, onSubmit }: { value?: string; onChange?: (value: string) => void; onSubmit?: (value: string) => void }) {
  const [internal, setInternal] = useState(value);
  const [suggestions, setSuggestions] = useState<{ id: number; title: string; type: string; year: string }[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();
  const current = onChange ? value : internal;
  useEffect(() => {
    const focusSearch = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); inputRef.current?.focus(); inputRef.current?.select(); }
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, []);
  useEffect(() => {
    let cancelled = false;
    setSuggestions([]); setActive(-1);
    if (current.trim().length < 2) return;
    const timer = window.setTimeout(() => {
      api.tmdb.search(current.trim(), 'multi').then(data => {
        if (!cancelled) setSuggestions(data.results.slice(0, 6).map(item => ({ id: item.id, title: item.title || item.name || 'Без названия', type: item.media_type || 'movie', year: String(item.release_date || item.first_air_date || '').slice(0, 4) })));
      }).catch(() => { if (!cancelled) setSuggestions([]); });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [current]);
  const clear = () => { setInternal(''); setSuggestions([]); setActive(-1); setOpen(false); };
  const select = (item: typeof suggestions[number]) => { clear(); navigate(`/${item.type}/${item.id}`); };
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') setOpen(false);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); setActive(index => Math.max(0, Math.min(suggestions.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))); }
    if (event.key === 'Enter' && open && active >= 0 && suggestions[active]) { event.preventDefault(); select(suggestions[active]); }
  };
  return <form className="search-bar glass-panel" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onSubmit={event => { event.preventDefault(); if (current.trim().length >= 2) { onSubmit?.(current.trim()); clear(); } }}>
    <Icon name="search" className="search-icon" />
    <input ref={inputRef} value={current} onChange={event => { onChange ? onChange(event.target.value) : setInternal(event.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={keys} placeholder="Фильмы, сериалы, актёры…" aria-label="Поиск" role="combobox" aria-autocomplete="list" aria-expanded={open && suggestions.length > 0} aria-controls="search-suggestions" aria-activedescendant={open && active >= 0 ? `suggestion-${active}` : undefined} maxLength={200} />
    <kbd>{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'} K</kbd>
    {open && suggestions.length > 0 && <div className="search-suggestions" id="search-suggestions" role="listbox">{suggestions.map((item, index) => <button type="button" role="option" aria-selected={index === active} id={`suggestion-${index}`} key={`${item.type}-${item.id}`} onMouseDown={event => event.preventDefault()} onClick={() => select(item)}>{item.title}<small>{[item.year, item.type === 'tv' ? 'сериал' : item.type === 'person' ? 'персона' : 'фильм'].filter(Boolean).join(' · ')}</small></button>)}</div>}
  </form>;
}

export function GlassPanel({ children, className = '', as: Tag = 'section' }: { children: ReactNode; className?: string; as?: 'section' | 'div' | 'aside' }) {
  return <Tag className={`glass-panel ${className}`}>{children}</Tag>;
}

export function Rating({ value, user = false }: { value: number; user?: boolean }) {
  return <span className={`rating ${user ? 'user-rating' : ''}`}><Icon name="star" className="rating-star" />{value.toFixed(1)}</span>;
}

export function MovieCard({ movie, compact = false, showActions = true, onRemove, onAdd, badge }: { movie: Movie; compact?: boolean; showActions?: boolean; onRemove?: (movie: Movie) => void; onAdd?: (movie: Movie) => void | Promise<void>; badge?: string }) {
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(Boolean(movie.status));
  const add = async (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); if (!onAdd) return; setAdding(true); try { await onAdd(movie); setAdded(true); } catch (error) { window.alert(error instanceof Error ? error.message : 'Не удалось добавить фильм'); } finally { setAdding(false); } };
  const cardBody = <><div className="poster-wrap">{movie.poster ? <img src={movie.poster} alt={movie.title} loading="lazy" decoding="async" /> : <span className="poster-placeholder"><Icon name="film" /></span>}{badge && <span className="movie-card-rank">{badge}</span>}<div className="poster-shine" /></div><div className="movie-card-body"><h3>{movie.title}</h3><div className="movie-meta"><span>{movie.year || '—'}</span>{movie.rating > 0 && <><span>•</span><Rating value={movie.rating} /></>}</div>{movie.imdbRating !== undefined && <div className="movie-imdb"><b>IMDb {movie.imdbRating.toFixed(1)}</b><span>{movie.imdbVotes ? `${movie.imdbVotes.toLocaleString('ru-RU')} голосов` : ''}</span></div>}{movie.character && <div className="movie-character">{movie.character}</div>}{movie.genres && <div className="movie-genres">{movie.genres.slice(0, 2).join(' · ')}</div>}</div></>;
  return <article className={`movie-card ${compact ? 'compact' : ''} ${showActions ? 'has-actions' : ''}`}>
    {movie.id > 0 ? <Link to={`/${movie.mediaType}/${movie.id}`} className="movie-card-link">{cardBody}</Link> : <div className="movie-card-link" aria-label={`${movie.title}: точная связь с TMDB пока не найдена`}>{cardBody}</div>}
    {onRemove && <button className="card-remove" onClick={() => onRemove(movie)} aria-label={`Удалить ${movie.title}`}><Icon name="close" /></button>}
    {showActions && <div className="card-actions"><Link className="card-watch" to={`/${movie.mediaType}/${movie.id}`} onClick={(event) => event.stopPropagation()}><Icon name="right" /> Подробнее</Link>{onAdd ? <button className="card-add" onClick={add} disabled={adding || added}><Icon name={added ? 'check' : 'plus'} />{adding ? 'Добавляем…' : added ? 'В списке' : 'Добавить'}</button> : <Link className="card-add card-add-link" to="/login" onClick={(event) => event.stopPropagation()}><Icon name="plus" /> Добавить</Link>}</div>}
  </article>;
}

export function MovieRow({ title, movies: items, action, actionTo = '/recommendations', className = '', showActions = true, onAdd, headingExtra, cardBadge }: { title: string; movies: Movie[]; action?: string; actionTo?: string; className?: string; showActions?: boolean; onAdd?: (movie: Movie) => void | Promise<void>; headingExtra?: ReactNode; cardBadge?: (movie: Movie, index: number) => string | undefined }) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [scrollState, setScrollState] = useState({ hasOverflow: false, atStart: true, atEnd: true });
  const updateScrollState = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    const maxScroll = Math.max(0, track.scrollWidth - track.clientWidth);
    setScrollState({
      hasOverflow: maxScroll > 2,
      atStart: track.scrollLeft <= 2,
      atEnd: track.scrollLeft >= maxScroll - 2,
    });
  }, []);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const frame = window.requestAnimationFrame(updateScrollState);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateScrollState);
    observer?.observe(track);
    window.addEventListener('resize', updateScrollState);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', updateScrollState);
    };
  }, [items.length, updateScrollState]);

  const scroll = (direction: -1 | 1) => {
    const track = trackRef.current;
    if (!track) return;
    track.scrollBy({ left: direction * Math.max(240, track.clientWidth * 0.82), behavior: 'smooth' });
  };
  const handleTrackKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      scroll(event.key === 'ArrowLeft' ? -1 : 1);
    }
  };

  return <section className={`movie-row ${className}`} aria-label={title}><div className="section-heading"><h2>{title}</h2>{headingExtra}<div className="movie-row-heading-actions">{action && <Link to={actionTo} className="section-action">{action} <Icon name="right" /></Link>}{scrollState.hasOverflow && <div className="movie-row-controls" role="group" aria-label={`Прокрутка ряда «${title}»`}><button type="button" onClick={() => scroll(-1)} disabled={scrollState.atStart} aria-label={`Прокрутить «${title}» назад`}><Icon name="left" /></button><button type="button" onClick={() => scroll(1)} disabled={scrollState.atEnd} aria-label={`Прокрутить «${title}» вперёд`}><Icon name="right" /></button></div>}</div></div><div ref={trackRef} className="movie-row-track" onScroll={updateScrollState} onKeyDown={handleTrackKeyDown} tabIndex={scrollState.hasOverflow ? 0 : -1} role="region" aria-label={`Фильмы: ${title}`}>{items.map((movie, index) => <MovieCard key={`${movie.mediaType}-${movie.id}`} movie={movie} compact showActions={showActions} onAdd={onAdd} badge={cardBadge?.(movie, index)} />)}</div></section>;
}

export function HeroMovie({ movie, onAdd }: { movie: Movie; onAdd?: (movie: Movie) => void | Promise<void> }) {
  const [pending, setPending] = useState<'add' | null>(null);
  const busy = pending !== null;
  const [added, setAdded] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setAdded(Boolean(movie.status)); setError(''); }, [movie.id, movie.status]);
  const run = async (callback: (movie: Movie) => void | Promise<void>) => {
    setPending('add'); setError('');
    try { await callback(movie); setAdded(true); }
    catch (error) { setError(error instanceof Error ? error.message : 'Не удалось выполнить действие'); }
    finally { setPending(null); }
  };
  return <section className="hero-movie glass-panel" style={{ '--hero-image': `url(${movie.backdrop || movie.poster})` } as CSSProperties}>
    <div className="hero-overlay" />
    <div className="hero-content">
      {movie.genres.length > 0 && <div className="hero-tags">{movie.genres.map(genre => <span key={genre}>{genre}</span>)}</div>}
      <p className="eyebrow">В ЦЕНТРЕ ВНИМАНИЯ</p><h1>{movie.title}</h1>
      <div className="hero-meta">{movie.year > 0 && <span>{movie.year}</span>}{movie.duration && <span>{movie.duration}</span>}{movie.rating > 0 && <Rating value={movie.rating} />}{movie.votes && <span className="votes">{movie.votes}</span>}</div>
      {movie.overview && <p className="hero-description">{movie.overview}</p>}
      <div className="hero-actions">
        <Link className="primary-button" to={`/${movie.mediaType}/${movie.id}`}>Подробнее <Icon name="right" /></Link>
        {onAdd && <button className="secondary-button" onClick={() => void run(onAdd)} disabled={busy || added}><Icon name={added ? 'check' : 'plus'} />{added ? 'В списке' : pending === 'add' ? 'Добавляем…' : 'В список'}</button>}
      </div>
      {error && <p className="error-message" role="alert">{error}</p>}
    </div>
    {movie.tagline && <div className="hero-side-note"><small>«{movie.tagline}»{movie.director && <><br />— {movie.director}</>}</small></div>}
  </section>;
}

export function GenreCard({ genre }: { genre: Genre }) {
  return <Link className="genre-card glass-panel" to={genre.href || `/recommendations?genre=${genre.id}`}>
    {genre.image && <img src={genre.image} alt="" />}<span className="genre-card-shade" />
    <span className="genre-card-content"><strong>{genre.name}</strong><small>{genre.count === undefined ? 'Смотреть подборку' : `В подборке: ${genre.count}`}</small></span>
    <Icon name="right" className="genre-arrow" />
  </Link>;
}

export function RecommendationPrompt({ onSubmit: submitQuery, busy = false }: { onSubmit?: (query: string) => Promise<void>; busy?: boolean }) {
  const [query, setQuery] = useState('');
  const submit = async (event: FormEvent) => { event.preventDefault(); if (query.trim()) { await submitQuery?.(query.trim()); } };
  return <GlassPanel className="recommendation-prompt"><div className="prompt-orb">✦</div><div><p className="eyebrow">ВАШ ПЕРСОНАЛЬНЫЙ КИНОПОДБОРЩИК</p><h2>Попросить AI подобрать фильм</h2><p>{busy ? 'Подбираем что-то особенное по вашему запросу…' : 'Расскажите, какое настроение хочется поймать сегодня'}</p></div><form onSubmit={submit}><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Например: лёгкую романтическую комедию на вечер" maxLength={500} /><button className="primary-button" type="submit" disabled={busy}>{busy ? 'Ищем…' : 'Подобрать'} <span>→</span></button></form></GlassPanel>;
}
