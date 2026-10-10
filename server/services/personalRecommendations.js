const config = require('./recommendationConfig');

const tokenize = text => new Set(String(text || '').toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(word => word.length >= 4));
const intersection = (a, b) => [...a].filter(value => b.has(value));
const jaccard = (a, b) => (!a.size && !b.size ? 0 : intersection(a, b).length / new Set([...a, ...b]).size);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const roundScore = value => Math.round(clamp(value, 0, 100));

function decadeForYear(year) {
  return year > 0 ? Math.floor(year / 10) * 10 : null;
}

function normalizeCandidate(candidateInput) {
  if (candidateInput?.genres instanceof Set) return candidateInput;
  if (candidateInput?.data && !candidateInput.details) {
    return movie_data({ ...candidateInput, details: candidateInput.data });
  }
  return movie_data(candidateInput);
}

function calculate_vote_confidence(candidateInput) {
  const candidate = normalizeCandidate(candidateInput);
  const votes = Math.max(0, Number(candidate.vote_count) || 0);
  const reference = Math.max(1, Number(config.VOTE_CONFIDENCE_REFERENCE) || 20000);
  return roundScore(Math.log1p(votes) / Math.log1p(reference) * 100);
}

function has_imdb_rating(candidateInput) {
  const candidate = normalizeCandidate(candidateInput);
  const rating = candidate.imdb_rating == null ? NaN : Number(candidate.imdb_rating);
  const votes = candidate.imdb_votes == null ? NaN : Number(candidate.imdb_votes);
  return Number.isFinite(rating)
    && rating >= 0
    && rating <= 10
    && Number.isFinite(votes)
    && votes >= 0;
}

function calculate_imdb_vote_confidence(candidateInput) {
  const candidate = normalizeCandidate(candidateInput);
  if (!has_imdb_rating(candidate)) return 0;
  return roundScore(Math.min(Math.log10(Number(candidate.imdb_votes) + 1) / 6, 1) * 100);
}

function calculate_imdb_quality_score(candidateInput) {
  const candidate = normalizeCandidate(candidateInput);
  if (!has_imdb_rating(candidate)) return 0;
  const rating = clamp(Number(candidate.imdb_rating) / 10, 0, 1);
  return roundScore(rating * calculate_imdb_vote_confidence(candidate));
}

function imdb_confidence_level(votesInput) {
  const votes = Math.max(0, Number(votesInput) || 0);
  if (votes < 1000) return 'very_low';
  if (votes < 5000) return 'low';
  if (votes < 20000) return 'medium';
  if (votes < 100000) return 'good';
  return 'high';
}

function calculate_weighted_score(components, weights, availability = {}) {
  const positive = Object.entries(weights).filter(([, weight]) => Number(weight) > 0);
  const usable = positive.filter(([key]) => availability[key] !== false && Number.isFinite(Number(components[key])));
  const usableWeight = usable.reduce((sum, [, weight]) => sum + Number(weight), 0);
  const positiveScore = usableWeight > 0
    ? usable.reduce((sum, [key, weight]) => sum + Number(components[key]) * Number(weight), 0) / usableWeight
    : 0;
  const penalty = Object.entries(weights)
    .filter(([, weight]) => Number(weight) < 0)
    .reduce((sum, [key, weight]) => sum + (Number(components[key]) || 0) * Number(weight), 0);
  return roundScore(positiveScore + penalty);
}

function calculate_mainstream_score(candidateInput) {
  const candidate = normalizeCandidate(candidateInput);
  const popularity = Math.max(0, Number(candidate.popularity) || 0);
  const popularityReference = Math.max(1, Number(config.POPULARITY_REFERENCE) || 100);
  const popularityScore = roundScore(Math.log1p(popularity) / Math.log1p(popularityReference) * 100);
  const voteConfidence = calculate_vote_confidence(candidate);
  const imdbConfidence = calculate_imdb_vote_confidence(candidate);
  const hasImdb = has_imdb_rating(candidate);
  const weighted = popularityScore * 0.45 + voteConfidence * 0.30 + (hasImdb ? imdbConfidence * 0.25 : 0);
  const availableWeight = hasImdb ? 1 : 0.75;
  // Age is intentionally absent: an old, widely rated classic remains
  // mainstream. Both vote counts are logarithmic to limit domination.
  return roundScore(weighted / availableWeight);
}

function calculate_quality_score(candidateInput) {
  const candidate = normalizeCandidate(candidateInput);
  const ratingScore = roundScore((Number(candidate.vote_average) || 0) * 10);
  return roundScore(ratingScore * 0.70 + calculate_vote_confidence(candidate) * 0.30);
}

function build_era_preference(ratedMovies) {
  const highRated = ratedMovies.filter(movie => movie.rating >= 8 && movie.year > 0);
  const decadeWeights = new Map();
  let totalWeight = 0;
  for (const movie of highRated) {
    const decade = decadeForYear(movie.year);
    const weight = Math.max(1, Number(movie.rating) - 7);
    decadeWeights.set(decade, (decadeWeights.get(decade) || 0) + weight);
    totalWeight += weight;
  }
  const decadeShares = new Map([...decadeWeights].map(([decade, weight]) => [decade, totalWeight ? weight / totalWeight : 0]));
  const modernWeight = [...decadeWeights].filter(([decade]) => decade >= 2010).reduce((sum, [, weight]) => sum + weight, 0);
  const classicWeight = [...decadeWeights].filter(([decade]) => decade < 2000).reduce((sum, [, weight]) => sum + weight, 0);
  return {
    decadeShares,
    highRatedCount: highRated.length,
    modernShare: totalWeight ? modernWeight / totalWeight : 0,
    classicShare: totalWeight ? classicWeight / totalWeight : 0,
  };
}

function calculate_freshness_score(candidateInput, profile, context = {}) {
  const candidate = normalizeCandidate(candidateInput);
  const year = Number(candidate.year) || 0;
  if (!year) return 50;

  const currentYear = new Date().getUTCFullYear();
  if (context.prefer_recent) {
    return year >= currentYear - 4 ? 100 : year >= 2010 ? 75 : year >= 2000 ? 40 : 15;
  }
  if (context.prefer_classics) return year < 2000 ? 100 : year < 2010 ? 55 : 20;

  const era = profile?.era_preference;
  if (!era?.highRatedCount) return 50;

  const decade = decadeForYear(year);
  const share = era.decadeShares.get(decade) || 0;
  return share ? roundScore(50 + share * 150) : 50;
}

function candidate_thresholds(context = {}) {
  const hiddenGems = Boolean(context.prefer_hidden_gems);
  const classics = Boolean(context.prefer_classics);
  return {
    minimum_vote_count: hiddenGems ? 30 : classics ? 100 : Number(config.MIN_VOTE_COUNT) || 300,
    minimum_tmdb_rating: hiddenGems ? 5.5 : Number(config.MIN_TMDB_RATING) || 6,
    minimum_popularity: hiddenGems ? 0 : Number(config.MIN_POPULARITY) || 0,
  };
}

function candidate_passes_thresholds(candidateInput, context = {}) {
  const candidate = normalizeCandidate(candidateInput);
  const thresholds = candidate_thresholds(context);
  const votes = Number(candidate.vote_count) || 0;
  const rating = Number(candidate.vote_average) || 0;
  const popularity = Number(candidate.popularity) || 0;
  if (rating < thresholds.minimum_tmdb_rating) return false;
  if (context.prefer_hidden_gems) return votes >= thresholds.minimum_vote_count;
  const year = Number(candidate.year) || 0;
  const currentYear = new Date().getUTCFullYear();
  const gate = config.QUALITY_GATE;
  const isRecentSignal = year >= currentYear - gate.recentYears && popularity >= gate.recentMinPopularity && votes >= Math.min(100, thresholds.minimum_vote_count);
  const isClassicSignal = year > 0 && year < gate.classicBeforeYear
    && Number(candidate.imdb_votes || 0) >= gate.classicMinImdbVotes
    && Number(candidate.imdb_rating || 0) >= gate.classicMinImdbRating;
  const isEstablished = votes >= thresholds.minimum_vote_count
    && (!thresholds.minimum_popularity || popularity <= 0 || popularity >= thresholds.minimum_popularity);
  return isEstablished || isRecentSignal || isClassicSignal;
}

function movie_data(item) {
  const data = item.details || item;
  const credits = data.credits || {};
  const year = Number(String(data.release_date || data.first_air_date || '').slice(0, 4));
  const rawKeywords = (data.keywords && data.keywords.keywords) || [];
  const keywordIds = new Set(rawKeywords.map(k => String(k.id || k.name)));
  const keywordNames = new Map(rawKeywords.map(k => [String(k.id || k.name), k.name]));
  const rawImdbRating = item.imdb_rating ?? data.imdb_rating;
  const rawImdbVotes = item.imdb_votes ?? data.imdb_votes;
  return {
    movie_id: Number(item.tmdb_id || data.id), tmdb_id: Number(item.tmdb_id || data.id), media_type: item.media_type || 'movie',
    title: data.title || data.name || `TMDB #${item.tmdb_id || data.id}`,
    rating: item.rating == null ? null : Number(item.rating), raw: data,
    genres: new Set((data.genres || []).map(g => String(g.id || g.name))),
    genreNames: new Map((data.genres || []).map(g => [String(g.id || g.name), g.name])),
    keywords: keywordIds,
    keywordNames,
    directors: new Set((credits.crew || []).filter(p => p.job === 'Director').map(p => String(p.id || p.name))),
    directorNames: new Map((credits.crew || []).filter(p => p.job === 'Director').map(p => [String(p.id || p.name), p.name])),
    actors: new Set((credits.cast || []).slice(0, 10).map(p => String(p.id || p.name))),
    actorNames: new Map((credits.cast || []).slice(0, 10).map(p => [String(p.id || p.name), p.name])),
    countries: new Set((data.production_countries || []).map(c => c.iso_3166_1 || c.name)),
    languages: new Set(data.original_language ? [data.original_language] : []),
    eras: new Set(year ? [String(Math.floor(year / 10) * 10)] : []),
    overview: tokenize(data.overview),
    keywordTokens: new Set(rawKeywords.map(k => tokenize(k.name)).flatMap(s => [...s])),
    year,
    vote_average: Number(data.vote_average || 0), vote_count: Number(data.vote_count || 0), popularity: Number(data.popularity || 0), runtime: Number(data.runtime || 0),
    imdb_id: item.imdb_id || data.imdb_id || data.external_ids?.imdb_id || null,
    imdb_rating: rawImdbRating == null ? null : Number(rawImdbRating),
    imdb_votes: rawImdbVotes == null ? null : Number(rawImdbVotes),
  };
}

function build_user_profile(watched) {
  const rated = watched.map(movie_data).filter(movie => config.RATING_WEIGHTS[movie.rating] !== undefined);
  const features = ['genres', 'directors', 'actors', 'countries', 'languages', 'eras', 'overview', 'keywords'];
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
    for (const [key, value] of movie.keywordNames) names.keywords.set(key, value);
  }
  const normalized = {};
  for (const feature of features) normalized[feature] = new Map([...totals[feature]].map(([key, value]) => [key, totalWeight ? clamp(value / totalWeight, -1, 1) : 0]));
  return {
    ratedMovies: rated,
    features: normalized,
    names,
    totalWeight,
    era_preference: build_era_preference(rated),
    isSufficient: rated.length >= config.MIN_RATED_MOVIES && totalWeight > 0,
  };
}

function preference(profile, feature, values) {
  if (!values.size) return 0;
  return [...values].reduce((sum, value) => sum + (profile.features[feature].get(value) || 0), 0) / values.size;
}

function calculate_similarity(candidate, watchedMovie) {
  const candidateMovie = candidate.genres ? candidate : movie_data(candidate);
  const watched = watchedMovie.genres ? watchedMovie : movie_data(watchedMovie);
  const w = config.SIMILARITY_WEIGHTS;
  return (jaccard(candidateMovie.genres, watched.genres) * w.genres)
    + (jaccard(candidateMovie.directors, watched.directors) * w.directors)
    + (jaccard(candidateMovie.actors, watched.actors) * w.actors)
    + (jaccard(candidateMovie.overview, watched.overview) * w.overview)
    + (jaccard(candidateMovie.keywords, watched.keywords) * w.keywords)
    + (jaccard(candidateMovie.countries, watched.countries) * w.countries)
    + (jaccard(candidateMovie.languages, watched.languages) * w.languages)
    + (jaccard(candidateMovie.eras, watched.eras) * w.eras);
}

function calculate_movie_score(candidateInput, profile, context = {}) {
  const candidate = normalizeCandidate(candidateInput);
  const component = {
    genres: preference(profile, 'genres', candidate.genres), keywords: preference(profile, 'keywords', candidate.keywords),
    directors: preference(profile, 'directors', candidate.directors),
    overview: preference(profile, 'overview', candidate.overview), actors: preference(profile, 'actors', candidate.actors),
    countries: preference(profile, 'countries', candidate.countries), languages: preference(profile, 'languages', candidate.languages), eras: preference(profile, 'eras', candidate.eras),
  };
  const high = profile.ratedMovies.filter(movie => config.RATING_WEIGHTS[movie.rating] >= 3);
  const low = profile.ratedMovies.filter(movie => config.RATING_WEIGHTS[movie.rating] < 0);
  const avgSimilarity = movies => movies.length ? movies.reduce((sum, movie) => sum + calculate_similarity(candidate, movie), 0) / movies.length : 0;
  component.similarity = avgSimilarity(high) - avgSimilarity(low);
  component.quality = clamp(((candidate.vote_average - 5) / 5) * 0.7 + (calculate_vote_confidence(candidate) / 100) * 0.3, -1, 1);
  const fw = config.FEATURE_WEIGHTS;
  const weighted = component.genres * fw.genres + component.keywords * fw.keywords
    + component.directors * fw.directors + component.overview * fw.overview + component.actors * fw.actors
    + component.countries * fw.countries + component.languages * fw.languages + component.eras * fw.eras
    + component.similarity * 0.125 + component.quality * fw.quality;
  const personalMatch = roundScore(50 + weighted * 50);
  const highSimilarity = high.length ? avgSimilarity(high) : 0;
  const lowSimilarity = low.length ? avgSimilarity(low) : 0;
  component.personal_match = personalMatch;
  component.mainstream_score = calculate_mainstream_score(candidate);
  component.vote_confidence = calculate_vote_confidence(candidate);
  component.quality_score = calculate_quality_score(candidate);
  component.imdb_quality_score = calculate_imdb_quality_score(candidate);
  component.imdb_vote_confidence = calculate_imdb_vote_confidence(candidate);
  component.imdb_confidence_level = imdb_confidence_level(candidate.imdb_votes);
  component.freshness_score = calculate_freshness_score(candidate, profile, context);
  component.positive_similarity = roundScore(highSimilarity * 100);
  component.negative_similarity = roundScore(lowSimilarity * 100);

  const weights = { ...config.PERSONAL_RECOMMENDATION_WEIGHTS };
  if (context.prefer_hidden_gems) {
    weights.mainstream_score *= 0.20;
    weights.imdb_vote_confidence *= 0.10;
  }
  if (context.prefer_recent) weights.freshness_score = 0.10;
  let score = calculate_weighted_score(component, weights, {
    imdb_quality_score: has_imdb_rating(candidate),
    imdb_vote_confidence: has_imdb_rating(candidate),
  });
  if (context.feedbackSignals) {
    const feedback = require('./recommendationHistory').adjustmentFor(candidate, context.feedbackSignals);
    component.feedback_adjustment = feedback.adjustment;
    component.feedback_signals = feedback.signals;
    score = roundScore(clamp(score + feedback.adjustment, 0, 100));
  }
  return { score, components: component, candidate };
}

function matches_manual_preferences(candidate, preferences = {}) {
  const genrePreferences = preferences.genre_preferences || {};
  if ([...candidate.genres].some(id => genrePreferences[id] === 'dislike')) return false;
  if (preferences.min_year && candidate.year && candidate.year < preferences.min_year) return false;
  if (preferences.max_year && candidate.year && candidate.year > preferences.max_year) return false;
  if (preferences.min_rating && candidate.vote_average < preferences.min_rating) return false;
  if (preferences.min_vote_count && candidate.vote_count < preferences.min_vote_count) return false;
  if (preferences.runtime_min && candidate.runtime && candidate.runtime < preferences.runtime_min) return false;
  if (preferences.runtime_max && candidate.runtime && candidate.runtime > preferences.runtime_max) return false;
  if (preferences.include_classics === false && candidate.year && candidate.year < 2000) return false;
  return true;
}

function reason_for(candidate, profile) {
  const matches = profile.ratedMovies.filter(movie => config.RATING_WEIGHTS[movie.rating] >= 2)
    .map(movie => ({ movie, similarity: calculate_similarity(candidate, movie) })).filter(item => item.similarity > 0).sort((a, b) => b.similarity - a.similarity).slice(0, 3);
  const sharedGenres = new Set();
  const sharedKeywords = new Set();
  const sharedDirectors = new Set();
  const sharedActors = new Set();
  for (const item of matches) {
    for (const key of intersection(candidate.genres, item.movie.genres)) sharedGenres.add(candidate.genreNames.get(key) || key);
    for (const key of intersection(candidate.keywords, item.movie.keywords)) {
      const name = candidate.keywordNames.get(key) || profile.names?.keywords?.get(key) || key;
      sharedKeywords.add(name);
    }
    for (const key of intersection(candidate.directors, item.movie.directors)) sharedDirectors.add(candidate.directorNames.get(key) || key);
    for (const key of intersection(candidate.actors, item.movie.actors)) sharedActors.add(candidate.actorNames.get(key) || key);
  }
  const matched_movies = matches.map(({ movie }) => ({ movie_id: movie.movie_id, title: movie.title, rating: movie.rating }));
  const titles = matched_movies.map(movie => `«${movie.title}» (${movie.rating}/10)`).join(', ');
  const parts = [];
  if ([...sharedGenres].length) parts.push(`жанры: ${[...sharedGenres].slice(0, 3).join(', ')}`);
  if ([...sharedKeywords].length) parts.push(`тематика: ${[...sharedKeywords].slice(0, 3).join(', ')}`);
  if ([...sharedDirectors].length) parts.push(`режиссёр: ${[...sharedDirectors].slice(0, 2).join(', ')}`);
  if ([...sharedActors].length) parts.push(`актёры: ${[...sharedActors].slice(0, 2).join(', ')}`);
  return {
    matched_movies,
    structured_reasons: {
      genres: [...sharedGenres].slice(0, 3),
      similarTo: matched_movies,
      directors: [...sharedDirectors].slice(0, 2),
      actors: [...sharedActors].slice(0, 3),
      tasteSignals: matched_movies.length ? ['similar_to_high_rated'] : [],
    },
    reason: titles
      ? `Похож на ${titles}${parts.length ? `. Совпадают ${parts.join('; ')}.` : '.'}`
      : 'Соответствует вашему профилю вкуса по доступным данным TMDB.',
  };
}

function apply_diversity(scored, limit = config.RESULT_LIMIT, context = {}) {
  const selected = []; const genreCount = new Map(); const directors = new Set();
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const mainstreamMode = !context.prefer_hidden_gems && !context.prefer_classics;
  const mainstreamTarget = Math.ceil(limit * 0.60);
  const nicheCap = Math.max(1, Math.floor(limit * 0.20));
  let nicheCount = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    const item = sorted[index];
    const candidate = normalizeCandidate(item.candidate);
    const mainstreamScore = Number(item.components?.mainstream_score ?? candidate.mainstream_score);
    const isNiche = Number.isFinite(mainstreamScore) && mainstreamScore < config.MAINSTREAM_SCORE_MIN;
    const remainingMainstream = sorted.slice(index).filter(entry => {
      const normalized = normalizeCandidate(entry.candidate);
      const score = Number(entry.components?.mainstream_score ?? normalized.mainstream_score);
      return !Number.isFinite(score) || score >= config.MAINSTREAM_SCORE_MIN;
    }).length;
    if (mainstreamMode && isNiche && nicheCount >= nicheCap) continue;
    if (mainstreamMode && isNiche && selected.length < mainstreamTarget && remainingMainstream >= mainstreamTarget - selected.length) continue;

    const genres = [...(candidate.genres || [])]; const primaryGenre = genres[0]; const director = [...(candidate.directors || [])][0];
    const crowdedGenre = primaryGenre && (genreCount.get(primaryGenre) || 0) >= config.DIVERSITY.maxPerGenre;
    if ((crowdedGenre || (director && directors.has(director))) && selected.length >= Math.ceil(limit / 2)) continue;
    selected.push({ ...item, candidate });
    if (isNiche) nicheCount += 1;
    if (primaryGenre) genreCount.set(primaryGenre, (genreCount.get(primaryGenre) || 0) + 1);
    if (director) directors.add(director);
    if (selected.length >= limit) break;
  }
  return selected;
}

function generate_recommendations({ watched, candidates, limit = config.RESULT_LIMIT, context = {} }) {
  const profile = build_user_profile(watched);
  if (!profile.isSufficient) return { profile, recommendations: [] };
  const seen = new Set(watched.map(item => Number(item.tmdb_id || item.details?.id)));
  const scored = candidates.map(normalizeCandidate).filter(candidate => candidate.movie_id && candidate.genres.size && candidate_passes_thresholds(candidate, context) && matches_manual_preferences(candidate, context.preferences))
    .filter(candidate => !context.feedbackSignals?.blockedIds?.has(`${candidate.media_type}:${candidate.movie_id}`))
    .filter(candidate => !seen.has(candidate.movie_id) && seen.add(candidate.movie_id))
    .map(candidate => ({ ...calculate_movie_score(candidate, profile, context), ...reason_for(candidate, profile) }));
  const recommendations = apply_diversity(scored, limit, context).map(item => ({
    tmdb_id: item.candidate.movie_id,
    movie_id: item.candidate.movie_id,
    media_type: item.candidate.media_type || 'movie',
    title: item.candidate.title,
    imdb_id: item.candidate.imdb_id,
    imdb_rating: item.candidate.imdb_rating,
    imdb_votes: item.candidate.imdb_votes,
    score: item.score,
    reason: item.reason,
    matched_movies: item.matched_movies,
    structured_reasons: item.structured_reasons,
    score_components: item.components,
    ...(process.env.RECOMMENDATIONS_DEBUG === 'true' ? { score_components: item.components } : {}),
  }));
  if (process.env.RECOMMENDATIONS_DEBUG === 'true') {
    console.debug('[Recommendations] score breakdown:', JSON.stringify(recommendations.map(item => ({ movie_id: item.movie_id, final_score: item.score, components: item.score_components }))));
  }
  return { profile, recommendations };
}

module.exports = {
  movie_data,
  build_user_profile,
  calculate_similarity,
  calculate_movie_score,
  calculate_mainstream_score,
  calculate_vote_confidence,
  calculate_imdb_vote_confidence,
  calculate_imdb_quality_score,
  calculate_weighted_score,
  has_imdb_rating,
  imdb_confidence_level,
  calculate_quality_score,
  calculate_freshness_score,
  candidate_thresholds,
  candidate_passes_thresholds,
  apply_diversity,
  generate_recommendations,
  reason_for,
  matches_manual_preferences,
};
