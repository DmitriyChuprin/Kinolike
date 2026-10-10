import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Artplayer from 'artplayer';
import Hls from 'hls.js';
import { api, type JellyfinEpisode, type JellyfinPlayback } from '../services/api';
import { attachSegmentSkip } from '../services/segmentSkip';
import { buildDeviceProfile, detectBrowserCapabilities, getDeviceId, type BrowserCapabilities } from '../services/jellyfinPlayback';
import type { MediaType } from '../types';

const AUTOPLAY_STORAGE_KEY = 'kinolike.autoplayNextEpisode';

function formatPlaybackTime(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return [hours, minutes, secs].map((part) => String(part).padStart(2, '0')).join(':');
}

type Props = {
  mediaType: MediaType;
  tmdbId: number;
  imdbId?: string;
  season?: number;
  episode?: number;
  title: string;
  seriesTitle: string;
  itemId: string;
  seriesId?: string;
  poster?: string;
  onEpisodeChange?: (episode: JellyfinEpisode) => void;
  onClose: () => void;
};

type NextPrompt = { episode: JellyfinEpisode; countdown: number; timed: boolean };
type StopReason = 'player-close' | 'page-leave' | 'episode-change' | 'movie-change' | 'track-change' | 'ended' | 'component-unmount' | 'error';
type ActivePlaybackSession = {
  playback: JellyfinPlayback;
  itemId: string;
  art: Artplayer;
  hls: Hls | null;
  started: boolean;
  stopping: boolean;
  stopPromise: Promise<void> | null;
  progressTimer: number | null;
  generation: number;
  lastKnownPosition: number;
  // Jellyfin HLS is not consistent across stream modes: its media timeline
  // can either retain the item timeline or start from zero at StartTimeTicks.
  timeline: 'unknown' | 'absolute' | 'relative';
};

function getAbsolutePlaybackPosition(session: ActivePlaybackSession) {
  const mediaTime = Number.isFinite(session.art.currentTime) ? session.art.currentTime : null;
  if (mediaTime === null) return session.lastKnownPosition;
  const startSeconds = session.playback.type === 'm3u8' ? session.playback.startSeconds : 0;

  // Establish the HLS timeline from the media element, rather than assuming
  // one. A resumed HLS stream can expose either 0…N (relative) or the
  // absolute item timeline. Once established it is immutable per session.
  if (startSeconds > 0 && session.timeline === 'unknown') {
    session.timeline = mediaTime < startSeconds - 5 ? 'relative' : 'absolute';
    console.info(`[Playback Timeline]\nResumeSeconds: ${startSeconds.toFixed(1)}\nvideo.currentTime: ${mediaTime.toFixed(1)}\nMode: ${session.timeline}`);
  }
  const position = session.timeline === 'relative' ? startSeconds + mediaTime : mediaTime;

  if (session.playback.runtimeSeconds > 0 && position > session.playback.runtimeSeconds + 2) {
    console.warn(`[Playback Timeline] impossible absolute position ${position.toFixed(1)}s > runtime ${session.playback.runtimeSeconds.toFixed(1)}s; using last known position`);
    return session.lastKnownPosition;
  }
  return Math.max(0, position);
}

export function JellyfinPlayer({ mediaType, tmdbId, imdbId, season, episode, title, seriesTitle, itemId, seriesId, poster, onEpisodeChange, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const artRef = useRef<Artplayer | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const activeSessionRef = useRef<ActivePlaybackSession | null>(null);
  // A source that WebKit has explicitly discarded is negotiated again, but
  // never autoplayed: the next play must remain the user's gesture.
  const requiresUserPlayRef = useRef(false);
  const sessionGenerationRef = useRef(0);
  const clientSessionIdRef = useRef(`kinolike-view-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`);
  const resumeTimeRef = useRef(0);
  const nextEpisodeTimerRef = useRef<number | null>(null);
  const isSwitchingEpisodeRef = useRef(false);
  const endedHandledRef = useRef(false);
  const seriesEpisodesRef = useRef<JellyfinEpisode[]>([]);
  const autoplayNextRef = useRef(true);
  const startEpisodeRef = useRef<(episode: JellyfinEpisode) => void | Promise<void>>(() => {});
  const [activeItemId, setActiveItemId] = useState(itemId);
  const [activeTitle, setActiveTitle] = useState(title);
  const [activeEpisode, setActiveEpisode] = useState({ season, episode });
  const [capabilities, setCapabilities] = useState<BrowserCapabilities | null>(null);
  const [seriesEpisodes, setSeriesEpisodes] = useState<JellyfinEpisode[]>([]);
  const [mediaSourceId, setMediaSourceId] = useState<string | undefined>();
  const [audioStreamIndex, setAudioStreamIndex] = useState<number | undefined>();
  const [subtitleStreamIndex, setSubtitleStreamIndex] = useState(-1);
  const [playback, setPlayback] = useState<JellyfinPlayback | null>(null);
  const [playbackAttempt, setPlaybackAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [nextPlaybackFailed, setNextPlaybackFailed] = useState(false);
  const [nextPrompt, setNextPrompt] = useState<NextPrompt | null>(null);
  const [completionMessage, setCompletionMessage] = useState('');
  const [autoplayNext, setAutoplayNext] = useState(() => localStorage.getItem(AUTOPLAY_STORAGE_KEY) !== 'false');

  const profile = useMemo(() => capabilities ? buildDeviceProfile(capabilities) : null, [capabilities]);

  const clearNextEpisodeTimer = useCallback(() => {
    if (nextEpisodeTimerRef.current !== null) {
      window.clearInterval(nextEpisodeTimerRef.current);
      nextEpisodeTimerRef.current = null;
    }
  }, []);

  const stopPlayback = useCallback((reason: StopReason, keepalive = false): Promise<void> => {
    const session = activeSessionRef.current;
    if (!session) return Promise.resolve();
    if (session.stopPromise || session.stopping) {
      console.info(`[Playback Stop]\nignored: session already stopped\nPlaySessionId: ${session.playback.playSessionId}`);
      return session.stopPromise || Promise.resolve();
    }

    session.stopping = true;
    const position = getAbsolutePlaybackPosition(session);
    session.lastKnownPosition = position;
    const duration = Number.isFinite(session.art.duration) ? session.art.duration : 0;
    resumeTimeRef.current = reason === 'ended' ? 0 : position || resumeTimeRef.current;
    if (session.progressTimer !== null) window.clearInterval(session.progressTimer);
    session.progressTimer = null;

    console.info(`[Playback Stop]\nReason: ${reason}\nFinalPosition: ${position.toFixed(1)}\nPositionTicks: ${Math.round(position * 10_000_000)}\nPlaySessionId: ${session.playback.playSessionId}`);
    // Initiate the Jellyfin STOP while the final position is still intact.
    // The promise is intentionally retained to make explicit teardown and
    // component-unmount STOP idempotent for this exact PlaySessionId.
    const stopPromise = api.streaming.stopJellyfinPlayback({
      playSessionId: session.playback.playSessionId,
      clientSessionId: clientSessionIdRef.current,
      position,
      duration,
      reason,
    }, keepalive).then(() => {
      console.info('[Playback]\nJellyfin stop sent\nSession closed');
    }).catch((error) => {
      console.warn('[Playback] Не удалось отправить STOP; сессию завершит watchdog:', error);
    }).finally(() => {
      if (activeSessionRef.current === session) activeSessionRef.current = null;
    });
    session.stopPromise = stopPromise;

    try { session.art.pause(); } catch { /* already detached */ }
    const activeHls = session.hls || hlsRef.current;
    if (activeHls) {
      try { activeHls.stopLoad(); } catch { /* already stopped */ }
      try { activeHls.detachMedia(); } catch { /* already detached */ }
      try { activeHls.destroy(); } catch { /* already destroyed */ }
      if (hlsRef.current === activeHls) hlsRef.current = null;
      session.hls = null;
      console.info('[Playback]\nHLS destroyed');
    }
    const video = session.art.video;
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
    } catch { /* Artplayer may already have released the element */ }
    try { session.art.destroy(false); } catch { /* idempotent teardown */ }
    if (artRef.current === session.art) artRef.current = null;

    console.info(`[Cleanup]\nPlaySessionId: ${session.playback.playSessionId}\nReason: ${reason}\nSession generation: ${session.generation}`);
    return stopPromise;
  }, []);

  const flushProgress = useCallback((keepalive = false) => {
    const session = activeSessionRef.current;
    if (!session || session.stopping) return;
    const position = getAbsolutePlaybackPosition(session);
    session.lastKnownPosition = position;
    void api.streaming.progressJellyfinPlayback({
      playSessionId: session.playback.playSessionId,
      clientSessionId: clientSessionIdRef.current,
      position,
      duration: Number.isFinite(session.art.duration) ? session.art.duration : 0,
      isPaused: session.art.video.paused,
    }, keepalive).catch((reason) => console.warn('[PlayerLifecycle] progress flush failed:', reason));
  }, []);

  const recoverDiscardedMedia = useCallback((reason: string) => {
    const session = activeSessionRef.current;
    if (!session || session.stopping) return;
    // This is deliberately a conditional recovery. Merely going to the
    // background must not create a new Jellyfin/Artplayer session.
    resumeTimeRef.current = getAbsolutePlaybackPosition(session);
    requiresUserPlayRef.current = true;
    console.warn(`[PlayerLifecycle] restoring discarded media source (${reason}) at ${resumeTimeRef.current.toFixed(1)}s`);
    void stopPlayback('error').finally(() => {
      setPlayback(null);
      setPlaybackAttempt((attempt) => attempt + 1);
    });
  }, [stopPlayback]);

  const closePlayer = useCallback(() => {
    clearNextEpisodeTimer();
    void stopPlayback('player-close');
    onClose();
  }, [clearNextEpisodeTimer, onClose, stopPlayback]);

  useEffect(() => {
    autoplayNextRef.current = autoplayNext;
    localStorage.setItem(AUTOPLAY_STORAGE_KEY, String(autoplayNext));
  }, [autoplayNext]);

  useEffect(() => {
    if (autoplayNext || !nextPrompt?.timed) return;
    clearNextEpisodeTimer();
    setNextPrompt((current) => current ? { ...current, timed: false, countdown: 10 } : current);
  }, [autoplayNext, nextPrompt?.timed, clearNextEpisodeTimer]);

  useEffect(() => {
    seriesEpisodesRef.current = seriesEpisodes;
  }, [seriesEpisodes]);

  useEffect(() => {
    if (mediaType !== 'tv' || !seriesId) return;
    let active = true;
    api.streaming.jellyfinSeriesEpisodes(seriesId, tmdbId)
      .then((result) => { if (active) setSeriesEpisodes(result.episodes); })
      .catch((reason) => console.warn('[Jellyfin Player] Не удалось подготовить следующую серию:', reason));
    return () => { active = false; };
  }, [mediaType, seriesId, tmdbId]);

  useEffect(() => {
    let active = true;
    Promise.all([detectBrowserCapabilities(), api.streaming.jellyfinProgress(activeItemId).catch(() => ({ position: 0, duration: 0 }))])
      .then(([detected, savedPosition]) => {
        if (!active) return;
        setCapabilities(detected);
        resumeTimeRef.current = savedPosition.position > 5 && (!savedPosition.duration || savedPosition.position < savedPosition.duration - 20)
          ? savedPosition.position : 0;
      })
      .catch((reason) => active && setError(reason instanceof Error ? reason.message : 'Не удалось открыть Jellyfin'))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [activeItemId]);

  useEffect(() => {
    if (!activeItemId || !profile || !capabilities) return;
    let active = true;
    setLoading(true);
    setError('');
    // Jellyfin HLS needs the resume point during negotiation. Applying the
    // same value to video.currentTime later creates a stream from 00:00 and
    // then asks TorrServer for a second, unrelated range.
    const startTimeTicks = Math.round(Math.max(0, resumeTimeRef.current) * 10_000_000);
    if (startTimeTicks > 0) {
      console.info(`[Playback]\nResume:\nJellyfin ticks: ${startTimeTicks}\nSeconds: ${resumeTimeRef.current}\nRequested start: ${formatPlaybackTime(resumeTimeRef.current)}`);
    }
    api.streaming.jellyfinPlayback(activeItemId, {
      deviceId: getDeviceId(), clientSessionId: clientSessionIdRef.current,
      deviceProfile: profile, browser: capabilities.name, itemName: activeTitle,
      tmdbId, mediaType, mediaSourceId, audioStreamIndex, subtitleStreamIndex, startTimeTicks,
    }).then((result) => {
      if (!active) {
        void api.streaming.stopJellyfinPlayback({
          playSessionId: result.playSessionId, clientSessionId: clientSessionIdRef.current,
          position: 0, duration: 0, reason: 'page-leave',
        }, true).catch(() => {});
        return;
      }
      setPlayback(result);
      setMediaSourceId(result.mediaSourceId);
      setNextPlaybackFailed(false);
      isSwitchingEpisodeRef.current = false;
      console.info('[Jellyfin Playback]', result.diagnostics);
    }).catch((reason) => {
      if (!active) return;
      setError(reason instanceof Error ? reason.message : 'Ошибка PlaybackInfo');
      if (isSwitchingEpisodeRef.current) setNextPlaybackFailed(true);
      isSwitchingEpisodeRef.current = false;
    }).finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [activeItemId, profile, capabilities, activeTitle, tmdbId, mediaType, audioStreamIndex, subtitleStreamIndex, playbackAttempt]);

  const startEpisode = useCallback(async (episode: JellyfinEpisode) => {
    if (isSwitchingEpisodeRef.current || episode.id === activeItemId) return;
    isSwitchingEpisodeRef.current = true;
    clearNextEpisodeTimer();
    setNextPrompt(null);
    setCompletionMessage('');
    setNextPlaybackFailed(false);
    setError('');
    setLoading(true);
    await stopPlayback('episode-change');
    setPlayback(null);
    setMediaSourceId(undefined);
    setAudioStreamIndex(undefined);
    setSubtitleStreamIndex(-1);
    resumeTimeRef.current = 0;
    endedHandledRef.current = false;
    setActiveItemId(episode.id);
    setActiveTitle(episodeLabel(episode));
    setActiveEpisode({ season: episode.season, episode: episode.episode });
    onEpisodeChange?.(episode);
  }, [activeItemId, clearNextEpisodeTimer, onEpisodeChange, stopPlayback]);

  useEffect(() => { startEpisodeRef.current = startEpisode; }, [startEpisode]);

  const offerNextEpisode = useCallback((currentItemId: string) => {
    const episodes = seriesEpisodesRef.current;
    const currentIndex = episodes.findIndex((episode) => episode.id === currentItemId);
    const nextEpisode = currentIndex >= 0 ? episodes[currentIndex + 1] : undefined;
    if (!nextEpisode) {
      setCompletionMessage('Все доступные серии просмотрены');
      return;
    }
    clearNextEpisodeTimer();
    const timed = autoplayNextRef.current;
    setNextPrompt({ episode: nextEpisode, countdown: 10, timed });
    if (!timed) return;
    let remaining = 10;
    nextEpisodeTimerRef.current = window.setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearNextEpisodeTimer();
        setNextPrompt(null);
        void startEpisodeRef.current(nextEpisode);
        return;
      }
      setNextPrompt((current) => current?.episode.id === nextEpisode.id ? { ...current, countdown: remaining } : current);
    }, 1000);
  }, [clearNextEpisodeTimer]);

  useEffect(() => {
    if (!playback || !containerRef.current) return;
    const playbackItemId = activeItemId;
    let resumeApplied = false;
    let segmentSkip: ReturnType<typeof attachSegmentSkip> | null = null;
    const destroyHls = (hls: Hls | null) => {
      if (!hls) return;
      try { hls.stopLoad(); } catch { /* already stopped */ }
      try { hls.detachMedia(); } catch { /* already detached */ }
      try { hls.destroy(); } catch { /* already destroyed */ }
      if (hlsRef.current === hls) hlsRef.current = null;
    };
    const switchTrack = async (kind: 'audio' | 'subtitle', index: number) => {
      resumeTimeRef.current = artRef.current?.currentTime || 0;
      await stopPlayback('track-change');
      setPlayback(null);
      if (kind === 'audio') setAudioStreamIndex(index);
      else setSubtitleStreamIndex(index);
    };
    const applyResumePosition = () => {
      if (resumeApplied || resumeTimeRef.current <= 0) return;
      const art = artRef.current;
      if (!art || !Number.isFinite(art.duration) || art.duration <= resumeTimeRef.current + 20) return;

      // Jellyfin Web performs this native seek for HLS too, once duration is
      // available. PlaybackInfo's StartTimeTicks negotiates the source; the
      // media element still begins its HLS timeline at zero in this server
      // version. Skipping this seek was why KinoLike showed the first frame.
      art.currentTime = resumeTimeRef.current;
      resumeApplied = true;
      const activeSession = activeSessionRef.current;
      if (activeSession?.playback.playSessionId === playback.playSessionId) {
        activeSession.timeline = 'absolute';
      }
      console.info(`[Playback Timeline]\nResumeSeconds: ${resumeTimeRef.current.toFixed(1)}\nvideo.currentTime: ${art.currentTime.toFixed(1)}\nMode: absolute (Jellyfin Web native seek)`);
    };
    let art: Artplayer;
    try {
      art = new Artplayer({
        container: containerRef.current, url: playback.url, type: playback.type === 'm3u8' ? 'm3u8' : undefined,
        poster, autoplay: !requiresUserPlayRef.current, setting: true, playbackRate: true, aspectRatio: true, fullscreen: true,
        fullscreenWeb: true, pip: true, hotkey: true, playsInline: true, mutex: true, backdrop: true, theme: '#e8b95c',
        ...(playback.subtitleUrl ? { subtitle: { url: playback.subtitleUrl, type: 'vtt', encoding: 'utf-8' } } : {}),
        settings: [
          {
            name: 'jellyfin-audio', html: 'Аудио', width: 360,
            tooltip: playback.audioTracks.find((track) => track.index === playback.audioStreamIndex)?.label || '',
            selector: playback.audioTracks.map((track) => ({ html: track.label, value: track.index, default: track.index === playback.audioStreamIndex })),
            onSelect(item) { void switchTrack('audio', Number(item.value)); },
          },
          {
            name: 'jellyfin-subtitles', html: 'Субтитры', width: 300,
            tooltip: playback.subtitleStreamIndex < 0 ? 'Выключены' : playback.subtitleTracks.find((track) => track.index === playback.subtitleStreamIndex)?.label || '',
            selector: [{ html: 'Выключены', value: -1, default: playback.subtitleStreamIndex < 0 }, ...playback.subtitleTracks.map((track) => ({ html: track.label, value: track.index, default: track.index === playback.subtitleStreamIndex }))],
            onSelect(item) { void switchTrack('subtitle', Number(item.value)); },
          },
        ],
        customType: {
          m3u8(video, url) {
            destroyHls(hlsRef.current);
            if (video.canPlayType('application/vnd.apple.mpegurl') || video.canPlayType('application/x-mpegURL')) { video.src = url; return; }
            if (Hls.isSupported()) {
              const hls = new Hls({ maxBufferLength: 30, maxMaxBufferLength: 90, enableWorker: true });
              hlsRef.current = hls; hls.loadSource(url); hls.attachMedia(video);
              if (activeSessionRef.current?.playback.playSessionId === playback.playSessionId) activeSessionRef.current.hls = hls;
              hls.on(Hls.Events.ERROR, (_event, data) => {
                if (!data.fatal) return;
                if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
                else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
                else destroyHls(hls);
              });
              return;
            }
            throw new Error('Этот браузер не поддерживает HLS');
          },
        },
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Artplayer не удалось инициализировать');
      void api.streaming.stopJellyfinPlayback({
        playSessionId: playback.playSessionId, clientSessionId: clientSessionIdRef.current,
        position: 0, duration: 0, reason: 'error',
      }).catch(() => {});
      return;
    }
    artRef.current = art;
    // Artplayer reads autoplay during construction. The flag only applies to
    // this recovered instance; later explicit source changes keep their
    // existing playback behaviour.
    requiresUserPlayRef.current = false;
    const session: ActivePlaybackSession = {
      playback, itemId: playbackItemId, art, hls: hlsRef.current,
      started: false, stopping: false, stopPromise: null, progressTimer: null,
      // If media fails before its first timestamp, preserve the negotiated
      // resume point instead of reporting a destructive zero-position STOP.
      lastKnownPosition: playback.startSeconds,
      timeline: 'unknown',
      generation: ++sessionGenerationRef.current,
    };
    activeSessionRef.current = session;
    segmentSkip = attachSegmentSkip(
      art,
      { tmdbId, imdbId, mediaType, season: activeEpisode.season, episode: activeEpisode.episode, duration: playback.runtimeSeconds },
      () => getAbsolutePlaybackPosition(session),
      (target) => { art.currentTime = session.timeline === 'relative' ? Math.max(0, target - playback.startSeconds) : target; },
    );
    const lifecycleData = (isInitialStart = false) => {
      // Before the HLS media timeline is readable, the negotiated resume point
      // is the only valid position. Never let PlaybackStart(0) overwrite it.
      const position = isInitialStart && playback.type === 'm3u8' && playback.startSeconds > 0
        ? playback.startSeconds
        : getAbsolutePlaybackPosition(session);
      session.lastKnownPosition = position;
      return {
      playSessionId: playback.playSessionId,
      clientSessionId: clientSessionIdRef.current,
      // HLS media time starts at zero when Jellyfin was asked for a partial
      // stream; Jellyfin events must still use the item's absolute position.
      position,
      duration: Number.isFinite(art.duration) ? art.duration : 0,
      isPaused: art.video.paused,
      };
    };
    const reportProgress = () => {
      if (session.stopping || activeSessionRef.current !== session) return;
      const data = lifecycleData();
      console.info(`[Playback Progress]\nItemId: ${playbackItemId}\nPlaySessionId: ${playback.playSessionId}\nCurrentTime: ${data.position.toFixed(1)}\nPositionTicks: ${Math.round(data.position * 10_000_000)}\nIsPaused: ${data.isPaused}`);
      void api.streaming.progressJellyfinPlayback(data)
        .catch((reason) => console.warn('[Playback] Не удалось отправить heartbeat:', reason));
    };
    const lifecycleSnapshot = (event: string) => ({
      event,
      visibility: document.visibilityState,
      currentTime: art.video.currentTime,
      paused: art.video.paused,
      ended: art.video.ended,
      readyState: art.video.readyState,
      networkState: art.video.networkState,
      src: art.video.src,
      currentSrc: art.video.currentSrc,
      hasArtplayer: artRef.current === art,
      hls: Boolean(session.hls),
    });
    const nativePlay = art.video.play.bind(art.video);
    // Artplayer invokes HTMLMediaElement.play() internally, so observe that
    // promise at its source. Safari otherwise hides a rejected promise behind
    // the control click and gives us no actionable signal.
    art.video.play = () => {
      const attempt = nativePlay();
      void attempt.catch((reason) => console.warn('[PlayerLifecycle] video.play() rejected', lifecycleSnapshot('play-rejected'), reason));
      return attempt;
    };
    const reportStart = () => {
      if (session.started || session.stopping) return;
      session.started = true;
      console.info(`[Playback]\nItemId: ${playbackItemId}\nMediaSourceId: ${playback.mediaSourceId}\nPlaySessionId: ${playback.playSessionId}\nMode: ${playback.type === 'm3u8' ? 'HLS' : 'Direct Play'}\nStartTimeTicks: ${Math.round(playback.startSeconds * 10_000_000)}\nStartSeconds: ${playback.startSeconds}\nHLS URL: ${playback.type === 'm3u8' ? 'configured (proxy URL hidden)' : 'n/a'}\nSession generation: ${session.generation}\nSTART`);
      void api.streaming.startJellyfinPlayback(lifecycleData(true))
        .catch((reason) => console.warn('[Playback] Не удалось отправить START:', reason));
      session.progressTimer = window.setInterval(reportProgress, 10_000);
    };
    art.on('ready', () => {
      applyResumePosition();
      if (!art.video.paused) reportStart();
    });
    // Match Jellyfin Web: duration can become available after either metadata,
    // loaded data, or the first play event depending on the HLS implementation.
    for (const event of ['durationchange', 'loadeddata', 'play', 'loadedmetadata']) {
      art.video.addEventListener(event, applyResumePosition, { once: resumeApplied });
    }
    art.on('video:play', reportStart);
    art.on('video:playing', reportStart);
    art.on('video:pause', reportProgress);
    art.on('video:timeupdate', () => { void lifecycleData(); });
    art.on('video:seeked', () => {
      console.info(`[Seek]\nFrom: unknown\nTo: ${art.currentTime.toFixed(1)}\nStrategy: native`);
      reportProgress();
    });
    art.on('video:ended', () => {
      if (endedHandledRef.current) return;
      endedHandledRef.current = true;
      resumeTimeRef.current = 0;
      void stopPlayback('ended').finally(() => {
        if (mediaType === 'tv' && seriesId) offerNextEpisode(playbackItemId);
      });
    });
    art.on('video:error', () => {
      const mediaError = art.video.error;
      console.warn('[PlayerLifecycle] video error', lifecycleSnapshot('error'), mediaError);
      setError(mediaError ? `Ошибка видео: ${mediaError.message || mediaError.code}` : 'Браузер не смог загрузить медиапоток');
      // A failed source after WebKit resumed from background cannot be made
      // healthy by calling play() again. Negotiate a new source, preserving
      // its position, but leave it paused for the user.
      if (document.visibilityState === 'visible' && session.started) recoverDiscardedMedia('video-error');
    });
    for (const event of ['waiting', 'stalled', 'suspend']) {
      art.video.addEventListener(event, () => console.warn('[PlayerLifecycle] media warning', lifecycleSnapshot(event)));
    }
    return () => {
      segmentSkip?.dispose();
      if (activeSessionRef.current === session) void stopPlayback('page-leave');
    };
  }, [playback, activeItemId, activeEpisode, poster, tmdbId, imdbId, mediaType, seriesId, offerNextEpisode, stopPlayback, recoverDiscardedMedia]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') closePlayer(); };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [closePlayer]);
  useEffect(() => {
    const inspectReturnedMedia = (event: string, persisted?: boolean) => {
      const session = activeSessionRef.current;
      if (!session) return;
      const video = session.art.video;
      const sourceLost = Boolean(video.error) || !video.currentSrc || video.networkState === HTMLMediaElement.NETWORK_NO_SOURCE;
      if (sourceLost) {
        console.warn('[PlayerLifecycle] media source unavailable after lifecycle transition', {
          event, persisted, visibility: document.visibilityState, currentTime: video.currentTime,
          paused: video.paused, ended: video.ended, readyState: video.readyState,
          networkState: video.networkState, src: video.src, currentSrc: video.currentSrc,
          hasArtplayer: artRef.current === session.art, hls: Boolean(session.hls),
        });
        recoverDiscardedMedia(`${event}-no-source`);
      }
    };
    const visibilitychange = () => {
      if (document.hidden) flushProgress(true);
      else inspectReturnedMedia('visibilitychange');
    };
    // iOS Safari can dispatch pagehide when the device locks. It is not a
    // component unmount, so stopping here used to remove src/destroy Artplayer
    // while the modal stayed mounted.
    const pagehide = () => { flushProgress(true); };
    const pageshow = (event: PageTransitionEvent) => {
      inspectReturnedMedia('pageshow', event.persisted);
    };
    document.addEventListener('visibilitychange', visibilitychange);
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('pageshow', pageshow);
    return () => {
      document.removeEventListener('visibilitychange', visibilitychange);
      window.removeEventListener('pagehide', pagehide);
      window.removeEventListener('pageshow', pageshow);
    };
  }, [flushProgress, recoverDiscardedMedia]);
  useEffect(() => () => clearNextEpisodeTimer(), [clearNextEpisodeTimer]);

  const cancelNext = () => { clearNextEpisodeTimer(); setNextPrompt(null); };
  const retryNext = () => {
    if (isSwitchingEpisodeRef.current) return;
    isSwitchingEpisodeRef.current = true;
    setNextPlaybackFailed(false); setError(''); setPlaybackAttempt((attempt) => attempt + 1);
  };

  return <div className="modal-backdrop jellyfin-player-backdrop" onMouseDown={(event) => event.target === event.currentTarget && closePlayer()}>
    <div className="jellyfin-player-dialog glass-panel" role="dialog" aria-modal="true" aria-label={`Просмотр: ${seriesTitle}`}>
      <button className="modal-close jellyfin-player-close" onClick={closePlayer} aria-label="Закрыть">×</button>
      <div className="jellyfin-player-heading">
        <div><p className="eyebrow">JELLYFIN · {capabilities?.name || 'определяем браузер'}</p><h2>{seriesTitle}</h2>{mediaType === 'tv' && <p className="jellyfin-current-episode">{activeTitle}</p>}</div>
        {mediaType === 'tv' && <label className="jellyfin-autoplay-toggle"><input type="checkbox" checked={autoplayNext} onChange={(event) => setAutoplayNext(event.target.checked)} /><span>Автовоспроизведение следующей серии</span><strong>{autoplayNext ? 'Включено' : 'Выключено'}</strong></label>}
      </div>
      <div className="jellyfin-player-stage">
        <div ref={containerRef} className="jellyfin-artplayer" />
        {loading && <div className="jellyfin-player-state">Подготавливаем совместимый поток…</div>}
        {error && !nextPlaybackFailed && <div className="jellyfin-player-state error"><strong>Не удалось начать воспроизведение</strong><span>{error}</span></div>}
        {nextPlaybackFailed && <div className="jellyfin-player-state error"><strong>Не удалось запустить следующую серию</strong><span>{error}</span><div className="jellyfin-next-actions"><button className="primary-button" onClick={retryNext}>Повторить</button><button className="secondary-button" onClick={closePlayer}>Закрыть</button></div></div>}
        {nextPrompt && <div className="jellyfin-next-overlay"><span>{nextPrompt.timed ? `Следующая серия через ${nextPrompt.countdown} сек.` : 'Следующая серия'}</span><strong>{episodeLabel(nextPrompt.episode)}</strong><div className="jellyfin-next-actions"><button className="primary-button" onClick={() => startEpisode(nextPrompt.episode)}>{nextPrompt.timed ? 'Смотреть сейчас' : 'Смотреть'}</button>{nextPrompt.timed && <button className="secondary-button" onClick={cancelNext}>Отмена</button>}</div></div>}
        {completionMessage && <div className="jellyfin-next-overlay jellyfin-complete"><strong>{completionMessage}</strong></div>}
      </div>
      {playback && <div className="jellyfin-playback-debug"><strong>Режим: {playback.diagnostics.protocol}</strong><span>Видео: {playback.diagnostics.video} · {playback.diagnostics.videoMode}</span><span>Аудио: {playback.diagnostics.audio} · {playback.diagnostics.audioMode}</span></div>}
    </div>
  </div>;
}

function episodeLabel(episode: JellyfinEpisode) {
  return `S${String(episode.season).padStart(2, '0')}E${String(episode.episode).padStart(2, '0')} — ${episode.name}`;
}
