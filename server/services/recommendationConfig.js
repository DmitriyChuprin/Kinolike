module.exports = {
  RATING_WEIGHTS: { 10: 5, 9: 4, 8: 3, 7: 2, 6: 1, 5: 0, 4: -1, 3: -2, 2: -3, 1: -4 },
  FEATURE_WEIGHTS: { genres: 0.25, keywords: 0.25, directors: 0.15, overview: 0.15, actors: 0.10, countries: 0.025, languages: 0.015, eras: 0.01, quality: 0.05 },
  SIMILARITY_WEIGHTS: { genres: 0.30, directors: 0.15, actors: 0.10, overview: 0.15, keywords: 0.10, countries: 0.05, languages: 0.05, eras: 0.10 },
  KEYWORD_SIMILARITY_WEIGHT: 0.10,
  CANDIDATE_LIMIT: 60,
  RESULT_LIMIT: 20,
  MIN_RATED_MOVIES: 2,
  MIN_VOTE_COUNT: 20,
  DIVERSITY: { maxPerGenre: 3, maxPerDirector: 1, penalty: 12 },

  // AI Search scoring weights (must sum to ~1.0)
  AI_SEARCH_WEIGHTS: {
    query_match: 0.40,
    personal_match: 0.30,
    positive_similarity: 0.15,
    negative_similarity: -0.10,
    quality_score: 0.05,
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
  AI_RERANK_TOP_N: 20,   // candidates sent to LLM for final selection
  AI_RERANK_FINAL_N: 10, // final results after LLM rerank
};
