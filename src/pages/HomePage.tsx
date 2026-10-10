import { lazy, Suspense, useEffect, useState } from 'react';
import { GenreCard, HeroMovie, MovieRow } from '../components/ui';
import { Icon } from '../components/Icon';
import { Link, useNavigate } from 'react-router-dom';
import { api, listItemToMovie, recommendationToMovie, tmdbListToMovies, toMovie, type PhantomContinuePosition, type PhantomEpisode, type PhantomPlayback, type StreamingTrending } from '../services/api';
import { useAuth } from '../App';
import type { Genre, Movie } from '../types';

type ContinueItem = PhantomContinuePosition & { movie: Movie };
type PhantomMetadata = { tmdbId: number; mediaType: Movie['mediaType']; title: string; originalTitle?: string; imdbId?: string; year?: number };
type StreamingService = StreamingTrending['service'];
const streamingServices: { id: StreamingService; label: string }[] = [{ id: 'kion', label: 'KION' }, { id: 'wink', label: 'Wink' }, { id: 'premier', label: 'PREMIER' }];
const PhantomPlayer = lazy(() => import('../components/PhantomPlayer').then(module => ({ default: module.PhantomPlayer })));

function formatTime(seconds: number) {
  const total = Math.max(0, Math.floor(seconds)); const hours = Math.floor(total / 3600); const minutes = Math.floor((total % 3600) / 60);
  return hours ? `${hours} ч ${String(minutes).padStart(2, '0')} мин` : `${minutes} мин`;
}

function ContinueWatching({ items, onRemove, onPlay }: { items: ContinueItem[]; onRemove: (item: ContinueItem) => void; onPlay: (item: ContinueItem) => void }) {
  if (!items.length) return null;
  return <section className="movie-row continue-section" aria-label="Продолжить просмотр">
    <div className="section-heading"><h2>Продолжить просмотр</h2></div>
    <div className="movie-row-track continue-row-track">
      {items.map((item) => {
        const percent = item.duration > 0 ? Math.max(0, Math.min(100, item.position / item.duration * 100)) : 0;
        const episode = item.mediaType === 'tv' && item.season && item.episode ? `S${String(item.season).padStart(2, '0')}E${String(item.episode).padStart(2, '0')}` : '';
        const time = item.duration > 0 ? `${formatTime(item.position)} / ${formatTime(item.duration)}` : formatTime(item.position);
        return <article className="continue-card glass-panel" key={`${item.mediaType}-${item.tmdbId}-${item.season || 0}-${item.episode || 0}`}>
          <button className="continue-remove" type="button" onClick={() => onRemove(item)} aria-label={`Убрать «${item.movie.title}» из продолжения просмотра`}>×</button>
          <button className="continue-card-link" type="button" onClick={() => onPlay(item)} aria-label={`Продолжить: ${item.movie.title}${episode ? `, ${episode}` : ''}`}>
          <div className="continue-image">{item.movie.poster ? <img src={item.movie.poster} alt="" loading="lazy" decoding="async" /> : <span className="poster-placeholder"><Icon name="film" /></span>}<span className="play-float"><Icon name="play" /></span><span className="watch-progress"><i style={{ width: `${percent}%` }} /></span></div>
          <div className="continue-copy"><strong>{item.movie.title}</strong><small>{[episode, time].filter(Boolean).join(' · ')}</small><span className="continue-watch">Продолжить <Icon name="right" /></span></div>
          </button>
        </article>;
      })}
    </div>
  </section>;
}

export function HomePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [retry, setRetry] = useState(0);
  const add = async (movie: Movie) => {
    if (!user) { navigate('/login?next=%2F'); return; }
    await api.lists.add(movie.id, movie.mediaType);
  };
  const [hero, setHero] = useState<Movie | null>(null);
  const [popular, setPopular] = useState<Movie[]>([]);
  const [cinema, setCinema] = useState<Movie[]>([]);
  const [upcoming, setUpcoming] = useState<Movie[]>([]);
  const [topRated, setTopRated] = useState<Movie[]>([]);
  const [tvTrending, setTvTrending] = useState<Movie[]>([]);
  const [russianNew, setRussianNew] = useState<Movie[]>([]);
  const [russianNewType, setRussianNewType] = useState<'all' | 'movie' | 'tv'>('all');
  const [trendingService, setTrendingService] = useState<StreamingService>(() => {
    const saved = localStorage.getItem('streamingTrendingService') as StreamingService;
    return streamingServices.some(service => service.id === saved) ? saved : 'kion';
  });
  const [streamingTrending, setStreamingTrending] = useState<Movie[]>([]);
  const [streamingPositions, setStreamingPositions] = useState<number[]>([]);
  const [streamingLoading, setStreamingLoading] = useState(true);
  const [streamingUnavailable, setStreamingUnavailable] = useState(false);
  const [want, setWant] = useState<Movie[]>([]);
  const [continueWatching, setContinueWatching] = useState<ContinueItem[]>([]);
  const [recommended, setRecommended] = useState<Movie[]>([]);
  const [genres, setGenres] = useState<Genre[]>([]);
  const [error, setError] = useState('');
  const [phantomPlayback, setPhantomPlayback] = useState<{ item: ContinueItem; playback: PhantomPlayback; onNextEpisode?: () => void; nextEpisodeLabel?: string } | null>(null);
  const removeContinue = async (item: ContinueItem) => {
    try {
      await api.streaming.removePhantomProgress({ tmdbId: item.tmdbId, mediaType: item.mediaType, ...(item.mediaType === 'tv' ? { season: item.season || undefined, episode: item.episode || undefined } : {}) });
      setContinueWatching(current => current.filter((candidate) => candidate.tmdbId !== item.tmdbId || candidate.mediaType !== item.mediaType || candidate.season !== item.season || candidate.episode !== item.episode));
    } catch { /* Keep the card visible when the server did not confirm deletion. */ }
  };
  const startContinueEpisode = async (item: ContinueItem, metadata: PhantomMetadata, translationId: string, episodes: PhantomEpisode[], episode: number) => {
    const playback = await api.streaming.phantomPlayback({ ...metadata, tmdb_id: item.tmdbId, media_type: item.mediaType, translation_id: translationId, season: item.season || undefined, episode });
    const next = episodes.find((candidate) => candidate.episode > episode);
    setPhantomPlayback({
      item: { ...item, episode, translationId }, playback,
      ...(next ? {
        onNextEpisode: () => void startContinueEpisode(item, metadata, translationId, episodes, next.episode),
        nextEpisodeLabel: `${next.episode}. ${next.name}`,
      } : {}),
    });
  };
  const playContinue = async (item: ContinueItem) => {
    const metadata: PhantomMetadata = { tmdbId: item.tmdbId, mediaType: item.mediaType, title: item.movie.title, originalTitle: item.movie.originalTitle, imdbId: item.movie.imdbId, year: item.movie.year };
    try {
      let translationId = item.translationId || '';
      if (!translationId && item.mediaType === 'movie') {
        const found = await api.streaming.phantomCheck(metadata);
        translationId = found.voices?.[0]?.id || '';
      } else if (!translationId && item.season && item.episode) {
        const voices = await api.streaming.phantomVoices({ ...metadata, season: item.season });
        translationId = voices.voices[0]?.id || '';
      }
      if (!translationId) return;
      if (item.mediaType === 'tv' && item.season && item.episode) {
        const { episodes } = await api.streaming.phantomEpisodes({ ...metadata, season: item.season, translationId });
        await startContinueEpisode(item, metadata, translationId, episodes, item.episode);
      } else {
        const playback = await api.streaming.phantomPlayback({ ...metadata, tmdb_id: item.tmdbId, media_type: item.mediaType, translation_id: translationId });
        setPhantomPlayback({ item: { ...item, translationId }, playback });
      }
    } catch { /* The normal detail page remains available if Phantom is down. */ }
  };

  useEffect(() => {
    let cancelled = false;
    setError('');
    setHero(null);
    let coreFailures = 0;
    const setFeatured = (movies: Movie[]) => {
      const featured = movies[0];
      if (!featured || cancelled) return;
      setHero(current => current || featured);
      void api.tmdb.detail(featured.mediaType, featured.id).then(data => {
        if (!cancelled) setHero(current => current?.id === featured.id ? toMovie(data, featured.mediaType) : current);
      }).catch(() => {});
    };
    const coreFailed = (requestError: unknown) => {
      coreFailures += 1;
      if (coreFailures === 2 && !cancelled) setError(requestError instanceof Error ? requestError.message : 'Не удалось загрузить каталог');
    };

    void api.tmdb.trending('movie').then(data => setFeatured(tmdbListToMovies(data.results, 'movie'))).catch(coreFailed);
    void api.tmdb.popular().then(data => {
      if (cancelled) return;
      const movies = tmdbListToMovies(data.results, 'movie');
      setPopular(movies.slice(0, 10));
      setFeatured(movies);
      void api.tmdb.genres().then(genreData => {
        if (!cancelled) setGenres((genreData.movie || []).slice(0, 8).map(genre => ({ id: String(genre.id), name: genre.name, image: toMovie(data.results.find(item => item.genre_ids?.includes(genre.id))).poster, href: `/catalog?type=movie&genre=${genre.id}` })));
      }).catch(() => {});
    }).catch(coreFailed);
    void api.tmdb.trending('tv').then(data => { if (!cancelled) setTvTrending(tmdbListToMovies(data.results, 'tv').slice(0, 10)); }).catch(() => {});
    void api.tmdb.nowPlaying().then(data => { if (!cancelled) setCinema(tmdbListToMovies(data.results, 'movie').slice(0, 10)); }).catch(() => {});
    void api.tmdb.upcoming().then(data => { if (!cancelled) setUpcoming(tmdbListToMovies(data.results, 'movie').slice(0, 10)); }).catch(() => {});
    void api.tmdb.topRated().then(data => { if (!cancelled) setTopRated(tmdbListToMovies(data.results, 'movie').slice(0, 10)); }).catch(() => {});
    void api.home.russianNew().then(data => { if (!cancelled) setRussianNew(tmdbListToMovies(data.results)); }).catch(() => { if (!cancelled) setRussianNew([]); });
    return () => { cancelled = true; };
  }, [retry]);

  useEffect(() => {
    let cancelled = false;
    setStreamingLoading(true); setStreamingUnavailable(false);
    localStorage.setItem('streamingTrendingService', trendingService);
    void api.trending.streaming(trendingService).then(async (data) => {
      if (data.items.length === 0) {
        if (!cancelled) {
          setStreamingTrending([]); setStreamingPositions([]); setStreamingUnavailable(true);
        }
        return;
      }
      const resolved = await Promise.all(data.items.map(async item => {
        try { return { item, movie: toMovie(await api.tmdb.detail(item.mediaType, item.tmdbId), item.mediaType) }; } catch { return null; }
      }));
      if (!cancelled) {
        const rows = resolved.filter((row): row is { item: StreamingTrending['items'][number]; movie: Movie } => row !== null);
        setStreamingTrending(rows.map(row => row.movie)); setStreamingPositions(rows.map(row => row.item.position));
        setStreamingUnavailable(rows.length === 0 || Boolean(data.unavailable));
      }
    }).catch(() => { if (!cancelled) { setStreamingTrending([]); setStreamingPositions([]); setStreamingUnavailable(true); } }).finally(() => { if (!cancelled) setStreamingLoading(false); });
    return () => { cancelled = true; };
  }, [trendingService]);

  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setRecommended([]);
      setWant([]);
      setContinueWatching([]);
      return () => { cancelled = true; };
    }
    void api.recommendations.get().then(recs => { if (!cancelled) setRecommended(recs.recommendations?.map(recommendationToMovie).filter((item) => item.mediaType === 'movie').slice(0, 10) || []); }).catch(() => {});
    void api.lists.get('want_to_watch', { compact: 1 }).then(data => { if (!cancelled) setWant(data.items.map(listItemToMovie).slice(0, 10)); }).catch(() => {});
    void api.streaming.phantomContinue().then(async ({ items }) => {
      const resolved = await Promise.all(items.map(async (item) => {
        try { return { ...item, movie: toMovie(await api.tmdb.detail(item.mediaType, item.tmdbId), item.mediaType) }; } catch { return null; }
      }));
      if (!cancelled) setContinueWatching(resolved.filter((item): item is ContinueItem => item !== null));
    }).catch(() => { if (!cancelled) setContinueWatching([]); });
    return () => { cancelled = true; };
  }, [user, retry]);

  if (error) return <div className="empty-page glass-panel"><span className="empty-icon">!</span><h2>Каталог временно недоступен</h2><p>{error}</p><button className="secondary-button" onClick={() => setRetry(value => value + 1)}>Повторить</button></div>;
  if (!hero) return <div className="empty-page glass-panel"><span className="empty-icon">◌</span><p>Загружаем каталог…</p></div>;
  return <div className="home-page">
    <HeroMovie movie={hero} onAdd={add} />
    {user && <Link className="today-cta glass-panel" to="/recommendations?today=1"><span className="prompt-orb">✦</span><span><small>ПЕРСОНАЛЬНЫЙ ПОДБОР</small><strong>Что посмотреть сегодня?</strong><em>Опишите настроение — KinoLike предложит пять сильных вариантов</em></span><b>Подобрать →</b></Link>}
    {user && <ContinueWatching items={continueWatching} onRemove={(item) => void removeContinue(item)} onPlay={(item) => void playContinue(item)} />}
    {user && recommended.length > 0 && <MovieRow title="Рекомендации для вас" movies={recommended} action="Смотреть все" actionTo="/recommendations" showActions={false} />}
    {want.length > 0 && <MovieRow title="Из вашего списка" movies={want} action="Весь список" actionTo="/want" showActions={false} />}
    <section className="streaming-trending movie-row" aria-label="Что смотрят сейчас">
      <div className="section-heading"><h2>Что смотрят сейчас</h2><div className="streaming-tabs" role="tablist" aria-label="Стриминговый сервис">{streamingServices.map(service => <button key={service.id} type="button" role="tab" aria-selected={trendingService === service.id} className={trendingService === service.id ? 'active' : ''} onClick={() => setTrendingService(service.id)}>{service.label}</button>)}</div></div>
      {streamingLoading ? <p className="streaming-trending-state">Загружаем рейтинг…</p> : streamingTrending.length > 0 ? <MovieRow title={`Популярное на ${streamingServices.find(service => service.id === trendingService)?.label}`} movies={streamingTrending} className="streaming-trending-row" showActions={false} cardBadge={(_, index) => `№${streamingPositions[index] || index + 1}`} /> : <p className="streaming-trending-state">{streamingUnavailable ? 'Рейтинг этого сервиса пока недоступен. Попробуйте выбрать другой.' : 'В рейтинге пока нет подходящих фильмов и сериалов.'}</p>}
    </section>
    <MovieRow title="Популярное сейчас" movies={popular} action="Все фильмы" actionTo="/catalog?collection=popular" showActions={false} />
    {russianNew.length > 0 && <MovieRow title="Русские новинки" movies={russianNewType === 'all' ? russianNew : russianNew.filter(movie => movie.mediaType === russianNewType)} showActions={false} headingExtra={<div className="russian-new-tabs" role="group" aria-label="Тип русских новинок"><button type="button" className={russianNewType === 'all' ? 'active' : ''} onClick={() => setRussianNewType('all')}>Все</button><button type="button" className={russianNewType === 'movie' ? 'active' : ''} onClick={() => setRussianNewType('movie')}>Фильмы</button><button type="button" className={russianNewType === 'tv' ? 'active' : ''} onClick={() => setRussianNewType('tv')}>Сериалы</button></div>} />}
    <MovieRow title="Сейчас в кино" movies={cinema} action="Все фильмы" actionTo="/catalog?collection=cinema" showActions={false} />
    <MovieRow title="Сериалы в тренде" movies={tvTrending} action="Все сериалы" actionTo="/catalog?collection=tv" showActions={false} />
    <section className="genres-section"><div className="section-heading"><h2>По настроению и жанру</h2><Link className="section-action" to="/catalog">Все жанры</Link></div><div className="genre-grid">{genres.map(genre => <GenreCard genre={genre} key={genre.id} />)}</div></section>
    <MovieRow title="Фильмы с высоким рейтингом" movies={topRated} action="Все фильмы" actionTo="/catalog?collection=top" showActions={false} />
    <MovieRow title="Скоро выйдут" movies={upcoming} action="Все премьеры" actionTo="/catalog?collection=upcoming" showActions={false} />
    {phantomPlayback && <Suspense fallback={<div className="modal-backdrop"><div className="glass-panel player-loading" role="status">Загружаем плеер…</div></div>}><PhantomPlayer url={phantomPlayback.playback.url} source={phantomPlayback.playback.source} resumeKey={`${phantomPlayback.item.tmdbId}:${phantomPlayback.item.mediaType}:${phantomPlayback.item.season || 0}:${phantomPlayback.item.episode || 0}`} tmdbId={phantomPlayback.item.tmdbId} imdbId={phantomPlayback.item.movie.imdbId} mediaType={phantomPlayback.item.mediaType} season={phantomPlayback.item.season || undefined} episode={phantomPlayback.item.episode || undefined} translationId={phantomPlayback.item.translationId || undefined} title={phantomPlayback.item.movie.title} poster={phantomPlayback.item.movie.backdrop || phantomPlayback.item.movie.poster} onNextEpisode={phantomPlayback.onNextEpisode} nextEpisodeLabel={phantomPlayback.nextEpisodeLabel} onClose={() => setPhantomPlayback(null)} /></Suspense>}
  </div>;
}
