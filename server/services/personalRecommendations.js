const config = require('./recommendationConfig');

const tokenize = text => new Set(String(text || '').toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(word => word.length >= 4));
const intersection = (a, b) => [...a].filter(value => b.has(value));
const jaccard = (a, b) => (!a.size && !b.size ? 0 : intersection(a, b).length / new Set([...a, ...b]).size);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function movie_data(item) {
  const data = item.details || item;
  const credits = data.credits || {};
  const year = Number(String(data.release_date || data.first_air_date || '').slice(0, 4));
  return {
    movie_id: Number(item.tmdb_id || data.id), tmdb_id: Number(item.tmdb_id || data.id), media_type: item.media_type || 'movie',
    title: data.title || data.name || `TMDB #${item.tmdb_id || data.id}`,
    rating: item.rating == null ? null : Number(item.rating), raw: data,
    genres: new Set((data.genres || []).map(g => String(g.id || g.name))),
    genreNames: new Map((data.genres || []).map(g => [String(g.id || g.name), g.name])),
    directors: new Set((credits.crew || []).filter(p => p.job === 'Director').map(p => String(p.id || p.name))),
    directorNames: new Map((credits.crew || []).filter(p => p.job === 'Director').map(p => [String(p.id || p.name), p.name])),
    actors: new Set((credits.cast || []).slice(0, 10).map(p => String(p.id || p.name))),
    actorNames: new Map((credits.cast || []).slice(0, 10).map(p => [String(p.id || p.name), p.name])),
    countries: new Set((data.production_countries || []).map(c => c.iso_3166_1 || c.name)),
    languages: new Set(data.original_language ? [data.original_language] : []),
    eras: new Set(year ? [String(Math.floor(year / 10) * 10)] : []),
    overview: tokenize(data.overview), year,
    vote_average: Number(data.vote_average || 0), vote_count: Number(data.vote_count || 0), popularity: Number(data.popularity || 0), runtime: Number(data.runtime || 0),
  };
}

function build_user_profile(watched) {
  const rated = watched.map(movie_data).filter(movie => config.RATING_WEIGHTS[movie.rating] !== undefined && movie.media_type === 'movie');
  const features = ['genres', 'directors', 'actors', 'countries', 'languages', 'eras', 'overview'];
  const totals = Object.fromEntries(features.map(feature => [feature, new Map()]));
  const names = Object.fromEntries(features.map(feature => [feature, new Map()]));
  let totalWeight = 0;
  for (const movie of rated) {
    const weight = config.RATING_WEIGHTS[movie.rating];
    if (!weight) continue;
    totalWeight += Math.abs(weight);
    for (const feature of features) {
      for (const value of movie[feature]) totals[feature].set(value, (totals[feature].get(value) || 0) + weight);
    }
    for (const [key, value] of movie.genreNames) names.genres.set(key, value);
    for (const [key, value] of movie.directorNames) names.directors.set(key, value);
    for (const [key, value] of movie.actorNames) names.actors.set(key, value);
  }
  const normalized = {};
  for (const feature of features) normalized[feature] = new Map([...totals[feature]].map(([key, value]) => [key, totalWeight ? clamp(value / totalWeight, -1, 1) : 0]));
  return { ratedMovies: rated, features: normalized, names, totalWeight, isSufficient: rated.length >= config.MIN_RATED_MOVIES && totalWeight > 0 };
}

function preference(profile, feature, values) {
  if (!values.size) return 0;
  return [...values].reduce((sum, value) => sum + (profile.features[feature].get(value) || 0), 0) / values.size;
}

function calculate_similarity(candidate, watchedMovie) {
  const candidateMovie = candidate.genres ? candidate : movie_data(candidate);
  const watched = watchedMovie.genres ? watchedMovie : movie_data(watchedMovie);
  return (jaccard(candidateMovie.genres, watched.genres) * 0.35)
    + (jaccard(candidateMovie.directors, watched.directors) * 0.20)
    + (jaccard(candidateMovie.actors, watched.actors) * 0.15)
    + (jaccard(candidateMovie.overview, watched.overview) * 0.20)
    + (jaccard(candidateMovie.countries, watched.countries) * 0.05)
    + (jaccard(candidateMovie.languages, watched.languages) * 0.05);
}

function calculate_movie_score(candidateInput, profile) {
  const candidate = candidateInput.genres ? candidateInput : movie_data(candidateInput);
  const component = {
    genres: preference(profile, 'genres', candidate.genres), directors: preference(profile, 'directors', candidate.directors),
    overview: preference(profile, 'overview', candidate.overview), actors: preference(profile, 'actors', candidate.actors),
    countries: preference(profile, 'countries', candidate.countries), languages: preference(profile, 'languages', candidate.languages), eras: preference(profile, 'eras', candidate.eras),
  };
  const high = profile.ratedMovies.filter(movie => config.RATING_WEIGHTS[movie.rating] >= 3);
  const low = profile.ratedMovies.filter(movie => config.RATING_WEIGHTS[movie.rating] < 0);
  const avgSimilarity = movies => movies.length ? movies.reduce((sum, movie) => sum + calculate_similarity(candidate, movie), 0) / movies.length : 0;
  component.similarity = avgSimilarity(high) - avgSimilarity(low);
  component.quality = clamp(((candidate.vote_average - 5) / 5) * 0.7 + Math.min(candidate.vote_count / 1000, 1) * 0.3, -1, 1);
  const weighted = component.genres * 0.25 + component.directors * 0.15 + component.overview * 0.15 + component.actors * 0.10
    + component.countries * 0.025 + component.languages * 0.015 + component.eras * 0.01 + component.similarity * 0.235 + component.quality * 0.05;
  return { score: Math.round(clamp(50 + weighted * 50, 0, 100)), components: component, candidate };
}

function reason_for(candidate, profile) {
  const matches = profile.ratedMovies.filter(movie => config.RATING_WEIGHTS[movie.rating] >= 2)
    .map(movie => ({ movie, similarity: calculate_similarity(candidate, movie) })).filter(item => item.similarity > 0).sort((a, b) => b.similarity - a.similarity).slice(0, 2);
  const shared = new Set();
  for (const item of matches) for (const key of intersection(candidate.genres, item.movie.genres)) shared.add(candidate.genreNames.get(key) || key);
  const matched_movies = matches.map(({ movie }) => ({ movie_id: movie.movie_id, title: movie.title, rating: movie.rating }));
  const titles = matched_movies.map(movie => `«${movie.title}» (${movie.rating}/10)`).join(' и ');
  const details = [...shared].slice(0, 3).join(', ');
  return { matched_movies, reason: titles ? `Похож на ${titles}${details ? `. Совпадают жанры: ${details}.` : '.'}` : 'Соответствует вашему профилю вкуса по доступным данным TMDB.' };
}

function apply_diversity(scored, limit = config.RESULT_LIMIT) {
  const selected = []; const genreCount = new Map(); const directors = new Set();
  for (const item of [...scored].sort((a, b) => b.score - a.score)) {
    const genres = [...item.candidate.genres]; const primaryGenre = genres[0]; const director = [...item.candidate.directors][0];
    const crowdedGenre = primaryGenre && (genreCount.get(primaryGenre) || 0) >= config.DIVERSITY.maxPerGenre;
    if ((crowdedGenre || (director && directors.has(director))) && selected.length >= Math.ceil(limit / 2)) continue;
    selected.push(item);
    if (primaryGenre) genreCount.set(primaryGenre, (genreCount.get(primaryGenre) || 0) + 1);
    if (director) directors.add(director);
    if (selected.length >= limit) break;
  }
  return selected;
}

function generate_recommendations({ watched, candidates, limit = config.RESULT_LIMIT }) {
  const profile = build_user_profile(watched);
  if (!profile.isSufficient) return { profile, recommendations: [] };
  const seen = new Set(watched.map(item => Number(item.tmdb_id || item.details?.id)));
  const scored = candidates.map(movie_data).filter(candidate => candidate.movie_id && candidate.genres.size && candidate.vote_count >= config.MIN_VOTE_COUNT)
    .filter(candidate => !seen.has(candidate.movie_id) && seen.add(candidate.movie_id))
    .map(candidate => ({ ...calculate_movie_score(candidate, profile), ...reason_for(candidate, profile) }));
  return { profile, recommendations: apply_diversity(scored, limit).map(item => ({ tmdb_id: item.candidate.movie_id, movie_id: item.candidate.movie_id, media_type: 'movie', title: item.candidate.title, score: item.score, reason: item.reason, matched_movies: item.matched_movies })) };
}

module.exports = { movie_data, build_user_profile, calculate_similarity, calculate_movie_score, apply_diversity, generate_recommendations };
