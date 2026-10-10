const express = require('express');
const tmdb = require('../services/tmdb');
const { TrailerResolver } = require('../services/trailerResolver');

const router = express.Router();
const resolver = new TrailerResolver();

async function contextFor(req) {
  const mediaType = req.params.mediaType; const tmdbId = Number(req.params.tmdbId);
  if (!['movie', 'tv'].includes(mediaType) || !Number.isInteger(tmdbId) || tmdbId <= 0) return null;
  const details = mediaType === 'movie' ? await tmdb.getMovieDetails(tmdbId) : await tmdb.getTvDetails(tmdbId);
  const date = details.release_date || details.first_air_date || '';
  return { tmdbId, mediaType, title: details.title || details.name || '', originalTitle: details.original_title || details.original_name || '', year: Number(String(date).slice(0, 4)) || undefined };
}

router.get('/:mediaType/:tmdbId', async (req, res) => {
  try { const context = await contextFor(req); if (!context) return res.status(400).json({ error: 'Некорректный mediaType или tmdbId' }); res.json(await resolver.resolve(context)); }
  catch (error) { console.error('[TrailerResolver] Resolve failed:', error.message); res.status(502).json({ error: 'Не удалось найти трейлер' }); }
});
router.post('/:mediaType/:tmdbId/unavailable', async (req, res) => {
  try { const context = await contextFor(req); if (!context) return res.status(400).json({ error: 'Некорректный mediaType или tmdbId' }); const { source, videoId } = req.body || {}; if (!source) return res.status(400).json({ error: 'source обязателен' }); res.json(await resolver.unavailable({ ...context, source: String(source), videoId: videoId ? String(videoId) : undefined })); }
  catch (error) { console.error('[TrailerResolver] Fallback failed:', error.message); res.status(502).json({ error: 'Не удалось подобрать запасной трейлер' }); }
});
module.exports = router;
