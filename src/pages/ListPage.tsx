import { Icon } from '../components/Icon';
import { useEffect, useMemo, useState } from 'react';
import { MovieCard, GlassPanel } from '../components/ui';
import { api, listItemToMovie } from '../services/api';
import type { ListStatus, Movie } from '../types';

export function ListPage({ watched = false, status }: { watched?: boolean; status?: ListStatus }) {
  const [items, setItems] = useState<Movie[]>([]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('date');
  const [mediaType, setMediaType] = useState('');
  const [year, setYear] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (watched ? api.watched.get({ compact: 1 }) : api.lists.get(status || 'want_to_watch', { compact: 1 }))
      .then(({ items: rows }) => { if (!cancelled) setItems(rows.map(listItemToMovie)); })
      .catch((requestError) => { if (!cancelled) setError(requestError instanceof Error ? requestError.message : 'Не удалось загрузить список'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [watched, status]);

  const filtered = useMemo(() => items.filter((movie) => movie.title.toLowerCase().includes(query.toLowerCase()) && (!mediaType || movie.mediaType === mediaType) && (!year || String(movie.year) === year)).sort((a, b) => sort === 'rating' ? (b.userRating || b.rating) - (a.userRating || a.rating) : b.year - a.year), [items, query, sort, mediaType, year]);
  const remove = async (movie: Movie) => {
    if (!movie.listId) return;
    await api.lists.remove(movie.listId);
    setItems((current) => current.filter((item) => item.listId !== movie.listId));
  };
  const markWatched = async (movie: Movie) => {
    if (!movie.listId) return;
    const result = await api.lists.update(movie.listId, { status: 'watched', watched_at: new Date().toISOString() });
    setItems((current) => current.map((item) => item.listId === movie.listId ? listItemToMovie(result.item) : item).filter((item) => !status || item.status === status));
  };

  if (loading) return <div className="empty-page glass-panel"><span className="empty-icon">◌</span><p>Загружаем список…</p></div>;
  if (error) return <div className="empty-page glass-panel"><h2>Не удалось загрузить список</h2><p>{error}</p></div>;
  const title = watched ? 'Просмотрено' : 'Хочу посмотреть';
  return <div className="list-page"><div className="page-title-row"><div><p className="eyebrow">ВАШ СПИСОК</p><h1>{title}</h1><p className="page-subtitle">{watched ? 'Фильмы, которые уже оставили свой след' : 'Список фильмов для будущих вечеров'}</p></div><div className="count-badge"><strong>{items.length}</strong><span>фильмов</span></div></div>
    <GlassPanel className="list-toolbar"><div className="inline-search"><span><Icon name="search" /></span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти в списке" /></div><div className="toolbar-controls"><select value={mediaType} onChange={(event) => setMediaType(event.target.value)}><option value="">Все типы</option><option value="movie">Фильмы</option><option value="tv">Сериалы</option></select><input className="year-filter" value={year} onChange={(event) => setYear(event.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="Год" inputMode="numeric" /><label>Сортировка <select value={sort} onChange={(event) => setSort(event.target.value)}><option value="date">По году</option><option value="rating">По рейтингу</option></select></label></div></GlassPanel>
    <div className="list-grid">{filtered.map((movie) => <div className="list-card-wrap" key={`${movie.mediaType}-${movie.id}`}><MovieCard movie={movie} showActions={false} onRemove={remove} />{!watched && <div className="list-item-actions"><button onClick={() => void markWatched(movie)}><Icon name="check" /> Просмотрено</button></div>}{watched && <><div className="watched-details"><span>Просмотрено {movie.watchedAt || '—'}</span><span>Ваша оценка <b><span className="rating-star"><Icon name="star" /></span> {movie.userRating || '—'}/10</b></span></div>{movie.notes?.trim() && <details className="watched-review"><summary>Заметка / отзыв</summary><p>{movie.notes}</p></details>}</>}</div>)}</div>{!filtered.length && <div className="empty-page glass-panel"><span className="empty-icon"><Icon name="search" /></span><h2>Ничего не найдено</h2><p>Попробуйте другой запрос</p></div>}
  </div>;
}
