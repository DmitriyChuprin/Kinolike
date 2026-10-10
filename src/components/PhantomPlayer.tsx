/* eslint-disable @typescript-eslint/no-unused-vars */
import { useEffect, useRef, useState } from 'react';
import Artplayer from 'artplayer';
import Hls from 'hls.js';
import { api } from '../services/api';
import { attachSegmentSkip } from '../services/segmentSkip';
import type { MediaType } from '../types';

const AUTOPLAY_STORAGE_KEY = 'kinolike.phantom.autoplayNextEpisode';
type EpisodeAction = () => Promise<void> | void;
type Props = { url: string; source?: 'phantom' | 'videohub'; title: string; episodeTitle?: string; poster?: string; resumeKey: string; tmdbId: number; imdbId?: string; mediaType: MediaType; season?: number; episode?: number; translationId?: string; onPreviousEpisode?: EpisodeAction; previousEpisodeLabel?: string; onNextEpisode?: EpisodeAction; nextEpisodeLabel?: string; onClose: () => void };

// One Artplayer is retained while changing episodes. It prevents leaked HLS
// instances/listeners and keeps the modal stable between streams.
export function PhantomPlayer(props: Props) {
  const { url, source = 'phantom', title, episodeTitle, poster, resumeKey, tmdbId, imdbId, mediaType, season, episode, translationId, onPreviousEpisode, previousEpisodeLabel, onNextEpisode, nextEpisodeLabel, onClose } = props;
  const container = useRef<HTMLDivElement>(null); const playerRef = useRef<Artplayer | null>(null); const hlsRef = useRef<Hls | null>(null); const propsRef = useRef(props); propsRef.current = props;
  const activeKeyRef = useRef(''); const identityRef = useRef({ tmdbId, mediaType, season, episode, translationId }); const revisionRef = useRef(0); const saveRef = useRef<(keepalive?: boolean) => Promise<void>>(async () => {}); const switchingRef = useRef(false); const timerRef = useRef<number | null>(null); const autoplayNextRef = useRef(true); const segmentSkipRef = useRef<ReturnType<typeof attachSegmentSkip> | null>(null);
  const [error, setError] = useState(''); const [autoplayNext, setAutoplayNext] = useState(() => localStorage.getItem(AUTOPLAY_STORAGE_KEY) !== 'false'); const [qualityLevels, setQualityLevels] = useState<{ level: number; label: string }[]>([]); const [selectedQuality, setSelectedQuality] = useState(-1); const [nextPrompt, setNextPrompt] = useState(false); const [nextCountdown, setNextCountdown] = useState(10);
  const playbackKey = `${url}|${resumeKey}`;
  const clearNextTimer = () => { if (timerRef.current !== null) { window.clearInterval(timerRef.current); timerRef.current = null; } };
  useEffect(() => { autoplayNextRef.current = autoplayNext; localStorage.setItem(AUTOPLAY_STORAGE_KEY, String(autoplayNext)); }, [autoplayNext]);

  useEffect(() => {
    if (!container.current) return;
    let disposed = false; let saveQueue = Promise.resolve(); let segmentSkip: ReturnType<typeof attachSegmentSkip> | null = null;
    const destroyHls = () => { const hls = hlsRef.current; if (!hls) return; try { hls.destroy(); } catch {} hlsRef.current = null; };
    const createHls = (video: HTMLVideoElement, source: string) => {
      destroyHls();
      if (video.canPlayType('application/vnd.apple.mpegurl') || video.canPlayType('application/x-mpegURL')) { video.src = source; return; }
      if (!Hls.isSupported()) throw new Error('Этот браузер не поддерживает HLS');
      let networkRecoveries = 0; let mediaRecoveries = 0;
      const hls = new Hls({ maxBufferLength: 30, maxMaxBufferLength: 90, enableWorker: true }); hlsRef.current = hls; hls.loadSource(source); hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => { networkRecoveries = 0; mediaRecoveries = 0; const seen = new Set<string>(); const levels = hls.levels.flatMap((level, index) => { const label = level.height ? `${level.height}p` : level.width ? `${level.width}×${level.height}` : ''; if (!label || seen.has(label)) return []; seen.add(label); return [{ level: index, label }]; }); if (!disposed) { setQualityLevels(levels); setSelectedQuality(-1); } });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => { if (!disposed && hls.currentLevel !== -1) setSelectedQuality(Number(data.level)); });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        console.warn('[Online HLS]', {
          fatal: data.fatal, type: data.type, details: data.details,
          responseCode: data.response?.code, reason: data.reason,
          mediaType: propsRef.current.mediaType, season: propsRef.current.season, episode: propsRef.current.episode,
        });
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRecoveries++ < 2) {
          console.info(`[Online HLS] reconnecting after network error (${networkRecoveries}/2)`);
          hls.startLoad();
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries++ < 1) {
          console.info('[Online HLS] recovering media error (1/1)');
          hls.recoverMediaError();
          return;
        }
        if (!disposed) setError('Не удалось загрузить онлайн-поток');
      });
    };
    const queueSave = (keepalive = false) => {
      const player = playerRef.current; const identity = identityRef.current; if (!player) return saveQueue;
      const position = Number(player.currentTime || 0); const duration = Number(player.duration || 0); if (!Number.isFinite(position) || !Number.isFinite(duration) || position <= 5 || duration <= 0) return saveQueue;
      saveQueue = saveQueue.then(async () => { try { const saved = await api.streaming.savePhantomProgress({ tmdbId: identity.tmdbId, mediaType: identity.mediaType, ...(identity.mediaType === 'tv' ? { season: identity.season, episode: identity.episode } : {}), position, duration, baseRevision: revisionRef.current, ...(identity.translationId ? { translationId: identity.translationId } : {}) }, keepalive); revisionRef.current = saved.revision; } catch (reason) { console.warn('[Phantom] Не удалось сохранить прогресс:', reason); } }); return saveQueue;
    };
    saveRef.current = async (keepalive = false) => { await queueSave(keepalive); };
    const initial = propsRef.current; identityRef.current = { tmdbId: initial.tmdbId, mediaType: initial.mediaType, season: initial.season, episode: initial.episode, translationId: initial.translationId }; activeKeyRef.current = `${initial.url}|${initial.resumeKey}`;
    const runControlAction = (direction: 'previous' | 'next') => {
      const action = direction === 'previous' ? propsRef.current.onPreviousEpisode : propsRef.current.onNextEpisode;
      if (!action || switchingRef.current) return;
      switchingRef.current = true; clearNextTimer(); setNextPrompt(false);
      void queueSave().finally(() => Promise.resolve(action()).finally(() => window.setTimeout(() => { switchingRef.current = false; }, 300)));
    };
    const player = new Artplayer({ container: container.current, url: initial.url, type: 'm3u8', poster: initial.poster, autoplay: true, setting: true, playbackRate: true, aspectRatio: true, fullscreen: true, fullscreenWeb: true, pip: true, hotkey: true, playsInline: true, mutex: true, backdrop: true, theme: '#e8b95c', customType: { m3u8: createHls },
      ...(initial.mediaType === 'tv' ? { controls: [
        { name: 'phantom-previous-episode', position: 'left', index: 15, html: '«', click: () => runControlAction('previous') },
        { name: 'phantom-next-episode', position: 'left', index: 16, html: '»', click: () => runControlAction('next') },
      ] } : {}),
    }); playerRef.current = player;
    // Keep existing cross-device resume for the initially opened episode. A
    // deliberate episode switch below always starts at 00:00.
    void api.streaming.phantomProgress({ tmdbId: initial.tmdbId, mediaType: initial.mediaType, ...(initial.mediaType === 'tv' ? { season: initial.season, episode: initial.episode } : {}) }).then((progress) => { if (playerRef.current !== player || activeKeyRef.current !== `${initial.url}|${initial.resumeKey}`) return; revisionRef.current = progress.revision; if (!progress.completed && progress.position > 5) { const applyResume = () => { if (playerRef.current === player && player.duration > progress.position + 2) player.currentTime = progress.position; }; applyResume(); player.on('ready', applyResume); } }).catch(() => {});
    segmentSkip = attachSegmentSkip(player, { tmdbId: initial.tmdbId, imdbId: initial.imdbId, mediaType: initial.mediaType, season: initial.season, episode: initial.episode }); segmentSkipRef.current = segmentSkip;
    const advance = async (action?: EpisodeAction) => { if (!action || switchingRef.current) return; switchingRef.current = true; clearNextTimer(); setNextPrompt(false); try { await queueSave(); await action(); } finally { window.setTimeout(() => { switchingRef.current = false; }, 300); } };
    player.on('video:pause', () => { void queueSave(); });
    player.on('video:ended', () => { void queueSave().finally(() => { if (!propsRef.current.onNextEpisode || switchingRef.current) return; setNextPrompt(true); setNextCountdown(10); if (!autoplayNextRef.current) return; let remaining = 10; timerRef.current = window.setInterval(() => { remaining -= 1; setNextCountdown(remaining); if (remaining <= 0) { clearNextTimer(); void advance(propsRef.current.onNextEpisode); } }, 1000); }); });
    player.on('video:error', () => { void queueSave(); setError('Браузер не смог воспроизвести поток'); });
    const pagehide = () => { void queueSave(true); }; window.addEventListener('pagehide', pagehide);
    return () => { disposed = true; clearNextTimer(); window.removeEventListener('pagehide', pagehide); segmentSkip?.dispose(); segmentSkipRef.current = null; void queueSave(true); saveRef.current = async () => {}; if (playerRef.current === player) playerRef.current = null; destroyHls(); try { player.destroy(false); } catch {} };
  // Source changes are handled below through Artplayer.switchUrl.
  }, []);

  useEffect(() => {
    const player = playerRef.current; if (!player || activeKeyRef.current === playbackKey) return; let cancelled = false;
    void (async () => { await saveRef.current(); if (cancelled || playerRef.current !== player) return; identityRef.current = { tmdbId, mediaType, season, episode, translationId }; revisionRef.current = 0; try { const progress = await api.streaming.phantomProgress({ tmdbId, mediaType, ...(mediaType === 'tv' ? { season, episode } : {}) }); revisionRef.current = progress.revision; } catch {} if (cancelled || playerRef.current !== player) return; activeKeyRef.current = playbackKey; switchingRef.current = false; setError(''); setNextPrompt(false); clearNextTimer(); setQualityLevels([]); setSelectedQuality(-1); segmentSkipRef.current?.dispose(); segmentSkipRef.current = attachSegmentSkip(player, { tmdbId, imdbId, mediaType, season, episode }); try { hlsRef.current?.destroy(); } catch {} hlsRef.current = null; try { await player.switchUrl(url); player.currentTime = 0; void player.play(); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось сменить серию'); } })();
    return () => { cancelled = true; };
  }, [playbackKey, url, tmdbId, imdbId, mediaType, season, episode, translationId]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player || mediaType !== 'tv') return;
    const setState = (name: string, available: boolean) => {
      const control = player.controls[name]; if (!control) return;
      control.style.opacity = available ? '1' : '.35'; control.style.pointerEvents = available ? 'auto' : 'none'; control.setAttribute('aria-disabled', String(!available));
    };
    setState('phantom-previous-episode', Boolean(onPreviousEpisode)); setState('phantom-next-episode', Boolean(onNextEpisode));
  }, [mediaType, onPreviousEpisode, onNextEpisode]);

  const runAction = (action?: EpisodeAction) => { if (!action || switchingRef.current) return; switchingRef.current = true; clearNextTimer(); setNextPrompt(false); void saveRef.current().finally(() => Promise.resolve(action()).finally(() => window.setTimeout(() => { switchingRef.current = false; }, 300))); };
  const cancelNext = () => { clearNextTimer(); setNextPrompt(false); }; const serial = mediaType === 'tv';
  return <div className="modal-backdrop jellyfin-player-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="jellyfin-player-dialog glass-panel" role="dialog" aria-modal="true" aria-label={`Онлайн-просмотр: ${title}`}><button className="modal-close jellyfin-player-close" onClick={onClose} aria-label="Закрыть">×</button><div className="jellyfin-player-heading"><div><p className="eyebrow">ОНЛАЙН · {source === 'videohub' ? 'VIDEOHUB' : 'PHANTOM'}</p><h2>{title}</h2>{serial && episodeTitle && <p className="jellyfin-current-episode">{episodeTitle}</p>}</div><div>{qualityLevels.length > 1 && <label className="jellyfin-autoplay-toggle"><span>Качество</span><select value={selectedQuality} onChange={(event) => { const level = Number(event.target.value); setSelectedQuality(level); if (hlsRef.current) hlsRef.current.currentLevel = level; }}><option value={-1}>Авто</option>{qualityLevels.map((quality) => <option key={quality.level} value={quality.level}>{quality.label}</option>)}</select></label>}{serial && onNextEpisode && <label className="jellyfin-autoplay-toggle"><input type="checkbox" checked={autoplayNext} onChange={(event) => setAutoplayNext(event.target.checked)} /><span>Автовоспроизведение следующей серии</span><strong>{autoplayNext ? 'Включено' : 'Выключено'}</strong></label>}</div></div><div className="jellyfin-player-stage"><div ref={container} className="jellyfin-artplayer" />{serial && <div className="phantom-episode-controls"><button className="secondary-button" aria-label="Предыдущая серия" disabled={!onPreviousEpisode || switchingRef.current} onClick={() => runAction(onPreviousEpisode)}>«</button><button className="primary-button" aria-label="Следующая серия" disabled={!onNextEpisode || switchingRef.current} onClick={() => runAction(onNextEpisode)}>»</button></div>}{nextPrompt && onNextEpisode && <div className="jellyfin-next-overlay"><span>{autoplayNext ? `Следующая серия через ${nextCountdown} сек.` : 'Следующая серия'}</span><strong>{nextEpisodeLabel}</strong><div className="jellyfin-next-actions"><button className="primary-button" onClick={() => runAction(onNextEpisode)}>Смотреть сейчас</button>{autoplayNext && <button className="secondary-button" onClick={cancelNext}>Отмена</button>}</div></div>}{error && <div className="jellyfin-player-state error">{error}</div>}</div></div></div>;
}
