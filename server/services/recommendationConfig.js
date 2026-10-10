module.exports = {
  RATING_WEIGHTS: { 10: 5, 9: 4, 8: 3, 7: 2, 6: 1, 5: 0, 4: -1, 3: -2, 2: -3, 1: -4 },
  FEATURE_WEIGHTS: { genres: 0.25, keywords: 0.25, directors: 0.15, overview: 0.15, actors: 0.10, countries: 0.025, languages: 0.015, eras: 0.01, quality: 0.05 },
  SIMILARITY_WEIGHTS: { genres: 0.30, directors: 0.15, actors: 0.10, overview: 0.15, keywords: 0.10, countries: 0.05, languages: 0.05, eras: 0.10 },
  KEYWORD_SIMILARITY_WEIGHT: 0.10,
  CANDIDATE_LIMIT: 60,
  RESULT_LIMIT: 20,
  MIN_RATED_MOVIES: 2,
  // Default quality floor. Query-specific requests may relax these values.
  MIN_VOTE_COUNT: 300,
  MIN_TMDB_RATING: 6.0,
  MIN_POPULARITY: 5,
  VOTE_CONFIDENCE_REFERENCE: 20000,
  POPULARITY_REFERENCE: 100,
  MAINSTREAM_SCORE_MIN: 60,
  HIDDEN_GEM_SCORE_MAX: 42,
  QUALITY_GATE: {
    recentYears: 3,
    recentMinPopularity: 12,
    classicBeforeYear: 2000,
    classicMinImdbVotes: 10000,
    classicMinImdbRating: 7,
    standardMinTmdbVotes: 300,
  },
  DIVERSITY: { maxPerGenre: 3, maxPerDirector: 1, penalty: 12 },

  // Scoring weights for the background/personal recommendation engine.
  PERSONAL_RECOMMENDATION_WEIGHTS: {
    personal_match: 0.45,
    mainstream_score: 0.10,
    positive_similarity: 0.10,
    vote_confidence: 0.05,
    quality_score: 0.05,
    imdb_quality_score: 0.15,
    imdb_vote_confidence: 0.10,
    freshness_score: 0.00,
    negative_similarity: -0.08,
  },

  // AI Search scoring weights (must sum to ~1.0)
  AI_SEARCH_WEIGHTS: {
    query_match: 0.30,
    personal_match: 0.30,
    mainstream_score: 0.08,
    positive_similarity: 0.07,
    vote_confidence: 0.04,
    quality_score: 0.06,
    imdb_quality_score: 0.10,
    imdb_vote_confidence: 0.05,
    freshness_score: 0.00,
    negative_similarity: -0.10,
  },
  // Cold start: keep recommendations practical until the user has enough history.
  AI_SEARCH_COLD_START_WEIGHTS: {
    query_match: 0.40,
    personal_match: 0.10,
    mainstream_score: 0.10,
    vote_confidence: 0.05,
    quality_score: 0.10,
    imdb_quality_score: 0.20,
    imdb_vote_confidence: 0.05,
    freshness_score: 0.00,
    positive_similarity: 0.00,
    negative_similarity: -0.05,
  },
  // Adaptive: reduce personal_match when user has few ratings
  AI_SEARCH_ADAPTIVE: {
    personal_match_high: 0.35,   // ≥30 rated
    personal_match_mid: 0.25,    // 10-29 rated
    personal_match_low: 0.10,    // 3-9 rated
    personal_match_min: 0.02,    // <3 rated
  },
  // Progressive constraint relaxation
  AI_RELAX_STEPS: [
    { relax: 'year_range', by: 3 },       // extend year range ±3
    { relax: 'vote_count', halve: true },  // lower popularity threshold
    { relax: 'genre_match', to: 1 },       // require only 1 genre match instead of all
  ],
  AI_RERANK_TOP_N: 8,    // bounded candidate list if optional LLM rerank is enabled
  AI_RERANK_FINAL_N: 10, // final results after LLM rerank
};
