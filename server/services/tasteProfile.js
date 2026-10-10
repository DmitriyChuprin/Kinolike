const db = require('../db/database');
const ListItemModel = require('../models/listItem');

const CACHE_HOURS = Math.max(1, Number(process.env.TASTE_PROFILE_CACHE_HOURS) || 6);
const GENRE_VALUES = new Set(['love', 'neutral', 'dislike']);

const numberOrNull = value => value === '' || value == null ? null : Number(value);
const top = (map, limit = 6, positive = true) => [...map.values()]
  .filter(item => positive ? item.score > 0 : item.score < 0)
  .sort((a, b) => positive ? b.score - a.score : a.score - b.score)
  .slice(0, limit)
  .map(item => ({ ...item, score: Math.round(item.score * 100) / 100 }));

function addFeature(map, key, label, weight) {
  if (!key || !label) return;
  const current = map.get(String(key)) || { id: String(key), name: String(label), score: 0, count: 0 };
  current.score += weight;
  current.count += 1;
  map.set(String(key), current);
}

function deterministicSummary(profile) {
  if (!profile.sampleSize) return 'Добавляйте просмотренные фильмы и сериалы и ставьте оценки — KinoLike постепенно соберёт ваш профиль вкуса.';
  const parts = [];
  const genres = profile.favoriteGenres.slice(0, 2).map(item => item.name);
  if (genres.length) parts.push(`Вы чаще высоко оцениваете ${genres.join(' и ').toLowerCase()}`);
  const decades = profile.favoriteDecades.slice(0, 2).map(item => `${item.name}-е`);
  if (decades.length) parts.push(`вам особенно близки произведения ${decades.join(' и ')}`);
  if (profile.runtime?.preferred) parts.push(`обычная комфортная длительность фильма — около ${profile.runtime.preferred} минут`);
  if (profile.popularity === 'mainstream') parts.push('вы чаще выбираете известные произведения с надёжным количеством оценок');
  if (profile.popularity === 'discovery') parts.push('вы охотно смотрите менее известные произведения');
  return `${parts.join('. ')}${parts.length ? '.' : 'Профиль строится по вашей реальной истории и оценкам.'}`;
}

function buildTasteProfile(items, preferences = {}) {
  const maps = Object.fromEntries(['genres', 'directors', 'actors', 'countries', 'languages', 'decades'].map(key => [key, new Map()]));
  const distribution = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [index + 1, 0]));
  const characteristic = [];
  const runtimes = [];
  const popularities = [];
  let ratingSum = 0;
  let ratingCount = 0;
  let movies = 0;
  let tv = 0;

  for (const item of items) {
    const data = item.details || {};
    item.media_type === 'tv' ? tv += 1 : movies += 1;
    const rating = Number(item.rating) || 0;
    const weight = rating ? rating - 5.5 : 0.25;
    if (rating) { distribution[rating] += 1; ratingSum += rating; ratingCount += 1; }
    for (const genre of data.genres || []) addFeature(maps.genres, genre.id || genre.name, genre.name || genre, weight);
    for (const person of data.credits?.crew || []) if (person.job === 'Director') addFeature(maps.directors, person.id || person.name, person.name, weight);
    for (const person of (data.credits?.cast || []).slice(0, 10)) addFeature(maps.actors, person.id || person.name, person.name, weight);
    for (const country of data.production_countries || []) addFeature(maps.countries, country.iso_3166_1 || country.name, country.name, weight);
    if (data.original_language) addFeature(maps.languages, data.original_language, data.original_language.toUpperCase(), weight);
    const year = Number(String(data.release_date || data.first_air_date || item.release_year || '').slice(0, 4));
    if (year) addFeature(maps.decades, Math.floor(year / 10) * 10, Math.floor(year / 10) * 10, weight);
    if (item.media_type === 'movie' && Number(data.runtime) > 0 && rating >= 7) runtimes.push(Number(data.runtime));
    if (Number(data.popularity) >= 0 && rating >= 7) popularities.push(Number(data.popularity));
    if (rating >= 8) characteristic.push({ tmdb_id: item.tmdb_id, media_type: item.media_type, title: data.title || data.name || item.media_title, rating, poster_path: data.poster_path || item.poster_path || null });
  }

  const median = values => values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : null;
  const profile = {
    sampleSize: items.length,
    ratedCount: ratingCount,
    favoriteGenres: top(maps.genres),
    dislikedGenres: top(maps.genres, 6, false),
    favoriteDirectors: top(maps.directors), favoriteActors: top(maps.actors),
    preferredCountries: top(maps.countries), preferredLanguages: top(maps.languages),
    favoriteDecades: top(maps.decades),
    mediaBalance: { movies, tv, moviePercent: items.length ? Math.round(movies / items.length * 100) : 0 },
    averageRating: ratingCount ? Math.round(ratingSum / ratingCount * 10) / 10 : 0,
    ratingDistribution: distribution,
    runtime: { preferred: median(runtimes), sampleSize: runtimes.length },
    popularity: popularities.length ? (median(popularities) >= 30 ? 'mainstream' : 'discovery') : 'unknown',
    characteristicTitles: characteristic.sort((a, b) => b.rating - a.rating).slice(0, 6),
    preferences,
  };
  profile.summary = deterministicSummary(profile);
  return profile;
}

async function getPreferences(userId) {
  const { rows } = await db.query('SELECT * FROM user_taste_preferences WHERE user_id = $1', [userId]);
  return rows[0] || { user_id: userId, genre_preferences: {}, include_unknown: false, include_classics: true };
}

function validatePreferences(input = {}) {
  const genre_preferences = {};
  for (const [genre, value] of Object.entries(input.genre_preferences || {})) {
    if (GENRE_VALUES.has(value)) genre_preferences[String(genre)] = value;
  }
  const result = {
    genre_preferences,
    min_year: numberOrNull(input.min_year), max_year: numberOrNull(input.max_year),
    min_rating: numberOrNull(input.min_rating), min_vote_count: numberOrNull(input.min_vote_count),
    runtime_min: numberOrNull(input.runtime_min), runtime_max: numberOrNull(input.runtime_max),
    include_unknown: Boolean(input.include_unknown), include_classics: input.include_classics !== false,
  };
  if (result.min_year && (result.min_year < 1880 || result.min_year > 2200)) throw new Error('Некорректный минимальный год');
  if (result.max_year && (result.max_year < 1880 || result.max_year > 2200)) throw new Error('Некорректный максимальный год');
  if (result.min_year && result.max_year && result.min_year > result.max_year) throw new Error('Минимальный год больше максимального');
  if (result.min_rating != null && (result.min_rating < 0 || result.min_rating > 10)) throw new Error('Рейтинг должен быть от 0 до 10');
  if (result.runtime_min && result.runtime_max && result.runtime_min > result.runtime_max) throw new Error('Некорректный диапазон длительности');
  return result;
}

async function savePreferences(userId, input) {
  const value = validatePreferences(input);
  const { rows } = await db.query(`
    INSERT INTO user_taste_preferences
      (user_id, genre_preferences, min_year, max_year, min_rating, min_vote_count, runtime_min, runtime_max, include_unknown, include_classics)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (user_id) DO UPDATE SET genre_preferences=EXCLUDED.genre_preferences,
      min_year=EXCLUDED.min_year, max_year=EXCLUDED.max_year, min_rating=EXCLUDED.min_rating,
      min_vote_count=EXCLUDED.min_vote_count, runtime_min=EXCLUDED.runtime_min, runtime_max=EXCLUDED.runtime_max,
      include_unknown=EXCLUDED.include_unknown, include_classics=EXCLUDED.include_classics, updated_at=CURRENT_TIMESTAMP
    RETURNING *`, [userId, JSON.stringify(value.genre_preferences), value.min_year, value.max_year, value.min_rating,
      value.min_vote_count, value.runtime_min, value.runtime_max, value.include_unknown, value.include_classics]);
  await invalidate(userId);
  return rows[0];
}

async function getTasteProfile(userId, { refresh = false } = {}) {
  if (!refresh) {
    const { rows } = await db.query('SELECT profile FROM taste_profile_cache WHERE user_id=$1 AND expires_at > NOW()', [userId]);
    if (rows[0]) return rows[0].profile;
  }
  const [items, preferences] = await Promise.all([
    ListItemModel.findAllWithMetadata(userId, { status: 'watched' }), getPreferences(userId),
  ]);
  const profile = buildTasteProfile(items, preferences);
  await db.query(`INSERT INTO taste_profile_cache(user_id, profile, expires_at)
    VALUES($1,$2,NOW() + INTERVAL '1 hour' * $3)
    ON CONFLICT(user_id) DO UPDATE SET profile=EXCLUDED.profile, generated_at=NOW(), expires_at=EXCLUDED.expires_at`,
  [userId, JSON.stringify(profile), CACHE_HOURS]);
  return profile;
}

async function invalidate(userId) { await db.query('DELETE FROM taste_profile_cache WHERE user_id=$1', [userId]); }

module.exports = { buildTasteProfile, deterministicSummary, validatePreferences, getPreferences, savePreferences, getTasteProfile, invalidate };

