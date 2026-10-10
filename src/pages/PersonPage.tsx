import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { GlassPanel, MovieCard } from '../components/ui';
import { api, personWorkToMovie } from '../services/api';
import type { ListStatus, MediaType, PersonWork } from '../types';

type PersonFilter = 'all' | MediaType;
type PersonSort = 'popular' | 'new' | 'old' | 'imdb';
type PersonResponse = { name: string; profile_path?: string | null; birthday?: string | null; place_of_birth?: string | null; imdb_id?: string | null; biography?: string | null; filmography?: PersonWork[] };

function parsePerson(data: unknown): PersonResponse {
  if (!data || typeof data !== 'object' || !('name' in data) || typeof data.name !== 'string') throw new Error('Сервис вернул некорректные данные персоны');
  const raw = data as Partial<PersonResponse>;
  return { ...raw, name: data.name, filmography: Array.isArray(raw.filmography) ? raw.filmography : [] };
}

const workKey = (work: PersonWork) => work.tmdb_id && work.media_type ? `${work.media_type}:${work.tmdb_id}` : `imdb:${work.imdb_title_id || work.credit_id}`;
const statusLabel = (status?: ListStatus | null) => status === 'watched' ? 'Просмотрено' : status === 'want_to_watch' ? 'Хочу посмотреть' : 'Не добавлено';

function WorkCard({ work, busy, onStatus }: { work: PersonWork; busy: boolean; onStatus: (work: PersonWork, status: ListStatus) => Promise<void> }) {
  return <div className="person-work-card"><MovieCard movie={personWorkToMovie(work)} compact showActions={false} /><div className="person-work-footer"><span className={`person-work-status ${work.status || 'none'}`}>{statusLabel(work.status)}</span>{work.can_add ? <div className="person-work-actions"><button className={work.status === 'want_to_watch' ? 'active' : ''} disabled={busy} onClick={() => void onStatus(work, 'want_to_watch')}>Хочу</button><button className={work.status === 'watched' ? 'active' : ''} disabled={busy} onClick={() => void onStatus(work, 'watched')}>Просмотрено</button></div> : <small>Точная связь с TMDB пока не найдена</small>}</div></div>;
}

export function PersonPage() {
  const { id } = useParams();
  const [person, setPerson] = useState<PersonResponse | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<PersonFilter>('all');
  const [sort, setSort] = useState<PersonSort>('popular');
  const [visibleCount, setVisibleCount] = useState(60);
  const [busyKey, setBusyKey] = useState('');
  const [overrides, setOverrides] = useState<Record<string, { status: ListStatus; list_id: number }>>({});

  useEffect(() => {
    setPerson(null); setError(''); setOverrides({});
    api.tmdb.person(Number(id)).then(data => setPerson(parsePerson(data))).catch(reason => setError(reason instanceof Error ? reason.message : 'Не удалось загрузить персону'));
  }, [id]);
  useEffect(() => setVisibleCount(60), [filter, sort]);

  const filmography = useMemo(() => (person?.filmography || []).map(work => ({ ...work, ...overrides[workKey(work)] })).filter(work => filter === 'all' || work.media_type === filter).sort((left, right) => {
    if (sort === 'new') return (right.year || -1) - (left.year || -1);
    if (sort === 'old') return (left.year || Number.MAX_SAFE_INTEGER) - (right.year || Number.MAX_SAFE_INTEGER);
    if (sort === 'imdb') return (right.imdb_rating || -1) - (left.imdb_rating || -1) || (right.imdb_votes || 0) - (left.imdb_votes || 0);
    return right.work_score - left.work_score || (right.imdb_votes || 0) - (left.imdb_votes || 0);
  }), [person, overrides, filter, sort]);

  const setStatus = async (work: PersonWork, status: ListStatus) => {
    if (!work.tmdb_id || !work.media_type) return;
    const key = workKey(work); setBusyKey(key); setError('');
    try { const result = work.list_id ? await api.lists.update(work.list_id, { status, watched_at: status === 'watched' ? new Date().toISOString() : undefined }) : await api.lists.add(work.tmdb_id, work.media_type, status); setOverrides(current => ({ ...current, [key]: { status: result.item.status, list_id: Number(result.item.id) } })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось обновить список'); }
    finally { setBusyKey(''); }
  };

  if (error && !person) return <div className="empty-page glass-panel"><h2>Персона недоступна</h2><p>{error}</p></div>;
  if (!person) return <div className="empty-page glass-panel"><span className="empty-icon">◌</span><p>Загружаем информацию…</p></div>;
  const visible = filmography.slice(0, visibleCount);
  return <div className="person-page"><div className="person-header glass-panel">{person.profile_path ? <img src={`/api/tmdb/image?path=${encodeURIComponent(person.profile_path)}&size=w342`} alt={person.name} /> : <span className="person-placeholder">👤</span>}<div><p className="eyebrow">АКТЁР / СОЗДАТЕЛЬ</p><h1>{person.name}</h1><p>{person.birthday ? `Родился: ${person.birthday}` : ''}{person.place_of_birth ? ` · ${person.place_of_birth}` : ''}</p>{person.imdb_id && <p className="person-imdb-id">IMDb ID: {person.imdb_id}</p>}<div className="person-bio">{person.biography || 'Биография отсутствует.'}</div></div></div>{error && <p className="error-message detail-error" role="alert">{error}</p>}<section className="person-filmography"><div className="section-heading"><h2>Фильмография</h2><span className="muted">{filmography.length} работ</span></div><GlassPanel className="person-filmography-toolbar"><div className="recs-tabs" aria-label="Фильтр фильмографии">{([['all', 'Все'], ['movie', 'Фильмы'], ['tv', 'Сериалы']] as [PersonFilter, string][]).map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div><label>Сортировка<select value={sort} onChange={event => setSort(event.target.value as PersonSort)}><option value="popular">Популярные</option><option value="new">Новые</option><option value="old">Старые</option><option value="imdb">IMDb</option></select></label></GlassPanel>{visible.length ? <div className="person-work-grid">{visible.map(work => <WorkCard key={workKey(work)} work={work} busy={busyKey === workKey(work)} onStatus={setStatus} />)}</div> : <div className="empty-page glass-panel">Для выбранного фильтра работ нет.</div>}{visibleCount < filmography.length && <div className="load-more"><button className="secondary-button" onClick={() => setVisibleCount(count => count + 60)}>Показать ещё</button></div>}</section></div>;
}
