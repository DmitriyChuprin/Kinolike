import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../App';
import { MovieCard } from '../components/ui';
import { api, tmdbListToMovies } from '../services/api';
import type { Movie } from '../types';

const collections: Record<string, string> = { popular: 'Популярное сейчас', cinema: 'Сейчас в кино', upcoming: 'Скоро выйдут', top: 'Фильмы с высоким рейтингом', tv: 'Сериалы в тренде' };

export function CatalogPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const collection = params.get('collection') || 'popular';
  const genre = params.get('genre') || '';
  const type = genre ? params.get('type') || 'movie' : collection === 'tv' ? 'tv' : 'movie';
  const [genres, setGenres] = useState<{ movie: { id: number; name: string }[]; tv: { id: number; name: string }[] }>({ movie: [], tv: [] });
  const [movies, setMovies] = useState<Movie[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const key = `${collection}:${genre}:${type}`;
  const [loadedKey, setLoadedKey] = useState(key);

  useEffect(() => { api.tmdb.genres().then(setGenres).catch(() => {}); }, []);
  useEffect(() => { setPage(1); setMovies([]); setLoadedKey(key); }, [key]);
  useEffect(() => {
    if (loadedKey !== key) return;
    let cancelled = false;
    setLoading(true); setError('');
    api.tmdb.catalog({ collection, genre, type, page }).then(data => {
      if (cancelled) return;
      setMovies(current => page === 1 ? tmdbListToMovies(data.results) : [...current, ...tmdbListToMovies(data.results)].filter((movie, index, all) => all.findIndex(item => item.id === movie.id && item.mediaType === movie.mediaType) === index));
      setTotal(data.total_results); setPages(data.total_pages);
    }).catch(error => { if (!cancelled) setError(error instanceof Error ? error.message : 'Не удалось загрузить подборку'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [collection, genre, type, page, key, loadedKey, retry]);

  const genreOptions = type === 'tv' ? genres.tv : genres.movie;
  const title = genre ? genreOptions.find(item => String(item.id) === genre)?.name || 'Подборка по жанру' : collections[collection] || 'Каталог';
  const add = async (movie: Movie) => {
    if (!user) { navigate(`/login?next=${encodeURIComponent('/catalog?' + params.toString())}`); return; }
    await api.lists.add(movie.id, movie.mediaType);
  };
  return <div className="catalog-page">
    <div className="page-title-row"><div><p className="eyebrow">НАЙДИТЕ СВОЁ КИНО</p><h1>{title}</h1><p className="page-subtitle">{loading && !movies.length ? 'Собираем подборку…' : `В каталоге: ${total.toLocaleString('ru-RU')}`}</p></div></div>
    <div className="catalog-toolbar glass-panel">
      <label>Подборка<select aria-label="Подборка" value={collection} onChange={event => setParams({ collection: event.target.value })}>{Object.entries(collections).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Жанр<select aria-label="Жанр" value={genre} onChange={event => setParams({ collection, type, ...(event.target.value ? { genre: event.target.value } : {}) })}><option value="">Все жанры</option>{genreOptions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {genre && <button className="secondary-button" onClick={() => setParams({ collection })}>Сбросить жанр</button>}
    </div>
    {error && <div className="empty-inline glass-panel" role="alert"><p>{error}</p><button className="secondary-button" onClick={() => setRetry(value => value + 1)}>Повторить</button></div>}
    <div className="list-grid" aria-busy={loading}>{movies.map(movie => <MovieCard key={`${movie.mediaType}-${movie.id}`} movie={movie} onAdd={add} />)}</div>
    {loading && <p className="loading-status" role="status">Загружаем фильмы…</p>}
    {!loading && !error && !movies.length && <div className="empty-page glass-panel"><h2>Пока нет фильмов</h2><p>Попробуйте выбрать другой жанр.</p></div>}
    {page < pages && !error && <div className="load-more"><button className="secondary-button" disabled={loading} onClick={() => setPage(value => value + 1)}>{loading ? 'Загружаем…' : 'Показать ещё'}</button></div>}
  </div>;
}
