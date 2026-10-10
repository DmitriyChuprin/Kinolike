import type Artplayer from 'artplayer';
import { api, type StreamingSegments } from './api';
import type { MediaType } from '../types';

type Input = { tmdbId: number; imdbId?: string; mediaType: MediaType; season?: number; episode?: number; duration?: number };

export function attachSegmentSkip(art: Artplayer, input: Input, getPosition: () => number = () => art.currentTime, seek: (target: number) => void = (target) => { art.currentTime = target; }) {
  let disposed = false;
  let requested = false;
  let segments: StreamingSegments | null = null;
  let retryTimer: number | null = null;
  let visibleKind: 'intro' | 'credits' | null = null;
  let activeTarget = 0;
  const layerName = 'streaming-segment-skip';
  const hideButton = () => {
    if (!visibleKind) return;
    art.layers.remove(layerName);
    visibleKind = null;
  };
  const showButton = (kind: 'intro' | 'credits', target: number) => {
    activeTarget = target;
    if (visibleKind === kind) return;
    hideButton();
    visibleKind = kind;
    console.log(kind === 'intro' ? '[Segments] Showing skip intro button' : '[Segments] Showing skip credits button');
    // This must live inside Artplayer's own layer stack. A React sibling of
    // the player sits below .art-layers (z-index: 40) and can be obscured by
    // its full-size overlay.
    art.layers.add({
      name: layerName,
      html: `<button type="button" class="segment-skip-button">${kind === 'intro' ? 'Пропустить заставку' : 'Пропустить титры'}</button>`,
      style: { position: 'absolute', right: '18px', bottom: '64px', pointerEvents: 'auto' },
      click: () => { if (activeTarget > 0) seek(activeTarget); },
    });
  };
  const update = () => {
    if (!segments || disposed) return hideButton();
    const time = getPosition();
    if (segments.intro && time >= segments.intro.start && time < segments.intro.end) {
      if (visibleKind !== 'intro') console.log('[Segments] INTRO ACTIVE', { currentTime: time, start: segments.intro.start, end: segments.intro.end });
      return showButton('intro', segments.intro.end);
    }
    if (segments.credits && time >= segments.credits.start && time < segments.credits.end) {
      if (visibleKind !== 'credits') console.log('[Segments] CREDITS ACTIVE', { currentTime: time, start: segments.credits.start, end: segments.credits.end });
      return showButton('credits', segments.credits.end);
    }
    hideButton();
  };
  const load = () => {
    if (requested || disposed) return;
    const duration = Number(input.duration || art.duration || 0);
    if (!Number.isFinite(duration) || duration <= 0) return;
    requested = true;
    void api.streaming.segments({ ...input, duration }).then((result) => {
      console.info('[Segments] Artplayer markers loaded', { tmdbId: input.tmdbId, mediaType: input.mediaType, season: input.season, episode: input.episode, duration, ...result });
      if (!disposed) { segments = result; update(); }
    }).catch((error) => { console.warn('[Segments] Artplayer markers unavailable', error); if (!disposed) hideButton(); });
  };
  // HLS implementations do not all emit the same first metadata event.  Use
  // native media events plus a bounded retry so a valid VOD duration cannot
  // silently leave skip support uninitialised.
  const retryLoad = () => { load(); if (!requested && !disposed) retryTimer = window.setTimeout(retryLoad, 500); };
  for (const event of ['loadedmetadata', 'durationchange', 'loadeddata', 'canplay', 'playing']) art.video.addEventListener(event, load);
  art.video.addEventListener('timeupdate', update);
  art.on('video:timeupdate', update);
  retryLoad();
  return { skip: () => { const action = [segments?.intro, segments?.credits].map((segment, index) => segment && getPosition() >= segment.start && getPosition() < segment.end ? { target: segment.end, index } : null).find(Boolean); if (action) seek(action.target); }, dispose: () => { disposed = true; if (retryTimer !== null) window.clearTimeout(retryTimer); hideButton(); for (const event of ['loadedmetadata', 'durationchange', 'loadeddata', 'canplay', 'playing']) art.video.removeEventListener(event, load); art.video.removeEventListener('timeupdate', update); art.off('video:timeupdate', update); } };
}
