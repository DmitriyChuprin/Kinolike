module.exports = {
  RATING_WEIGHTS: { 10: 5, 9: 4, 8: 3, 7: 2, 6: 1, 5: 0, 4: -1, 3: -2, 2: -3, 1: -4 },
  FEATURE_WEIGHTS: { genres: 0.25, directors: 0.15, overview: 0.15, actors: 0.10, countries: 0.025, languages: 0.015, eras: 0.01, quality: 0.05 },
  CANDIDATE_LIMIT: 60,
  RESULT_LIMIT: 20,
  MIN_RATED_MOVIES: 2,
  MIN_VOTE_COUNT: 20,
  DIVERSITY: { maxPerGenre: 3, maxPerDirector: 1, penalty: 12 },
};
