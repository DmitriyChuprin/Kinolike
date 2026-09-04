const ListItemModel = require('../models/listItem');
const RecommendationModel = require('../models/recommendation');
const tmdb = require('./tmdb');
const { build_user_profile, generate_recommendations } = require('./personalRecommendations');
const config = require('./recommendationConfig');
const pendingJobs = new Map();
const runningJobs = new Set();

async function mapWithLimit(items, limit, fn) {
  const results = []; let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const result = await fn(items[next++]); if (result) results.push(result); }
  }));
  return results;
}
async function generate_candidates(profile, excluded) {
  const found = new Map();
  const add = item => { if (item && item.id && !excluded.has(Number(item.id))) found.set(Number(item.id), item); };
  profile.ratedMovies.filter(movie => movie.rating >= 8).slice(0, 8).forEach(movie => (movie.raw.similar?.results || []).forEach(add));
  const genres = [...profile.features.genres.entries()].filter(([, value]) => value > 0).sort((a,b) => b[1] - a[1]).slice(0, 3);
  const discovered = await Promise.all(genres.map(([genre]) => tmdb.discoverMovies({ with_genres: genre, sort_by: 'popularity.desc', page: 1 }).catch(() => ({ results: [] }))));
  discovered.forEach(result => (result.results || []).forEach(add));
  if (found.size < 20) (await tmdb.getTopRatedMovies().catch(() => ({ results: [] }))).results.forEach(add);
  return [...found.values()].slice(0, config.CANDIDATE_LIMIT);
}
async function generateForUser(userId) {
  if (runningJobs.has(userId)) return [];
  runningJobs.add(userId);
  try {
    const all = await ListItemModel.findAllWithMetadata(userId);
    const watched = all.filter(item => item.status === 'watched' && item.media_type === 'movie');
    const profile = build_user_profile(watched);
    if (!profile.isSufficient) { await RecommendationModel.clearCache(userId); return []; }
    const candidates = await generate_candidates(profile, new Set(all.map(item => Number(item.tmdb_id))));
    const details = await mapWithLimit(candidates, 4, item => tmdb.getMovieDetails(item.id).catch(() => null));
    const { recommendations } = generate_recommendations({ watched, candidates: details });
    await RecommendationModel.save(userId, recommendations, Number(process.env.RECOMMENDATIONS_CACHE_TTL) || 24);
    return recommendations;
  } finally { runningJobs.delete(userId); }
}
function scheduleGeneration(userId) {
  if (pendingJobs.has(userId)) clearTimeout(pendingJobs.get(userId));
  pendingJobs.set(userId, setTimeout(() => { pendingJobs.delete(userId); generateForUser(userId).catch(err => console.error('[Recommendations]', err.message)); }, Number(process.env.RECOMMENDATIONS_DEBOUNCE_MS) || 1500));
}
module.exports = { scheduleGeneration, generateForUser, generate_candidates };
