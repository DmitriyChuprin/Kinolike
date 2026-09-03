// Фоновая генерация рекомендаций
// Запускается при изменении оценки/статуса, результат кэшируется

const ListItemModel = require('../models/listItem');
const RecommendationModel = require('../models/recommendation');
const tmdbService = require('../services/tmdb');
const { analyzePreferences } = require('../services/ai');

// Очередь на генерацию (по user_id)
const pendingJobs = new Map();
const runningJobs = new Set();

async function generateForUser(userId) {
  if (runningJobs.has(userId)) return;

  runningJobs.add(userId);

  try {
    const watched = await ListItemModel.findAll(userId, { status: 'watched' });

    if (watched.length === 0) {
      await RecommendationModel.clearCache(userId);
      return;
    }

    // Получаем данные из TMDB (с кэшированием)
    const watchedWithDetails = await Promise.all(
      watched.map(async (item) => {
        try {
          const details = item.media_type === 'movie'
            ? await tmdbService.getMovieDetails(item.tmdb_id)
            : await tmdbService.getTvDetails(item.tmdb_id);

          return {
            tmdb_id: item.tmdb_id,
            media_type: item.media_type,
            title: details.title || details.name,
            rating: item.rating,
            genres: (details.genres || []).map(g => g.name).join(', '),
          };
        } catch (err) {
          return {
            tmdb_id: item.tmdb_id,
            media_type: item.media_type,
            title: `TMDB #${item.tmdb_id}`,
            rating: item.rating,
            genres: '',
          };
        }
      })
    );

    // Генерируем через AI: анализ предпочтений → TMDB Discover (только фильмы,
    // сериалы рекомендуются через жанровые подборки)
    const forAnalysis = watchedWithDetails.filter(w => w.rating).slice(0, 50);
    if (forAnalysis.length === 0) return;

    const preferences = await analyzePreferences(forAnalysis);
    const movieParams = preferences.movie_params || {
      sort_by: 'vote_average.desc',
      'vote_average.gte': 6,
    };

    const movieResults = await tmdbService.discoverMovies(movieParams).catch(err => {
      console.error('[Recommendations] Ошибка фонового discover:', err.message);
      return { results: [] };
    });

    // Исключаем просмотренные и «хочу посмотреть»
    const wantToWatch = await ListItemModel.findAll(userId, { status: 'want_to_watch' });
    const excludeIds = new Set([
      ...watched.map(i => i.tmdb_id),
      ...wantToWatch.map(i => i.tmdb_id),
    ]);

    const limit = parseInt(process.env.AI_RECOMMENDATIONS_LIMIT) || 20;
    const recommendations = (movieResults.results || [])
      .filter(r => !excludeIds.has(r.id))
      .slice(0, limit)
      .map(item => ({
        tmdb_id: item.id,
        media_type: 'movie',
        score: item.vote_average ? parseFloat(item.vote_average.toFixed(1)) : 0,
      }));

    // Сохраняем в кэш
    const ttl = parseInt(process.env.AI_CACHE_TTL) || 24;
    await RecommendationModel.save(userId, recommendations, ttl);

    console.log(`Рекомендации сгенерированы для пользователя ${userId}: ${recommendations.length} шт.`);
  } catch (err) {
    console.error(`Ошибка фоновой генерации рекомендаций для ${userId}:`, err.message);
  } finally {
    runningJobs.delete(userId);
    if (pendingJobs.has(userId)) {
      pendingJobs.delete(userId);
      generateForUser(userId);
    }
  }
}

// Запланировать генерацию (debounce 2 сек)
// AI-рекомендации временно отключены — фоновая генерация не запускается,
// чтобы не тратить токены AI (страница рекомендаций работает на жанровых подборках)
function scheduleGeneration(userId) {
  return;
}

module.exports = { scheduleGeneration, generateForUser };
