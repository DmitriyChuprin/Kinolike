/* eslint-disable @typescript-eslint/no-unused-vars */
import { Icon } from '../components/Icon';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { GlassPanel, MovieCard, Rating } from '../components/ui';
import { TrailerPlayer } from '../components/TrailerPlayer';
import { Modal } from '../components/Modal';
import { api, listItemToMovie, personWorkToMovie, toMovie, type JellyfinEpisode, type JellyfinSeason, type PhantomPlayback, type Trailer } from '../services/api';
import { useAuth } from '../App';
import type { ListStatus, MediaType, Movie, PersonWork } from '../types';

type Raw = Record<string, any>;
type PlaybackItem = { id: string; title: string; seriesId?: string; seasonId?: string; season?: number; episode?: number };
type PhantomWatchRequest = { playback: PhantomPlayback; resumeKey: string; season?: number; episode?: number; episodeTitle?: string; translationId?: string; onPreviousEpisode?: () => Promise<void>; previousEpisodeLabel?: string; onNextEpisode?: () => Promise<void>; nextEpisodeLabel?: string };
const JellyfinPlayer = lazy(() => import('../components/JellyfinPlayer').then(module => ({ default: module.JellyfinPlayer })));
const PhantomPlayer = lazy(() => import('../components/PhantomPlayer').then(module => ({ default: module.PhantomPlayer })));

export function DetailPage() {
  const { id } = useParams(); const location = useLocation(); const navigate = useNavigate();
  const type: MediaType = location.pathname.startsWith('/tv/') ? 'tv' : 'movie'; const numericId = Number(id); const { user } = useAuth();
  const [details, setDetails] = useState<Raw | null>(null); const [listItem, setListItem] = useState<Movie | null>(null); const [streamingLink, setStreamingLink] = useState<Raw | null>(null); const [torrentResults, setTorrentResults] = useState<Raw[]>([]); const [busy, setBusy] = useState(false); const [sourceBusy, setSourceBusy] = useState(false); const [error, setError] = useState(''); const [statusDialog, setStatusDialog] = useState<ListStatus | null>(null); const [playbackItem, setPlaybackItem] = useState<PlaybackItem | null>(null); const [phantomPlayback, setPhantomPlayback] = useState<PhantomWatchRequest | null>(null); const [selectedSeason, setSelectedSeason] = useState(1);
  const movie = useMemo(() => details ? toMovie(details, type) : null, [details, type]);

  const load = async (refresh = false) => {
    setError('');
    setDetails(null);
    try {
      if (refresh) await api.tmdb.refreshMetadata(type, numericId);
      const loaded = await api.tmdb.detail(type, numericId);
      setDetails(loaded);
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Не удалось загрузить информацию'); }
  };
  useEffect(() => { void load(); }, [numericId, type]);
  useEffect(() => {
    setListItem(null);
    setStreamingLink(null);
    if (!user) return;
    let active = true;
    void api.lists.getItem(type, numericId)
      .then(({ item }) => { if (active) setListItem(item ? listItemToMovie(item) : null); })
      .catch(() => {});
    void api.streaming.getLink(type, numericId)
      .then(({ link }) => { if (active) setStreamingLink(link); })
      .catch(() => {});
    return () => { active = false; };
  }, [numericId, type, user]);

  const changeStatus = async (status: ListStatus, rating?: number, notes?: string) => {
    if (!movie) return; setBusy(true);
    try {
      if (listItem?.listId && listItem.status === status && status !== 'watched') { await api.lists.remove(listItem.listId); setListItem(null); }
      else if (listItem?.listId) { const result = await api.lists.update(listItem.listId, { status, rating, notes, watched_at: status === 'watched' ? new Date().toISOString() : undefined }); setListItem(listItemToMovie(result.item)); }
      else { const result = await api.lists.add(movie.id, movie.mediaType, status); let item = result.item; if (status === 'watched' && (rating || notes)) item = (await api.lists.update(item.id, { rating, notes, watched_at: new Date().toISOString() })).item; setListItem(listItemToMovie(item)); }
      setStatusDialog(null);
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Не удалось обновить список'); }
    finally { setBusy(false); }
  };
  const searchTorrents = async (season?: number) => { if (!movie) return; setSourceBusy(true); setError(''); try { const result = await api.streaming.search(`${movie.title}${movie.year ? ` ${movie.year}` : ''}`, movie.mediaType); let results = result.results || []; if (movie.mediaType === 'tv' && season && results.length > 0) { results = results.filter((t: any) => { const title = (t.title || '').toLowerCase(); const seasonPatterns = [new RegExp(`(?:сезон|season|сез)\\s*[.:]?\\s*${season}(?:\\s|[^\\d]|$)`, 'i'), new RegExp(`\\b${season}\\s*(?:сезон|season|серий|эпизод)`, 'i'), new RegExp(`(?:s${String(season).padStart(2, '0')}|s${season})\\b`, 'i'), new RegExp(`(?:${season}\\s*-\\s*\\d+\\s*сезон|сезон\\s*${season}\\s*-\\s*\\d+|\\d+\\s*-\\s*${season}\\s*сезон)`, 'i'), new RegExp(`1-${season}\\s*сезон`, 'i')]; return seasonPatterns.some(p => p.test(title)); }); } setTorrentResults(results); if (!results.length) setError(season ? `Торренты для сезона ${season} не найдены.` : 'Торренты не найдены. Проверьте настройки Jackett.'); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Ошибка поиска торрентов'); } finally { setSourceBusy(false); } };
  const playTorrent = async (torrent: Raw) => { if (!movie) return; const magnet = torrent.magnetUri || torrent.link; if (!magnet) { setError('У результата нет magnet-ссылки'); return; } setSourceBusy(true); setError(''); try { const result = await api.streaming.play(magnet, movie.title, movie.posterPath || movie.poster, movie.id, movie.mediaType); setStreamingLink({ ...result, jellyfin_url: result.jellyfinUrl, stream_url: result.streamUrl }); if (!result.jellyfinUrl) setError('Торрент добавлен в TorrServer, .strm создан. Jellyfin ещё не вернул ссылку — нажмите «Найти в Jellyfin» позже.'); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Не удалось добавить торрент в TorrServer'); } finally { setSourceBusy(false); } };
  const refreshJellyfin = async () => {
    if (!movie) return;
    setSourceBusy(true);
    try {
      const result = await api.streaming.refreshJellyfin(movie.mediaType, movie.id);
      if (result.jellyfinUrl) {
        setStreamingLink({ ...streamingLink, jellyfin_url: result.jellyfinUrl, stream_url: streamingLink?.stream_url || streamingLink?.streamUrl });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось обновить Jellyfin');
    } finally {
      setSourceBusy(false);
    }
  };
  const onSeasonChange = (season: number) => {
    setSelectedSeason(season);
    setTorrentResults([]);
    setError('');
  };;

  if (error && !details) return <div className="empty-page glass-panel"><h2>Не удалось загрузить фильм</h2><p>{error}</p><button className="secondary-button" onClick={() => void load()}>Повторить</button></div>;
  if (!movie || !details) return <div className="empty-page glass-panel"><span className="empty-icon">◌</span><p>Загружаем информацию…</p></div>;
  const cast = (details.credits?.cast || []).slice(0, 10);
  const statusButtons: { status: ListStatus; label: string }[] = [{ status: 'want_to_watch', label: 'Хочу посмотреть' }, { status: 'watched', label: 'Просмотрено' }, { status: 'not_interested', label: 'Не интересно' }];

  return <div className="detail-page"><section className="detail-hero glass-panel" style={{ '--hero-image': `url(${movie.backdrop || movie.poster})` } as CSSProperties}><div className="detail-hero-shade" /><div className="detail-poster">{movie.poster ? <img src={movie.poster} alt={movie.title} /> : <span className="poster-placeholder"><Icon name="film" /></span>}</div><div className="detail-hero-copy"><p className="eyebrow">{movie.mediaType === 'tv' ? 'СЕРИАЛ' : 'ФИЛЬМ'} · {movie.year || '—'}</p><h1>{movie.title}</h1>{movie.originalTitle && movie.originalTitle !== movie.title && <p className="original-title">{movie.originalTitle}</p>}<div className="detail-score"><Rating value={movie.rating} /><span>{movie.votes || 'Нет данных по оценкам'}</span><span className="source-badge tmdb-badge">TMDB</span></div>{movie.imdbRating !== undefined && <div className="detail-score imdb-score"><Rating value={movie.imdbRating} /><span>{movie.imdbVotes ? `${movie.imdbVotes.toLocaleString('ru-RU')} голосов` : 'Нет данных о голосах'}</span><span className="source-badge imdb-badge">IMDb</span></div>}<div className="hero-tags">{movie.genres.slice(0, 5).map((genre) => <span key={genre}>{genre}</span>)}</div><p className="detail-meta">◷ {movie.duration || (movie.mediaType === 'tv' ? `${details.number_of_seasons || 0} сез. · ${details.number_of_episodes || 0} серий` : '—')}</p><p className="hero-description">{movie.overview || 'Описание пока недоступно.'}</p><button className="round-button" onClick={() => void load(true)} aria-label="Обновить метаданные">↻</button></div></section><GlassPanel className="status-panel"><div><p className="eyebrow">ВАША КОЛЛЕКЦИЯ</p><h2>Статус фильма</h2></div><div className="status-quick-actions">{statusButtons.map(({ status, label }) => <button key={status} className={`secondary-button ${listItem?.status === status ? 'active' : ''}`} disabled={busy} onClick={() => { if (listItem?.status === status && status !== 'watched') { void changeStatus(status); } else if (status === 'watched') { setStatusDialog('watched'); } else { void changeStatus(status); } }}>{label}</button>)}</div></GlassPanel>
        <SourcesPanel movie={movie} details={details} streamingLink={streamingLink} torrents={torrentResults} sourceBusy={sourceBusy} authenticated={Boolean(user)} jellyfinEnabled={Boolean(user?.jellyfin_enabled)} onSearchTorrents={() => void searchTorrents(selectedSeason)} onPlayTorrent={(t) => void playTorrent(t)} onRefreshJellyfin={refreshJellyfin} onWatch={setPlaybackItem} onPhantomWatch={setPhantomPlayback} activePlayback={playbackItem} selectedSeason={selectedSeason} onSeasonChange={onSeasonChange} />
        {playbackItem && <Suspense fallback={<PlayerLoading />}><JellyfinPlayer mediaType={movie.mediaType} tmdbId={movie.id} imdbId={movie.imdbId || details.external_ids?.imdb_id || details.imdb_id} season={playbackItem.season} episode={playbackItem.episode} itemId={playbackItem.id} title={playbackItem.title} seriesTitle={movie.title} seriesId={playbackItem.seriesId} poster={movie.backdrop || movie.poster} onEpisodeChange={(episode) => setPlaybackItem({ id: episode.id, title: episodeLabel(episode), seriesId: playbackItem.seriesId, seasonId: episode.seasonId, season: episode.season, episode: episode.episode })} onClose={() => setPlaybackItem(null)} /></Suspense>}
        {phantomPlayback && <Suspense fallback={<PlayerLoading />}><PhantomPlayer url={phantomPlayback.playback.url} source={phantomPlayback.playback.source} resumeKey={phantomPlayback.resumeKey} tmdbId={movie.id} imdbId={movie.imdbId || details.external_ids?.imdb_id || details.imdb_id} mediaType={movie.mediaType} season={phantomPlayback.season} episode={phantomPlayback.episode} translationId={phantomPlayback.translationId} title={movie.title} episodeTitle={phantomPlayback.episodeTitle} poster={movie.backdrop || movie.poster} onPreviousEpisode={phantomPlayback.onPreviousEpisode} previousEpisodeLabel={phantomPlayback.previousEpisodeLabel} onNextEpisode={phantomPlayback.onNextEpisode} nextEpisodeLabel={phantomPlayback.nextEpisodeLabel} onClose={() => setPhantomPlayback(null)} /></Suspense>}
        {statusDialog && <Modal className="status-dialog" title={statusDialog === 'want_to_watch' ? 'Хочу посмотреть' : statusDialog === 'watched' ? 'Отметить просмотренным' : 'Не интересно'} onClose={() => setStatusDialog(null)}>{statusDialog === 'watched' ? <WatchedDialog busy={busy} onClose={() => setStatusDialog(null)} onSubmit={(rating, notes) => void changeStatus('watched', rating || undefined, notes)} /> : <div className="dialog-actions"><button className="primary-button" disabled={busy} onClick={() => void changeStatus(statusDialog)}>Подтвердить</button><button className="secondary-button" onClick={() => setStatusDialog(null)}>Отмена</button></div>}</Modal>}
        {listItem?.status === 'watched' && <RatingPanel item={listItem} onRated={(m) => setListItem(m)} />}
        {cast.length > 0 && <section className="detail-section glass-panel"><h2>Актёрский состав</h2><div className="cast-grid">{cast.map((person: Raw) => <button type="button" key={person.id} className="cast-card" onClick={() => void navigate(`/person/${person.id}`)} aria-label={`${person.name}${person.character ? ` — ${person.character}` : ''}`}>{person.profile_path ? <img loading="lazy" decoding="async" src={`/api/tmdb/image?path=${encodeURIComponent(person.profile_path)}&size=w185`} alt="" /> : <div className="cast-placeholder" aria-hidden="true">👤</div>}<p className="cast-name">{person.name}</p><p className="cast-character">{person.character || ''}</p></button>)}</div></section>}
      </div>;
}

function PlayerLoading() { return <div className="modal-backdrop"><div className="glass-panel player-loading" role="status">Загружаем плеер…</div></div>; }

function WatchedDialog({ busy, onClose, onSubmit }: { busy: boolean; onClose: () => void; onSubmit: (rating: number, notes: string) => void }) { const [rating, setRating] = useState(0); const [notes, setNotes] = useState(''); return <><p className="muted">Оценка необязательна.</p><div className="rating-picker" role="group" aria-label="Оценка от 1 до 10">{Array.from({ length: 10 }, (_, index) => <button type="button" key={index + 1} className={index + 1 <= rating ? 'selected' : ''} aria-pressed={index + 1 === rating} aria-label={`Оценка ${index + 1}`} onClick={() => setRating(current => current === index + 1 ? 0 : index + 1)}>{index + 1}</button>)}</div><label className="dialog-field">Заметка<textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Заметка о фильме…" /></label><div className="dialog-actions"><button className="secondary-button" onClick={onClose}>Отмена</button><button className="primary-button" disabled={busy} onClick={() => onSubmit(rating, notes)}>{busy ? 'Сохраняем…' : 'Подтвердить'}</button></div></>; }

function RatingPanel({ item, onRated }: { item: Movie | null; onRated: (movie: Movie) => void }) { const [rating, setRating] = useState(item?.userRating || 0); const [notes, setNotes] = useState(item?.notes || ''); const [message, setMessage] = useState(''); useEffect(() => { setRating(item?.userRating || 0); setNotes(item?.notes || ''); }, [item?.userRating, item?.notes]); const submit = async (event: FormEvent) => { event.preventDefault(); if (!item?.listId || !rating) return; try { const result = await api.watched.rate(item.listId, { rating, notes, watched_at: new Date().toISOString() }); onRated(listItemToMovie(result.item)); setMessage('Оценка и отзыв сохранены'); } catch (error) { setMessage(error instanceof Error ? error.message : 'Не удалось сохранить оценку и отзыв'); } }; return <GlassPanel className="review-panel"><h2>Ваша оценка и отзыв</h2><div className="rating-picker">{Array.from({ length: 10 }, (_, index) => <button key={index + 1} className={index + 1 <= rating ? 'selected' : ''} onClick={() => setRating(index + 1)} type="button">{index + 1}</button>)}</div><form onSubmit={submit}><textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Напишите личный отзыв…" /><button className="secondary-button" disabled={!item?.listId || !rating}>Сохранить</button></form>{!item?.listId && <p className="muted">Сначала добавьте фильм в просмотренные.</p>}{message && <p className="form-message">{message}</p>}</GlassPanel>; }

function SourcesPanel({ movie, details, streamingLink, torrents, sourceBusy, authenticated, jellyfinEnabled, onSearchTorrents, onPlayTorrent, onRefreshJellyfin, onWatch, onPhantomWatch, activePlayback, selectedSeason, onSeasonChange }: { movie: Movie; details: Raw; streamingLink: Raw | null; torrents: Raw[]; sourceBusy: boolean; authenticated: boolean; jellyfinEnabled: boolean; onSearchTorrents: () => void; onPlayTorrent: (torrent: Raw) => void; onRefreshJellyfin: () => Promise<void>; onWatch: (item: PlaybackItem) => void; onPhantomWatch: (playback: PhantomWatchRequest) => void; activePlayback: PlaybackItem | null; selectedSeason: number; onSeasonChange: (season: number) => void }) {
  return <GlassPanel className="sources-panel">
    <div className="section-heading"><h2>Источники просмотра</h2><span className="muted">{sourceBusy ? 'Добавляем в TorrServer…' : 'доступные сервисы'}</span></div>
    <TrailerButton movie={movie} />
    {!authenticated ? <div className="guest-playback-note"><p>Войдите, чтобы открыть источники просмотра и синхронизировать прогресс.</p><Link className="primary-button" to={`/login?next=/${movie.mediaType}/${movie.id}`}>Войти</Link></div> : <div className="authenticated-sources">
    {jellyfinEnabled && <JellyfinAvailability movie={movie} onWatch={onWatch} activePlayback={activePlayback} />}
    <PhantomAvailability movie={movie} details={details} onWatch={onPhantomWatch} />
    {movie.mediaType === 'tv' && <div className="torrent-season"><label>Сезон для поиска:</label><select value={selectedSeason} onChange={(event) => onSeasonChange(Number(event.target.value))}>{Array.from({ length: movie.seasons || 10 }, (_, index) => index + 1).map((number) => <option key={number} value={number}>Сезон {number}</option>)}</select></div>}
    <div className="source-actions"><button className="secondary-button" onClick={onSearchTorrents} disabled={sourceBusy}><Icon name="search" /> Найти торрент</button>{jellyfinEnabled && streamingLink?.jellyfin_url && <a className="secondary-button" href={streamingLink.jellyfin_url} target="_blank" rel="noreferrer">Открыть Jellyfin</a>}{jellyfinEnabled && streamingLink && !streamingLink.jellyfin_url && <button className="secondary-button" onClick={() => void onRefreshJellyfin()} disabled={sourceBusy}><Icon name="refresh" /> Обновить библиотеку</button>}</div>
    {torrents.length > 0 && <div className="source-results"><h3>Результаты Jackett</h3>{torrents.slice(0, 12).map((torrent, index) => <div className="source-result" key={`${torrent.title}-${index}`}><div><strong>{torrent.title}</strong><small>{torrent.quality || 'качество не указано'} · {torrent.voiceover || 'озвучка не указана'} · сиды {torrent.seeders || 0}</small></div><button className="secondary-button" onClick={() => onPlayTorrent(torrent)} disabled={sourceBusy}><Icon name="plus" /> Добавить в TorrServer</button></div>)}</div>}
    </div>}
  </GlassPanel>;
}

function TrailerButton({ movie }: { movie: Movie }) {
  const [open, setOpen] = useState(false); const [loading, setLoading] = useState(false); const [trailer, setTrailer] = useState<Trailer | null>(null); const [message, setMessage] = useState('');
  const show = async () => { setOpen(true); setLoading(true); setMessage(''); try { const result = await api.trailers.get(movie.mediaType, movie.id); setTrailer(result.trailer); if (!result.found) setMessage('Трейлер не найден'); } catch (error) { setMessage(error instanceof Error ? error.message : 'Не удалось найти трейлер'); } finally { setLoading(false); } };
  return <div className="trailer-action"><button className="secondary-button" onClick={() => void show()}>▶ Трейлер</button>{open && <div className="trailer-modal"><button className="modal-close" onClick={() => setOpen(false)}>×</button>{loading ? <p>Ищем лучший трейлер…</p> : trailer ? <TrailerPlayer mediaType={movie.mediaType} tmdbId={movie.id} trailer={trailer} onTrailerChange={setTrailer} /> : <p>{message || 'Трейлер не найден'}</p>}</div>}</div>;
}

function PhantomAvailability({ movie, details, onWatch }: { movie: Movie; details: Raw; onWatch: (playback: PhantomWatchRequest) => void }) {
  const [state, setState] = useState<'idle' | 'checking' | 'missing' | 'found' | 'error'>('idle');
  const [voices, setVoices] = useState<{ id: string; name: string; quality?: string }[]>([]);
  const [seasons, setSeasons] = useState<number[]>([]); const [season, setSeason] = useState(0);
  const [translationId, setTranslationId] = useState(''); const [episodes, setEpisodes] = useState<{ episode: number; name: string }[]>([]); const [episode, setEpisode] = useState(0);
  const [onlineSource, setOnlineSource] = useState<'phantom' | 'videohub'>('phantom');
  const [loadingSelection, setLoadingSelection] = useState(false); const [starting, setStarting] = useState(false);
  const episodeListsRef = useRef(new Map<number, { episode: number; name: string }[]>()); const switchingRef = useRef(false);
  const metadata = { tmdbId: movie.id, mediaType: movie.mediaType, title: movie.title, originalTitle: movie.originalTitle, imdbId: movie.imdbId || details.external_ids?.imdb_id || details.imdb_id, kinopoiskId: details.kinopoisk_id, year: movie.year, originalLanguage: details.original_language };
  useEffect(() => { episodeListsRef.current.clear(); switchingRef.current = false; setState('idle'); setVoices([]); setSeasons([]); setSeason(0); setTranslationId(''); setEpisodes([]); setEpisode(0); }, [movie.id, movie.mediaType]);
  const loadEpisodes = async (nextSeason: number, nextTranslation: string) => {
    if (!nextSeason || !nextTranslation) return;
    setLoadingSelection(true); setEpisodes([]); setEpisode(0);
    try { const result = await api.streaming.phantomEpisodes({ ...metadata, season: nextSeason, translationId: nextTranslation, source: onlineSource }); setOnlineSource(result.source); episodeListsRef.current.set(nextSeason, result.episodes); setEpisodes(result.episodes); setEpisode(result.episodes[0]?.episode || 0); }
    catch { setState('error'); } finally { setLoadingSelection(false); }
  };
  const loadVoices = async (nextSeason: number) => {
    setSeason(nextSeason); setVoices([]); setTranslationId(''); setEpisodes([]); setEpisode(0); setLoadingSelection(true);
    try { const result = await api.streaming.phantomVoices({ ...metadata, title: movie.title, tmdbId: movie.id, season: nextSeason, source: onlineSource }); setOnlineSource(result.source); setVoices(result.voices); const first = result.voices[0]?.id || ''; setTranslationId(first); if (first) await loadEpisodes(nextSeason, first); }
    catch { setState('error'); } finally { setLoadingSelection(false); }
  };
  const check = async () => {
    setState('checking');
    try {
      const result = await api.streaming.phantomCheck(metadata);
      if (!result.available) { setState(result.unavailable ? 'error' : 'missing'); return; }
      setOnlineSource(result.source);
      if (movie.mediaType === 'movie') { setVoices(result.voices || []); setTranslationId(result.voices?.[0]?.id || ''); }
      else { const nextSeasons = result.seasons || []; setSeasons(nextSeasons); if (nextSeasons[0]) await loadVoices(nextSeasons[0]); }
      setState('found');
    } catch { setState('error'); }
  };
  const episodesForSeason = async (targetSeason: number) => {
    const cached = episodeListsRef.current.get(targetSeason); if (cached) return cached;
    const result = await api.streaming.phantomEpisodes({ ...metadata, season: targetSeason, translationId, source: onlineSource });
    setOnlineSource(result.source); episodeListsRef.current.set(targetSeason, result.episodes); return result.episodes;
  };
  const adjacentEpisode = async (targetSeason: number, targetEpisode: number, direction: -1 | 1) => {
    const current = await episodesForSeason(targetSeason); const index = current.findIndex((item) => item.episode === targetEpisode);
    if (index >= 0 && current[index + direction]) return { season: targetSeason, ...current[index + direction] };
    const orderedSeasons = [...seasons].sort((a, b) => a - b); const seasonIndex = orderedSeasons.indexOf(targetSeason);
    for (let i = seasonIndex + direction; i >= 0 && i < orderedSeasons.length; i += direction) { const candidates = await episodesForSeason(orderedSeasons[i]); if (candidates.length) return { season: orderedSeasons[i], ...(direction > 0 ? candidates[0] : candidates[candidates.length - 1]) }; }
    return undefined;
  };
  const start = async (targetSeason = season, episodeToPlay = episode) => {
    if (switchingRef.current) return; switchingRef.current = true; setStarting(true);
    try {
      const currentEpisodes = movie.mediaType === 'tv' ? await episodesForSeason(targetSeason) : []; const current = currentEpisodes.find((item) => item.episode === episodeToPlay);
      const playback = await api.streaming.phantomPlayback({ ...metadata, tmdb_id: movie.id, media_type: movie.mediaType, source: onlineSource, translation_id: translationId || undefined, season: movie.mediaType === 'tv' ? targetSeason : undefined, episode: movie.mediaType === 'tv' ? episodeToPlay : undefined });
      const previous = movie.mediaType === 'tv' ? await adjacentEpisode(targetSeason, episodeToPlay, -1) : undefined; const next = movie.mediaType === 'tv' ? await adjacentEpisode(targetSeason, episodeToPlay, 1) : undefined;
      if (movie.mediaType === 'tv') { setSeason(targetSeason); setEpisodes(currentEpisodes); setEpisode(episodeToPlay); }
      const label = (item?: { season: number; episode: number; name: string }) => item ? `S${String(item.season).padStart(2, '0')}E${String(item.episode).padStart(2, '0')} — ${item.name}` : undefined;
      onWatch({ playback, resumeKey: `${movie.id}:${movie.mediaType}:${movie.mediaType === 'tv' ? targetSeason : 0}:${movie.mediaType === 'tv' ? episodeToPlay : 0}`, translationId: translationId || undefined, ...(movie.mediaType === 'tv' ? { season: targetSeason, episode: episodeToPlay, episodeTitle: label({ season: targetSeason, episode: episodeToPlay, name: current?.name || `Серия ${episodeToPlay}` }) } : {}), ...(previous ? { onPreviousEpisode: () => start(previous.season, previous.episode), previousEpisodeLabel: label(previous) } : {}), ...(next ? { onNextEpisode: () => start(next.season, next.episode), nextEpisodeLabel: label(next) } : {}) });
    } catch { setState('error'); } finally { switchingRef.current = false; setStarting(false); }
  };
  return <section className="jellyfin-availability" aria-live="polite">
    <div className="jellyfin-availability-heading"><span className="eyebrow">ОНЛАЙН</span>{state === 'found' && <strong>✓ {movie.mediaType === 'tv' ? 'Сериал найден' : 'Фильм найден'}</strong>}</div>
    {state === 'idle' && <button className="secondary-button" onClick={() => void check()}>Проверить онлайн</button>}
    {state === 'checking' && <span className="jellyfin-message">Проверяем онлайн-источник…</span>}
    {state === 'missing' && <span className="jellyfin-message">Онлайн-версия не найдена</span>}
    {state === 'error' && <div className="jellyfin-error"><span>Phantom и VideoHUB временно недоступны</span><button className="secondary-button" onClick={() => void check()}>Повторить</button></div>}
    {state === 'found' && movie.mediaType === 'tv' && <div className="jellyfin-selectors">
      <label><span>Сезон</span><select value={season} onChange={(event) => void loadVoices(Number(event.target.value))}>{seasons.map((number) => <option key={number} value={number}>Сезон {number}</option>)}</select></label>
      <label><span>Озвучка</span><select value={translationId} onChange={(event) => { setTranslationId(event.target.value); void loadEpisodes(season, event.target.value); }} disabled={loadingSelection || !voices.length}>{voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.name}{voice.quality ? ` · ${voice.quality}` : ''}</option>)}</select></label>
      <label><span>Серия</span><select value={episode} onChange={(event) => setEpisode(Number(event.target.value))} disabled={loadingSelection || !episodes.length}>{episodes.map((item) => <option key={item.episode} value={item.episode}>{item.episode}. {item.name}</option>)}</select></label>
    </div>}
    {state === 'found' && movie.mediaType === 'movie' && <div className="jellyfin-selectors"><label><span>Озвучка</span><select value={translationId} onChange={(event) => setTranslationId(event.target.value)}>{voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.name}{voice.quality ? ` · ${voice.quality}` : ''}</option>)}</select></label></div>}
    {state === 'found' && <button className="primary-button jellyfin-watch" disabled={starting || !translationId || (movie.mediaType === 'tv' && (!season || !episode || loadingSelection))} onClick={() => void start()}><Icon name="play" /> {starting ? 'Запускаем…' : 'Смотреть онлайн'}</button>}
  </section>;
}

function JellyfinAvailability({ movie, onWatch, activePlayback }: { movie: Movie; onWatch: (item: PlaybackItem) => void; activePlayback: PlaybackItem | null }) {
  const [state, setState] = useState<'idle' | 'checking' | 'missing' | 'found' | 'error'>('idle');
  const [itemId, setItemId] = useState('');
  const [itemTitle, setItemTitle] = useState('');
  const [seasons, setSeasons] = useState<JellyfinSeason[]>([]);
  const [seasonId, setSeasonId] = useState('');
  const [episodes, setEpisodes] = useState<JellyfinEpisode[]>([]);
  const [episodeId, setEpisodeId] = useState('');
  const [loadingEpisodes, setLoadingEpisodes] = useState(false);

  useEffect(() => {
    setState('idle'); setItemId(''); setItemTitle(''); setSeasons([]); setSeasonId(''); setEpisodes([]); setEpisodeId('');
  }, [movie.id, movie.mediaType]);

  const loadEpisodes = async (seriesId: string, nextSeasonId: string, preferredEpisodeId?: string) => {
    setSeasonId(nextSeasonId); setEpisodes([]); setEpisodeId(''); setLoadingEpisodes(true);
    try {
      const result = await api.streaming.jellyfinEpisodes(seriesId, nextSeasonId, movie.id);
      setEpisodes(result.episodes);
      setEpisodeId(result.episodes.some((episode) => episode.id === preferredEpisodeId) ? preferredEpisodeId! : (result.episodes[0]?.id || ''));
    } catch {
      setState('error');
    } finally { setLoadingEpisodes(false); }
  };

  useEffect(() => {
    if (!activePlayback?.seriesId || activePlayback.seriesId !== itemId || !activePlayback.seasonId) return;
    if (activePlayback.seasonId === seasonId) {
      setEpisodeId(activePlayback.id);
    } else {
      void loadEpisodes(itemId, activePlayback.seasonId, activePlayback.id);
    }
  }, [activePlayback?.id, activePlayback?.seasonId, activePlayback?.seriesId]);

  const check = async () => {
    setState('checking'); setItemId(''); setSeasons([]); setEpisodes([]); setEpisodeId('');
    try {
      const result = await api.streaming.checkJellyfin({ tmdbId: movie.id, mediaType: movie.mediaType, title: movie.title, originalTitle: movie.originalTitle, year: movie.year });
      if (!result.found || !result.itemId) { setState('missing'); return; }
      setItemId(result.itemId); setItemTitle(result.title || movie.title); setState('found');
      if (movie.mediaType === 'tv') {
        const seasonResult = await api.streaming.jellyfinSeasons(result.itemId, movie.id);
        setSeasons(seasonResult.seasons);
        if (seasonResult.seasons[0]) await loadEpisodes(result.itemId, seasonResult.seasons[0].id);
      }
    } catch { setState('error'); }
  };

  const selectedEpisode = episodes.find((episode) => episode.id === episodeId);
  const watchId = movie.mediaType === 'movie' ? itemId : episodeId;
  const watchTitle = movie.mediaType === 'movie' ? itemTitle : selectedEpisode ? episodeLabel(selectedEpisode) : movie.title;

  return <section className="jellyfin-availability" aria-live="polite">
    <div className="jellyfin-availability-heading"><span className="eyebrow">JELLYFIN</span>{state === 'found' && <strong>✓ {movie.mediaType === 'tv' ? 'Сериал найден' : 'Фильм найден'}</strong>}</div>
    {state === 'idle' && <button className="secondary-button" onClick={() => void check()}>Проверить в Jellyfin</button>}
    {state === 'checking' && <span className="jellyfin-message">Проверяем…</span>}
    {state === 'missing' && <span className="jellyfin-message">Нет в Jellyfin</span>}
    {state === 'error' && <div className="jellyfin-error"><span>Не удалось подключиться к Jellyfin</span><button className="secondary-button" onClick={() => void check()}>Повторить</button></div>}
    {state === 'found' && movie.mediaType === 'tv' && <div className="jellyfin-selectors">
      <label><span>Сезон</span><select value={seasonId} onChange={(event) => void loadEpisodes(itemId, event.target.value)} disabled={!seasons.length || loadingEpisodes}>{seasons.length ? seasons.map((season) => <option key={season.id} value={season.id}>{season.name}</option>) : <option>Нет доступных сезонов</option>}</select></label>
      <label><span>Серия</span><select value={episodeId} onChange={(event) => setEpisodeId(event.target.value)} disabled={loadingEpisodes || !episodes.length}><option value="">{loadingEpisodes ? 'Загружаем серии…' : 'Выберите серию'}</option>{episodes.map((episode) => <option key={episode.id} value={episode.id}>{episodeLabel(episode)}</option>)}</select></label>
    </div>}
    {state === 'found' && <button className="primary-button jellyfin-watch" disabled={!watchId || loadingEpisodes} onClick={() => onWatch({ id: watchId, title: watchTitle, seriesId: movie.mediaType === 'tv' ? itemId : undefined, seasonId: selectedEpisode?.seasonId, season: selectedEpisode?.season, episode: selectedEpisode?.episode })}><Icon name="play" /> Смотреть</button>}
  </section>;
}

function episodeLabel(episode: JellyfinEpisode) {
  return `S${String(episode.season).padStart(2, '0')}E${String(episode.episode).padStart(2, '0')} — ${episode.name}`;
}

export function ProfilePage() { const { user, setUser, logout } = useAuth(); const navigate = useNavigate(); const [stats, setStats] = useState<{ total: number; counts: Record<string, number>; avgRating: number } | null>(null); const [editing, setEditing] = useState(false); const [username, setUsername] = useState(user?.username || ''); const [email, setEmail] = useState(user?.email || ''); const [currentPassword, setCurrentPassword] = useState(''); const [newPassword, setNewPassword] = useState(''); const [message, setMessage] = useState(''); const [theme, setTheme] = useState(localStorage.getItem('kinolike-theme') || 'dark'); useEffect(() => { api.stats.overview().then(setStats).catch(() => setStats({ total: 0, counts: {}, avgRating: 0 })); document.documentElement.dataset.theme = theme; localStorage.setItem('kinolike-theme', theme); }, [theme]); if (!user) return null; const save = async (event: FormEvent) => { event.preventDefault(); try { const result = await api.auth.updateProfile({ username: username.trim(), email: email.trim() }); setUser(result.user); setEditing(false); setMessage('Профиль сохранён'); } catch (error) { setMessage(error instanceof Error ? error.message : 'Не удалось сохранить профиль'); } }; const setStreamingSource = async (preferred_streaming_source: 'phantom' | 'videohub') => { try { const result = await api.auth.updateProfile({ preferred_streaming_source }); setUser(result.user); setMessage('Источник онлайн-просмотра сохранён'); } catch (error) { setMessage(error instanceof Error ? error.message : 'Не удалось сохранить источник'); } }; const exportData = async () => { const data = await api.lists.exportAll(); const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = `kinolike-export-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url); }; const changePassword = async (event: FormEvent) => { event.preventDefault(); try { await api.auth.changePassword(currentPassword, newPassword); setCurrentPassword(''); setNewPassword(''); setMessage('Пароль изменён'); } catch (error) { setMessage(error instanceof Error ? error.message : 'Не удалось изменить пароль'); } }; const importData = async (event: React.ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (!file) return; try { const text = await file.text(); const items = JSON.parse(text); const result = await api.lists.importAll(items); setMessage(`Импортировано ${result.count} записей`); } catch (error) { setMessage(error instanceof Error ? error.message : 'Ошибка импорта'); } }; return <div className="profile-page glass-panel"><h1>Профиль</h1>{message && <p className="form-message">{message}</p>}<div className="profile-stats"><p>Фильмов и сериалов в списке: <strong>{stats?.total || 0}</strong></p>{stats && stats.avgRating > 0 && <p>Средняя оценка: <strong>{stats.avgRating.toFixed(1)}</strong></p>}</div>{editing ? <form onSubmit={save} className="profile-form"><label>Имя<input value={username} onChange={(e) => setUsername(e.target.value)} /></label><label>Email<input value={email} onChange={(e) => setEmail(e.target.value)} type="email" /></label><div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setEditing(false)}>Отмена</button><button type="submit" className="primary-button">Сохранить</button></div></form> : <div className="profile-info"><p><strong>{user.username}</strong></p><p>{user.email}</p><button className="secondary-button" onClick={() => setEditing(true)}>Редактировать</button></div>}<section className="profile-form streaming-source-setting"><h3>Источник онлайн-просмотра</h3><p className="muted">Если выбранный источник недоступен, KinoLike автоматически попробует второй.</p><div className="streaming-source-options" role="radiogroup" aria-label="Источник онлайн-просмотра">{([['phantom', 'Phantom'], ['videohub', 'VideoHUB']] as const).map(([value, label]) => <label key={value} className={user.preferred_streaming_source === value ? 'selected' : ''}><input type="radio" name="streaming-source" value={value} checked={user.preferred_streaming_source === value} onChange={() => void setStreamingSource(value)} /> <strong>{label}</strong>{value === 'phantom' && <small>По умолчанию</small>}</label>)}</div></section><form onSubmit={changePassword} className="profile-form"><h3>Изменить пароль</h3><label>Текущий пароль<input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} /></label><label>Новый пароль<input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} /></label><button type="submit" className="primary-button" disabled={!currentPassword || !newPassword}>Изменить пароль</button></form><div className="profile-data"><h3>Данные</h3><button className="secondary-button" onClick={() => void exportData()}>Экспорт данных</button><label className="secondary-button" style={{cursor:'pointer'}}>Импорт данных<input type="file" accept=".json" onChange={importData} style={{display:'none'}} /></label></div><button className="secondary-button" onClick={() => { logout(); navigate('/'); }} style={{marginTop:16,color:'var(--error)'}}>Выйти</button></div>; }

type PersonFilter = 'all' | MediaType;
type PersonSort = 'popular' | 'new' | 'old' | 'imdb';

function personWorkKey(work: PersonWork) {
  return work.tmdb_id && work.media_type
    ? `${work.media_type}:${work.tmdb_id}`
    : `imdb:${work.imdb_title_id || work.credit_id}`;
}

function personStatusLabel(status?: ListStatus | null) {
  if (status === 'watched') return 'Просмотрено';
  if (status === 'want_to_watch') return 'Хочу посмотреть';
  return 'Не добавлено';
}

function PersonWorkCard({ work, busy, onStatus }: {
  work: PersonWork;
  busy: boolean;
  onStatus: (work: PersonWork, status: ListStatus) => Promise<void>;
}) {
  const movie = personWorkToMovie(work);
  return <div className="person-work-card">
    <MovieCard movie={movie} compact showActions={false} />
    <div className="person-work-footer">
      <span className={`person-work-status ${work.status || 'none'}`}>{personStatusLabel(work.status)}</span>
      {work.can_add ? <div className="person-work-actions">
        <button className={work.status === 'want_to_watch' ? 'active' : ''} disabled={busy} onClick={() => void onStatus(work, 'want_to_watch')}>Хочу</button>
        <button className={work.status === 'watched' ? 'active' : ''} disabled={busy} onClick={() => void onStatus(work, 'watched')}>Просмотрено</button>
      </div> : <small>Точная связь с TMDB пока не найдена</small>}
    </div>
  </div>;
}

export function PersonPage() {
  const { id } = useParams();
  const [person, setPerson] = useState<Raw | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<PersonFilter>('all');
  const [sort, setSort] = useState<PersonSort>('popular');
  const [visibleCount, setVisibleCount] = useState(60);
  const [busyKey, setBusyKey] = useState('');
  const [statusOverrides, setStatusOverrides] = useState<Record<string, { status: ListStatus; list_id: number }>>({});

  useEffect(() => {
    setPerson(null);
    setError('');
    setStatusOverrides({});
    api.tmdb.person(Number(id)).then(setPerson).catch((requestError) => {
      setError(requestError instanceof Error ? requestError.message : 'Не удалось загрузить персону');
    });
  }, [id]);
  useEffect(() => setVisibleCount(60), [filter, sort]);

  const applyOverride = (work: PersonWork): PersonWork => {
    const override = statusOverrides[personWorkKey(work)];
    return override ? { ...work, ...override } : work;
  };
  const filmography = useMemo(() => {
    const works = ((person?.filmography || []) as PersonWork[])
      .map(applyOverride)
      .filter((work) => filter === 'all' || work.media_type === filter);
    return works.sort((left, right) => {
      if (sort === 'new') return (right.year || -1) - (left.year || -1);
      if (sort === 'old') return (left.year || Number.MAX_SAFE_INTEGER) - (right.year || Number.MAX_SAFE_INTEGER);
      if (sort === 'imdb') return (right.imdb_rating || -1) - (left.imdb_rating || -1)
        || (right.imdb_votes || 0) - (left.imdb_votes || 0);
      return right.work_score - left.work_score || (right.imdb_votes || 0) - (left.imdb_votes || 0);
    });
  }, [person, statusOverrides, filter, sort]);

  const setWorkStatus = async (work: PersonWork, status: ListStatus) => {
    if (!work.tmdb_id || !work.media_type) return;
    const key = personWorkKey(work);
    setBusyKey(key);
    setError('');
    try {
      const result = work.list_id
        ? await api.lists.update(work.list_id, { status, watched_at: status === 'watched' ? new Date().toISOString() : undefined })
        : await api.lists.add(work.tmdb_id, work.media_type, status);
      setStatusOverrides((current) => ({
        ...current,
        [key]: { status: result.item.status, list_id: Number(result.item.id) },
      }));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Не удалось обновить список');
    } finally {
      setBusyKey('');
    }
  };

  if (error && !person) return <div className="empty-page glass-panel"><h2>Персона недоступна</h2><p>{error}</p></div>;
  if (!person) return <div className="empty-page glass-panel"><span className="empty-icon">◌</span><p>Загружаем информацию…</p></div>;
  const visibleWorks = filmography.slice(0, visibleCount);

  return <div className="person-page">
    <div className="person-header glass-panel">
      {person.profile_path ? <img src={`/api/tmdb/image?path=${encodeURIComponent(person.profile_path)}&size=w342`} alt={person.name} /> : <span className="person-placeholder">👤</span>}
      <div><p className="eyebrow">АКТЁР / СОЗДАТЕЛЬ</p><h1>{person.name}</h1><p>{person.birthday ? `Родился: ${person.birthday}` : ''}{person.place_of_birth ? ` · ${person.place_of_birth}` : ''}</p>{person.imdb_id && <p className="person-imdb-id">IMDb ID: {person.imdb_id}</p>}<div className="person-bio">{person.biography || 'Биография отсутствует.'}</div></div>
    </div>
    {error && <p className="error-message detail-error">{error}</p>}
    <section className="person-filmography">
      <div className="section-heading"><h2>Фильмография</h2><span className="muted">{filmography.length} работ</span></div>
      <GlassPanel className="person-filmography-toolbar">
        <div className="recs-tabs" aria-label="Фильтр фильмографии">{([['all', 'Все'], ['movie', 'Фильмы'], ['tv', 'Сериалы']] as [PersonFilter, string][]).map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div>
        <label>Сортировка<select value={sort} onChange={(event) => setSort(event.target.value as PersonSort)}><option value="popular">Популярные</option><option value="new">Новые</option><option value="old">Старые</option><option value="imdb">IMDb</option></select></label>
      </GlassPanel>
      {visibleWorks.length > 0 ? <div className="person-work-grid">{visibleWorks.map((work) => <PersonWorkCard key={personWorkKey(work)} work={work} busy={busyKey === personWorkKey(work)} onStatus={setWorkStatus} />)}</div> : <div className="empty-page glass-panel"><p>Для выбранного фильтра работ нет.</p></div>}
      {visibleCount < filmography.length && <div className="load-more"><button className="secondary-button" onClick={() => setVisibleCount((count) => count + 60)}>Показать ещё</button></div>}
    </section>
  </div>;
}
