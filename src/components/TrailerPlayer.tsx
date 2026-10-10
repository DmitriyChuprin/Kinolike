import { useState } from 'react';
import type { MediaType } from '../types';
import { api, type Trailer } from '../services/api';

type Props = { mediaType: MediaType; tmdbId: number; trailer: Trailer; onTrailerChange: (trailer: Trailer | null) => void };

function embedSource(trailer: Trailer) {
  if (typeof trailer.embedUrl !== 'string' || trailer.embedUrl.length === 0) return null;
  if (trailer.source !== 'youtube') return trailer.embedUrl;
  const url = new URL(trailer.embedUrl);
  url.searchParams.set('origin', window.location.origin);
  url.searchParams.set('widget_referrer', window.location.origin);
  return url.toString();
}

export function TrailerPlayer({ mediaType, tmdbId, trailer: initialTrailer, onTrailerChange }: Props) {
  const [trailer, setTrailer] = useState(initialTrailer); const [retrying, setRetrying] = useState(false); const [failed, setFailed] = useState(false);
  const fallback = async () => {
    setRetrying(true);
    try { const result = await api.trailers.unavailable(mediaType, tmdbId, trailer); setFailed(!result.found); if (result.trailer) setTrailer(result.trailer); onTrailerChange(result.trailer); }
    catch { setFailed(true); }
    finally { setRetrying(false); }
  };
  const source = embedSource(trailer);
  if (failed || source === null) return <div className="trailer-fallback" role="status"><div className="trailer-fallback-copy"><strong>Трейлер не найден</strong><span>Доступных вариантов больше нет.</span></div></div>;
  return <div className="trailer-container"><iframe key={source} src={source} title={trailer.title || 'Трейлер'} referrerPolicy="strict-origin-when-cross-origin" allow="autoplay; clipboard-write; encrypted-media; picture-in-picture; fullscreen" allowFullScreen onError={() => void fallback()} /><div className="trailer-player-footer"><a href={trailer.url} target="_blank" rel="noreferrer">Открыть на {trailer.source}</a><button type="button" disabled={retrying} onClick={() => void fallback()}>{retrying ? 'Ищем…' : 'Не открывается'}</button></div></div>;
}
