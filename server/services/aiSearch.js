/**
 * AI Search Service — модульный pipeline для поиска фильмов
 * по естественному языковому запросу пользователя.
 *
 * Architecture:
 *   parse_user_request → build_user_profile → search_candidates →
 *   calculate_personal_score → calculate_query_match → rank_candidates →
 *   apply_diversity → generate_recommendation_reason
 *
 * Fallback: если AI недоступен, используется жанровый поиск без LLM.
 */

const OpenAI = require('openai');
const db = require('../db/database');
const tmdbService = require('./tmdb');
const { build_user_profile, movie_data, calculate_movie_score, reason_for } = require('./personalRecommendations');
const config = require('./recommendationConfig');

// ─── AI Client ──────────────────────────────────────────────────────

let client = null;
let MODEL = 'gpt-4o';
let TIMEOUT = 30;

try {
  client = new OpenAI({
    apiKey: process.env.AI_API_KEY,
    baseURL: process.env.AI_BASE_URL || 'https://api.openai.com/v1',
  });
  MODEL = process.env.AI_MODEL || 'gpt-4o';
  TIMEOUT = parseInt(process.env.AI_TIMEOUT) || 30;
} catch (e) {
  console.warn('[AI Search] AI client init failed, will use fallback:', e.message);
}

// ─── Valid TMDB Genre IDs ───────────────────────────────────────────

const VALID_MOVIE_GENRES = new Set([28,12,16,35,80,99,18,10749,10751,14,36,27,10402,9648,878,53,10752,37]);
const VALID_TV_GENRES = new Set([10759,16,35,80,99,18,10751,10762,9648,10763,10764,10765,10766,10767,10768,37]);

// ─── JSON Schema Validation ─────────────────────────────────────────

function validateSearchParams(data) {
  if (!data || typeof data !== 'object') return false;

  // Normalize string fields to arrays before validation
  if (typeof data.similar_to === 'string') data.similar_to = [data.similar_to];

  const requiredArrays = ['genres', 'excluded_genres', 'keywords', 'excluded_keywords', 'mood', 'similar_to'];
  for (const field of requiredArrays) {
    if (data[field] !== undefined && !Array.isArray(data[field])) return false;
  }

  // Validate genre IDs exist in TMDB
  if (data.genres) {
    data.genres = data.genres.filter(g => {
      const id = parseInt(g);
      return !isNaN(id) && (VALID_MOVIE_GENRES.has(id) || VALID_TV_GENRES.has(id));
    });
  }
  if (data.excluded_genres) {
    data.excluded_genres = data.excluded_genres.filter(g => {
      const id = parseInt(g);
      return !isNaN(id) && (VALID_MOVIE_GENRES.has(id) || VALID_TV_GENRES.has(id));
    });
  }

  // Validate year_from/year_to
  if (data.year_from != null) data.year_from = parseInt(data.year_from) || null;
  if (data.year_to != null) data.year_to = parseInt(data.year_to) || null;
  if (data.year_from && data.year_to && data.year_from > data.year_to) {
    [data.year_from, data.year_to] = [data.year_to, data.year_from];
  }

  // Validate request_type
  if (data.request_type && !['recommendation', 'similar'].includes(data.request_type)) {
    data.request_type = 'recommendation';
  }

  // Validate similar_to
  if (typeof data.similar_to === 'string') data.similar_to = [data.similar_to];
  if (!Array.isArray(data.similar_to)) data.similar_to = [];

  // Validate country (2-letter ISO code)
  if (data.country && !/^[A-Z]{2}$/i.test(data.country)) data.country = null;

  // Validate language (2-letter ISO code)
  if (data.language && !/^[a-z]{2}$/i.test(data.language)) data.language = null;

  return true;
}

// ─── 1. Parse User Request ──────────────────────────────────────────

async function parse_user_request(query) {
  if (!client) {
    console.warn('[AI Search] AI unavailable, using fallback parsing');
    return fallback_parse(query);
  }

  const systemPrompt = `Ты — аналитик кино-поиска. Преобразуй естественный запрос пользователя в структурированные параметры поиска.

Верни ТОЛЬКО JSON объект (без markdown-обёрток):
{
  "genres": [/* TMDB genre ID как строки */],
  "excluded_genres": [/* ID жанров для исключения */],
  "keywords": [/* ключевые слова из запроса */],
  "excluded_keywords": [/* исключаемые ключевые слова */],
  "mood": [/* одно или несколько: light, fun, dark, tense, atmospheric, intellectual, emotional, action, romantic */],
  "similar_to": [/* название фильма/сериала если пользователь ищет похожее */],
  "year_from": null,
  "year_to": null,
  "runtime_min": null,
  "runtime_max": null,
  "language": null,
  "country": null,
  "sort_preference": "personal_match",
  "request_type": "recommendation"
}

request_type: "recommendation" (обычный запрос) или "similar" (похожее на что-то).

ID жанров фильмов TMDB:
28-Боевик, 12-Приключения, 16-Мультфильм, 35-Комедия, 80-Криминал, 99-Документальный, 18-Драма, 10751-Семейный, 14-Фэнтези, 36-Исторический, 27-Ужасы, 10402-Музыка, 9648-Детектив, 10749-Мелодрама, 878-Фантастика, 53-Триллер, 10752-Военный, 37-Вестерн

ID жанров сериалов TMDB:
10759-Боевик/Приключения, 16-Мультсериал, 35-Комедийный, 80-Криминальный, 99-Документальный, 18-Драматический, 10751-Семейный, 10762-Детский, 9648-Детективный, 10763-Новости, 10764-Реалити, 10765-Sci-Fi/Fantasy, 10766-Мыльная опера, 10767-Ток-шоу, 10768-Военный, 37-Вестерн

Правила:
- Если пользователь указал «фильм» — ищи только movie ID, если «сериал» — только tv ID
- Если тип не указан — используй movie ID (большинство запросов о фильмах)
- Если запрос содержит «похожее на [название]» — similar_to = [название], request_type = "similar"
- Не придумывай параметры, которых нет в запросе (оставляй null/пустой массив)
- year_from/year_to — только если пользователь явно указал год или период
- country — только если явно указал (RU, US, FR, JP и т.д.)
- language — только если явно указал язык
- Отвечай ТОЛЬКО валидным JSON`;

  const callLLM = async (temp) => {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: query },
      ],
      temperature: temp,
      max_tokens: 500,
      timeout: TIMEOUT * 1000,
    });
    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('AI не вернул контент');
    let cleaned = content.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    }
    return JSON.parse(cleaned);
  };

  try {
    const params = await callLLM(0.3);
    if (!validateSearchParams(params)) {
      console.warn('[AI Search] AI returned invalid params, retrying...');
      return await callLLM(0.1);
    }
    return params;
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.log('[AI Search] Invalid JSON from AI, retrying...');
      try { return await callLLM(0.1); } catch (_) { /* fall through */ }
    }
    console.error('[AI Search] AI parse failed, using fallback:', error.message);
    return fallback_parse(query);
  }
}

/**
 * Fallback parsing without AI — keyword-based genre matching
 */
function fallback_parse(query) {
  const q = query.toLowerCase();
  const result = {
    genres: [], excluded_genres: [], keywords: [], excluded_keywords: [],
    mood: [], similar_to: [], year_from: null, year_to: null,
    runtime_min: null, runtime_max: null, language: null, country: null,
    sort_preference: 'personal_match', request_type: 'recommendation',
  };

  // Genre keywords mapping (Russian)
  const genreMap = {
    'комеди': '35', 'боевик': '28', 'приключени': '12', 'мульт': '16',
    'криминал': '80', 'документал': '99', 'драм': '18', 'семейн': '10751',
    'фэнтези': '14', 'историческ': '36', 'ужас': '27', 'музык': '10402',
    'детектив': '9648', 'мелодрам': '10749', 'романтич': '10749',
    'фантастик': '878', 'триллер': '53', 'военн': '10752', 'вестерн': '37',
  };

  for (const [keyword, genreId] of Object.entries(genreMap)) {
    if (q.includes(keyword)) result.genres.push(genreId);
  }

  // Excluded genres
  if (q.includes('без ужас')) result.excluded_genres.push('27');
  if (q.includes('без драм')) result.excluded_genres.push('18');

  // Similar to
  const similarMatch = q.match(/похоже(?:е)?\s+на\s+(.+?)(?:\s*$)/i);
  if (similarMatch) {
    result.similar_to = [similarMatch[1].trim()];
    result.request_type = 'similar';
  }

  // Year extraction
  const yearMatch = q.match(/(\d{4})\s*(?:год|г\.|года)?/);
  if (yearMatch) {
    const year = parseInt(yearMatch[1]);
    if (year >= 1900 && year <= 2030) {
      result.year_from = year;
      result.year_to = year + 5;
    }
  }

  // Mood keywords
  if (q.includes('лёгк') || q.includes('легк')) result.mood.push('light');
  if (q.includes('напряжённ') || q.includes('напряженн')) result.mood.push('tense');
  if (q.includes('атмосферн')) result.mood.push('atmospheric');
  if (q.includes('умн') || q.includes('интеллектуальн')) result.mood.push('intellectual');
  if (q.includes('смешн') || q.includes('весёл')) result.mood.push('fun');
  if (q.includes('грустн') || q.includes('трогательн')) result.mood.push('emotional');

  return result;
}

// ─── 2. Build User Profile ──────────────────────────────────────────

async function build_user_profile_data(userId) {
  const [watched, rejected] = await Promise.all([
    db.query(
      `SELECT ul.*, mm.data as details
       FROM user_lists ul
       LEFT JOIN media_metadata mm ON mm.tmdb_id = ul.tmdb_id AND mm.media_type = ul.media_type
       WHERE ul.user_id = $1 AND ul.status = 'watched' AND ul.rating IS NOT NULL
       ORDER BY ul.watched_at DESC NULLS LAST`,
      [userId]
    ),
    db.query(
      `SELECT tmdb_id FROM user_lists WHERE user_id = $1 AND status = 'not_interested'`,
      [userId]
    ),
  ]);

  const watchedItems = watched.rows.filter(r => r.details);
  const ratedCount = watchedItems.length;
  const profile = build_user_profile(watchedItems);

  // Adaptive weights based on data availability
  let personalWeight = 0.25; // Default
  if (ratedCount < 5) personalWeight = 0.10;
  if (ratedCount < 3) personalWeight = 0.05;
  if (ratedCount >= 15) personalWeight = 0.30;
  if (ratedCount >= 30) personalWeight = 0.35;

  return {
    watchedItems,
    rejectedIds: new Set(rejected.rows.map(r => r.tmdb_id)),
    highRated: watchedItems.filter(r => r.rating >= 8).slice(0, 20),
    lowRated: watchedItems.filter(r => r.rating <= 4).slice(0, 10),
    profile,
    ratedCount,
    personalWeight,
    isSufficient: profile.isSufficient,
  };
}

// ─── 3. Search Candidates ───────────────────────────────────────────

function extractKeywordsFromData(data) {
  if (!data) return [];
  const kw = data.keywords?.keywords;
  if (!Array.isArray(kw)) return [];
  return kw.map(k => k.name || '').filter(Boolean);
}

async function search_candidates(userId, params) {
  const { genres, excluded_genres, year_from, year_to, language, country } = params;

  let query = `
    SELECT mm.tmdb_id, mm.media_type, mm.data, mm.release_year, mm.title, mm.poster_path, mm.overview,
           array_agg(DISTINCT g.id) FILTER (WHERE g.id IS NOT NULL) as genre_ids
    FROM media_metadata mm
    LEFT JOIN media_genres mg ON mg.media_metadata_id = mm.id
    LEFT JOIN genres g ON g.id = mg.genre_id
    WHERE mm.tmdb_id NOT IN (
      SELECT tmdb_id FROM user_lists WHERE user_id = $1
    )
  `;
  const queryParams = [userId];
  let paramIdx = 2;

  if (genres && genres.length > 0) {
    const genreInts = genres.map(g => parseInt(g)).filter(n => !isNaN(n));
    if (genreInts.length > 0) {
      query += ` AND g.id = ANY($${paramIdx}::int[])`;
      queryParams.push(genreInts);
      paramIdx++;
    }
  }

  if (excluded_genres && excluded_genres.length > 0) {
    const exInts = excluded_genres.map(g => parseInt(g)).filter(n => !isNaN(n));
    if (exInts.length > 0) {
      query += ` AND (g.id IS NULL OR NOT g.id = ANY($${paramIdx}::int[]))`;
      queryParams.push(exInts);
      paramIdx++;
    }
  }

  query += ` GROUP BY mm.id`;
  query += ` HAVING COUNT(DISTINCT g.id) > 0`;
  query += ` ORDER BY COALESCE(mm.data->>'vote_average', '0')::float DESC`;
  query += ` LIMIT 300`;

  const { rows } = await db.query(query, queryParams);

  return rows.filter(row => {
    const data = row.data || {};
    if (year_from && row.release_year < year_from) return false;
    if (year_to && row.release_year > year_to) return false;
    if (language) {
      const lang = (data.original_language || '').toLowerCase();
      if (lang !== language.toLowerCase()) return false;
    }
    return true;
  });
}

// ─── 4. Reference Movie Lookup ──────────────────────────────────────

async function findReferenceMovie(title) {
  const { rows } = await db.query(
    `SELECT mm.tmdb_id, mm.media_type, mm.title, mm.data
     FROM media_metadata mm
     WHERE mm.title ILIKE $1
     ORDER BY COALESCE(mm.data->>'popularity', '0')::float DESC
     LIMIT 1`,
    [`%${title}%`]
  );

  if (rows.length > 0) {
    console.log(`[AI Search] Reference in DB: "${rows[0].title}" (${rows[0].tmdb_id})`);
    const r = rows[0];
    return {
      tmdb_id: r.tmdb_id, media_type: r.media_type, title: r.title,
      genres: (r.data?.genres || []).map(g => g.id || g.name),
      keywords: (r.data?.keywords?.keywords || []).map(k => k.name),
    };
  }

  // Search TMDB
  console.log(`[AI Search] Reference not in DB, TMDB: "${title}"`);
  try {
    const searchResult = await tmdbService.search(title, 'multi', 1);
    const tmdbResults = searchResult?.results || [];
    if (tmdbResults.length === 0) return null;

    const ref = tmdbResults.find(r => r.media_type === 'movie') || tmdbResults[0];
    const refType = ref.media_type || 'movie';
    const details = refType === 'movie'
      ? await tmdbService.getMovieDetails(ref.id)
      : await tmdbService.getTvDetails(ref.id);

    if (!details) return null;

    const similarIds = (details.similar?.results || []).map(r => r.id);
    console.log(`[AI Search] Reference from TMDB: "${details.title || details.name}" (${ref.id})`);
    return {
      tmdb_id: ref.id, media_type: refType, title: details.title || details.name,
      genres: (details.genres || []).map(g => g.id),
      keywords: (details.keywords?.keywords || []).map(k => k.name),
      similarIds,
    };
  } catch (e) {
    console.error('[AI Search] TMDB search failed:', e.message);
    return null;
  }
}

// ─── 5. Scoring Functions ───────────────────────────────────────────

const W = config.AI_SEARCH_WEIGHTS;

function keywordRelevance(candidateKeywords, queryKeywords, excludedKeywords) {
  if (!queryKeywords || queryKeywords.length === 0) return 0;
  const candidateSet = new Set(candidateKeywords.map(k => k.toLowerCase()));
  const excludedSet = new Set((excludedKeywords || []).map(k => k.toLowerCase()));
  for (const kw of excludedSet) {
    for (const ck of candidateSet) {
      if (ck.includes(kw) || kw.includes(ck)) return -0.3;
    }
  }
  let matches = 0;
  for (const qk of queryKeywords) {
    const qkLower = qk.toLowerCase();
    for (const ck of candidateSet) {
      if (ck.includes(qkLower) || qkLower.includes(ck)) { matches++; break; }
    }
  }
  return matches / queryKeywords.length;
}

/** 0-100: how well the candidate matches the user's query */
function calculate_query_match(candidate, params, refMovie) {
  let score = 0;
  if (params.genres?.length) {
    const cGenres = new Set((candidate.data?.genres || []).map(g => String(g.id)));
    const overlap = params.genres.filter(g => cGenres.has(g)).length;
    score += (overlap / params.genres.length) * 40;
  }
  if (candidate.keywordOverlap) score += candidate.keywordOverlap * 20;
  if (refMovie) {
    const genreOverlap = (candidate.genre_ids || []).filter(g => refMovie.genres.includes(g)).length;
    score += Math.min(genreOverlap * 5, 15);
  }
  if (params.year_from && candidate.release_year && candidate.release_year >= params.year_from) score += 5;
  if (params.year_to && candidate.release_year && candidate.release_year <= params.year_to) score += 5;
  if (candidate._similarBoost) score += 15;
  return Math.min(100, Math.max(0, score));
}

/** 0-100: how well candidate matches user taste profile */
function calculate_personal_match(candidate, profile) {
  if (!profile?.isSufficient) return 0;
  const movie = build_movie_for_scoring(candidate);
  const { score } = calculate_movie_score(movie, profile);
  return score;
}

/** 0-100: similarity to high-rated movies (8-10) */
function calculate_positive_similarity(candidate, profile) {
  if (!profile?.isSufficient) return 0;
  const movie = build_movie_for_scoring(candidate);
  const highRated = profile.ratedMovies.filter(m => config.RATING_WEIGHTS[m.rating] >= 3);
  if (!highRated.length) return 0;
  const { calculate_similarity } = require('./personalRecommendations');
  const avg = highRated.reduce((sum, m) => sum + calculate_similarity(movie, m), 0) / highRated.length;
  return Math.round(Math.min(100, Math.max(0, avg * 200)));
}

/** 0-100: similarity to low-rated movies (1-4) — higher = worse */
function calculate_negative_similarity(candidate, profile) {
  if (!profile?.isSufficient) return 0;
  const movie = build_movie_for_scoring(candidate);
  const lowRated = profile.ratedMovies.filter(m => config.RATING_WEIGHTS[m.rating] < 0);
  if (!lowRated.length) return 0;
  const { calculate_similarity } = require('./personalRecommendations');
  const avg = lowRated.reduce((sum, m) => sum + calculate_similarity(movie, m), 0) / lowRated.length;
  return Math.round(Math.min(100, Math.max(0, avg * 200)));
}

/** 0-100: TMDB quality (rating + vote count) */
function calculate_quality_score(candidate) {
  const va = Number(candidate.data?.vote_average || 0);
  const vc = Number(candidate.data?.vote_count || 0);
  const ratingPart = Math.max(0, (va - 5) / 5) * 70;
  const countPart = Math.min(vc / 500, 1) * 30;
  return Math.round(Math.min(100, ratingPart + countPart));
}

function build_movie_for_scoring(candidate) {
  return {
    tmdb_id: candidate.tmdb_id, media_type: candidate.media_type,
    details: {
      ...candidate.data, genres: (candidate.data?.genres || []),
      title: candidate.title, poster_path: candidate.poster_path, overview: candidate.overview,
      release_date: candidate.data?.release_date || candidate.data?.first_air_date || null,
      keywords: { keywords: candidate.data?.keywords?.keywords || candidate.candidateKeywords?.map(k => ({ name: k })) || [] },
    },
  };
}

/** Adaptive personal weight based on how many movies user rated */
function getPersonalWeight(ratedCount) {
  const A = config.AI_SEARCH_ADAPTIVE;
  if (ratedCount >= 30) return A.personal_match_high;
  if (ratedCount >= 10) return A.personal_match_mid;
  if (ratedCount >= 3) return A.personal_match_low;
  return A.personal_match_min;
}

function rank_candidates(candidates, params, userProfile, refMovie) {
  const pw = getPersonalWeight(userProfile.ratedCount);
  const profile = userProfile.profile;

  return candidates.map(c => {
    const queryScore = calculate_query_match(c, params, refMovie);
    const personalScore = calculate_personal_match(c, profile);
    const posSim = calculate_positive_similarity(c, profile);
    const negSim = calculate_negative_similarity(c, profile);
    const qualScore = calculate_quality_score(c);

    const raw = queryScore * W.query_match + personalScore * pw + posSim * W.positive_similarity + negSim * W.negative_similarity + qualScore * W.quality_score;
    const finalScore = Math.round(Math.min(100, Math.max(0, raw)));

    return { candidate: c, score: finalScore, components: { queryScore, personalScore, posSim, negSim, qualScore } };
  }).sort((a, b) => b.score - a.score);
}

function apply_diversity(scored, limit = 20) {
  const selected = [];
  const genreCount = new Map();
  const directors = new Set();
  for (const item of scored) {
    const genres = [...(item.candidate.data?.genres || []).map(g => g.id)];
    const primaryGenre = genres[0];
    const crowded = primaryGenre && (genreCount.get(primaryGenre) || 0) >= config.DIVERSITY.maxPerGenre;
    const director = (item.candidate.data?.credits?.crew || []).find(c => c.job === 'Director')?.name;
    const dirCrowded = director && directors.has(director);
    if ((crowded || dirCrowded) && selected.length >= Math.ceil(limit / 2)) continue;
    selected.push(item);
    if (primaryGenre) genreCount.set(primaryGenre, (genreCount.get(primaryGenre) || 0) + 1);
    if (director) directors.add(director);
    if (selected.length >= limit) break;
  }
  return selected;
}

// ─── 5b. Progressive Constraint Relaxation ─────────────────────────

async function searchWithRelaxation(userId, params, refMovie) {
  let searchParams = { ...params };
  if (refMovie?.genres.length > 0) searchParams.genres = refMovie.genres.map(String);

  let candidates = await search_candidates(userId, searchParams);

  // TMDB similar IDs
  if (refMovie?.similarIds?.length > 0) {
    const excludeSet = new Set(candidates.map(c => c.tmdb_id));
    const ids = refMovie.similarIds.filter(id => !excludeSet.has(id) && id !== refMovie.tmdb_id);
    if (ids.length > 0) {
      const batch = ids.slice(0, 50);
      const { rows: sim } = await db.query(
        `SELECT mm.tmdb_id, mm.media_type, mm.data, mm.release_year, mm.title, mm.poster_path, mm.overview,
                array_agg(DISTINCT g.id) FILTER (WHERE g.id IS NOT NULL) as genre_ids
         FROM media_metadata mm LEFT JOIN media_genres mg ON mg.media_metadata_id = mm.id
         LEFT JOIN genres g ON g.id = mg.genre_id WHERE mm.tmdb_id = ANY($1::int[]) GROUP BY mm.id`, [batch]
      );
      const { rows: w } = await db.query('SELECT tmdb_id FROM user_lists WHERE user_id = $1', [userId]);
      const wSet = new Set(w.map(r => r.tmdb_id));
      candidates = [...candidates, ...sim.filter(c => !wSet.has(c.tmdb_id)).map(c => ({ ...c, _similarBoost: true }))];
    }
  }

  // Keyword filtering
  const kwSource = refMovie?.keywords?.length > 0 ? refMovie.keywords : params.keywords;
  const exKw = params.excluded_keywords || [];
  candidates = candidates.map(c => ({
    ...c,
    keywordOverlap: keywordRelevance(extractKeywordsFromData(c.data), kwSource, exKw),
    candidateKeywords: extractKeywordsFromData(c.data),
  }));
  if (refMovie?.keywords?.length > 0) {
    candidates = candidates.filter(c => c.keywordOverlap >= 0 || (c.genre_ids || []).some(g => refMovie.genres.includes(g)));
  }

  // Progressive relaxation: if <5 results, drop year filter
  if (candidates.length < 5 && (params.year_from || params.year_to)) {
    console.log(`[AI Search] Only ${candidates.length} results, relaxing year range...`);
    const relaxed = { ...searchParams, year_from: null, year_to: null };
    candidates = await search_candidates(userId, relaxed);
    candidates = candidates.map(c => ({
      ...c,
      keywordOverlap: keywordRelevance(extractKeywordsFromData(c.data), kwSource, exKw),
      candidateKeywords: extractKeywordsFromData(c.data),
    }));
  }

  return candidates;
}

// ─── 5c. AI Reranking ──────────────────────────────────────────────

async function llm_rerank(query, userProfile, candidates, refMovie) {
  if (!client || candidates.length === 0) return candidates;

  const topN = candidates.slice(0, config.AI_RERANK_TOP_N);
  const movieList = topN.map((item, i) => {
    const c = item.candidate || item;
    return `${i + 1}. «${c.title || 'Без названия'}» (${c.release_year || '?'}) — жанры: ${(c.data?.genres || []).map(g => g.name || g.id).join(', ')}, рейтинг: ${c.data?.vote_average || '?'}`;
  }).join('\n');
  const genreNames = userProfile.profile?.names?.genres;
  const genreList = genreNames instanceof Map
    ? [...genreNames.values()].slice(0, 5).join(', ')
    : 'неизвестны';
  const profileSummary = userProfile.isSufficient
    ? `Любимые жанры: ${genreList}`
    : 'Мало данных о предпочтениях';

  const systemPrompt = `Ты — куратор кино. Выбери ЛУЧШИЕ 10 фильмов из списка кандидатов для пользователя.

ПРАВИЛА:
- Ты МОЖЕШЬ выбирать ТОЛЬКО из переданного списка
- НЕ добавляй фильмы, которых нет в списке
- НЕ придумывай факты о фильмах
- Учитывай запрос пользователя и его вкусы
- Для каждого фильма дай КОРОТКУЮ причину (1-2 предложения) на русском
- Используй реальные факты: жанры, сходство с любимыми фильмами

Верни ТОЛЬКО JSON массив:
[{"index": 1, "reason": "Причина выбора"}]`;

  const userMsg = `Запрос: "${query}"
${refMovie ? `Фильм-оригинал: «${refMovie.title}»` : ''}
Профиль: ${profileSummary}

Кандидаты:
${movieList}`;

  try {
    const response = await client.chat.completions.create({
      model: MODEL, temperature: 0.3, max_tokens: 2000, timeout: TIMEOUT * 1000,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMsg }],
    });
    const content = response.choices[0]?.message?.content;
    if (!content) return topN;
    let cleaned = content.trim();
    if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    const selections = JSON.parse(cleaned);
    if (!Array.isArray(selections)) return topN;
    return selections
      .filter(s => s.index >= 1 && s.index <= topN.length)
      .map(s => {
      const orig = topN[s.index - 1];
      if (!orig || !orig.candidate) return null;
      const c = orig.candidate;
      return {
        tmdb_id: c.tmdb_id, media_type: c.media_type, title: c.title,
        poster_path: c.poster_path, overview: c.overview,
        vote_average: c.data?.vote_average || 0, release_year: c.release_year,
        score: orig.score, components: orig.components, llmReason: s.reason || '',
        data: c.data, genre_ids: c.genre_ids,
      };
    }).filter(Boolean);
  } catch (e) {
    console.error('[AI Search] LLM rerank failed:', e.message);
    return topN;
  }
}

// ─── 5d. Generate Explanation ───────────────────────────────────────

function generate_recommendation_reasons(scored, userProfile, refMovie) {
  const { profile } = userProfile;
  return scored.map((item) => {
    const c = item.candidate || item;  // Handle both wrapped and flat shapes
    const { score, components, llmReason } = item;
    const movieItem = build_movie_for_scoring(c);
    const movie = movie_data(movieItem);
    const { reason: baseReason, matched_movies } = profile.isSufficient
      ? reason_for(movie, profile) : { reason: '', matched_movies: [] };

    const parts = [];
    if (llmReason) parts.push(llmReason);
    else if (baseReason) parts.push(baseReason);
    if (components) {
      if (components.queryScore > 20) parts.push(`соответствует вашему запросу`);
      if (components.posSim > 30) parts.push(`похож на фильмы с высокими оценками`);
    }
    if (refMovie) parts.unshift(`Похоже на «${refMovie.title}»`);
    const reason = parts.filter(Boolean).join('. ') || 'Подобрано по вашим предпочтениям';

    return {
      tmdb_id: c.tmdb_id, media_type: c.media_type, title: c.title,
      poster_path: c.poster_path, overview: c.overview,
      vote_average: c.data?.vote_average || 0, release_year: c.release_year,
      score, reason, matched_movies,
    };
  });
}

// ─── Main Pipeline ──────────────────────────────────────────────────

async function searchWithAI(userId, query) {
  const t0 = Date.now();
  console.log(`[AI Search] Query: "${query}"`);

  const params = await parse_user_request(query);
  console.log(`[AI Search] Params:`, JSON.stringify(params));

  let refMovie = null;
  if (params.similar_to?.length > 0) {
    refMovie = await findReferenceMovie(params.similar_to[0]);
    if (refMovie) console.log(`[AI Search] Reference: "${refMovie.title}"`);
  }

  let candidates = await searchWithRelaxation(userId, params, refMovie);
  if (candidates.length === 0) {
    console.log(`[AI Search] No candidates (${Date.now() - t0}ms)`);
    return { query, recommendations: [], refMovie: refMovie?.title || null };
  }

  const userProfile = await build_user_profile_data(userId);
  const ranked = rank_candidates(candidates, params, userProfile, refMovie);
  const diverse = apply_diversity(ranked, config.AI_RERANK_TOP_N);
  const reranked = await llm_rerank(query, userProfile, diverse, refMovie);
  const results = generate_recommendation_reasons(reranked, userProfile, refMovie);

  console.log(`[AI Search] Found ${results.length} results (${Date.now() - t0}ms)`);
  return { query, recommendations: results, refMovie: refMovie?.title || null,
    profileInfo: { ratedCount: userProfile.ratedCount, isSufficient: userProfile.isSufficient } };
}

module.exports = {
  searchWithAI, parse_user_request, validateSearchParams,
  fallback_parse, keywordRelevance,
  build_user_profile_data, search_candidates, findReferenceMovie,
  calculate_query_match, calculate_personal_match, calculate_positive_similarity,
  calculate_negative_similarity, calculate_quality_score,
  rank_candidates, apply_diversity, generate_recommendation_reasons,
  getPersonalWeight, llm_rerank,
};
