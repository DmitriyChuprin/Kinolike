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
const {
  build_user_profile,
  movie_data,
  calculate_movie_score,
  calculate_mainstream_score,
  calculate_vote_confidence,
  calculate_imdb_vote_confidence,
  calculate_imdb_quality_score,
  calculate_weighted_score,
  has_imdb_rating,
  calculate_quality_score: calculate_personal_quality_score,
  calculate_freshness_score,
  candidate_thresholds,
  reason_for,
} = require('./personalRecommendations');
const config = require('./recommendationConfig');
const tasteProfileService = require('./tasteProfile');
const recommendationHistory = require('./recommendationHistory');

// ─── AI Client ──────────────────────────────────────────────────────

let client = null;
let MODEL = 'gpt-4o';
let TIMEOUT = 30;
const LLM_TIMEOUT_MS = Math.min(Math.max(parseInt(process.env.AI_SEARCH_LLM_TIMEOUT_MS) || 15000, 1000), 30000);
const AI_RERANK_ENABLED = process.env.AI_RERANK_ENABLED === 'true';

try {
  client = new OpenAI({
    apiKey: process.env.AI_API_KEY,
    baseURL: process.env.AI_BASE_URL || 'https://api.openai.com/v1',
    // A retry can make one browser request exceed the reverse-proxy budget.
    // The deterministic parser/ranker is the fast, safe fallback instead.
    maxRetries: 0,
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

  const requiredArrays = ['genres', 'excluded_genres', 'keywords', 'excluded_keywords', 'mood', 'similar_to'];
  for (const field of requiredArrays) {
    // LLMs often use null for an empty optional list. Treat it as an empty
    // array so a valid response does not trigger a second request.
    if (data[field] == null) data[field] = [];
    if (field === 'similar_to' && typeof data[field] === 'string') data[field] = [data[field]];
    if (!Array.isArray(data[field])) return false;
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

  if (data.media_type && !['movie', 'tv'].includes(data.media_type)) data.media_type = null;

  // Query context controls how strongly the mainstream/freshness bias applies.
  for (const field of ['prefer_mainstream', 'prefer_hidden_gems', 'prefer_classics', 'prefer_recent']) {
    if (data[field] !== undefined && typeof data[field] !== 'boolean') data[field] = Boolean(data[field]);
  }
  if (data.prefer_hidden_gems) data.prefer_mainstream = false;
  if (data.prefer_classics) data.prefer_recent = false;
  if (data.prefer_mainstream === undefined) data.prefer_mainstream = !data.prefer_hidden_gems;
  if (data.prefer_hidden_gems === undefined) data.prefer_hidden_gems = false;
  if (data.prefer_classics === undefined) data.prefer_classics = false;
  if (data.prefer_recent === undefined) data.prefer_recent = false;

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
  "media_type": null,
  "year_from": null,
  "year_to": null,
  "runtime_min": null,
  "runtime_max": null,
  "language": null,
  "country": null,
  "sort_preference": "personal_match",
  "request_type": "recommendation",
  "prefer_mainstream": true,
  "prefer_hidden_gems": false,
  "prefer_classics": false,
  "prefer_recent": false
}

request_type: "recommendation" (обычный запрос) или "similar" (похожее на что-то).

ID жанров фильмов TMDB:
28-Боевик, 12-Приключения, 16-Мультфильм, 35-Комедия, 80-Криминал, 99-Документальный, 18-Драма, 10751-Семейный, 14-Фэнтези, 36-Исторический, 27-Ужасы, 10402-Музыка, 9648-Детектив, 10749-Мелодрама, 878-Фантастика, 53-Триллер, 10752-Военный, 37-Вестерн

ID жанров сериалов TMDB:
10759-Боевик/Приключения, 16-Мультсериал, 35-Комедийный, 80-Криминальный, 99-Документальный, 18-Драматический, 10751-Семейный, 10762-Детский, 9648-Детективный, 10763-Новости, 10764-Реалити, 10765-Sci-Fi/Fantasy, 10766-Мыльная опера, 10767-Ток-шоу, 10768-Военный, 37-Вестерн

Правила:
- Если пользователь указал «фильм» — media_type = "movie", если «сериал» — media_type = "tv"
- Если тип не указан — используй movie ID (большинство запросов о фильмах)
- Если запрос содержит «похожее на [название]» — similar_to = [название], request_type = "similar"
- Не придумывай параметры, которых нет в запросе (оставляй null/пустой массив)
- year_from/year_to — только если пользователь явно указал год или период
- country — только если явно указал (RU, US, FR, JP и т.д.)
- language — только если явно указал язык
- По умолчанию prefer_mainstream = true для обычного вечернего просмотра
- «малоизвестный», «редкий», «нишевый», «скрытая жемчужина» → prefer_hidden_gems = true
- «классический», «старый фильм», конкретные 60-е/70-е/80-е/90-е → prefer_classics = true
- «новый», «современный», «последних лет» → prefer_recent = true
- «популярный», «известный», «для вечера» → prefer_mainstream = true
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
      timeout: LLM_TIMEOUT_MS,
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
    media_type: null,
    prefer_mainstream: true, prefer_hidden_gems: false, prefer_classics: false, prefer_recent: false,
    sort_preference: 'personal_match', request_type: 'recommendation',
  };

  result.prefer_hidden_gems = /(малоизвест|непопуляр|редк|нишев|скрыт(?:ая|ые)?\s+жемчужин|underrated|rare|hidden\s+gem)/i.test(q);
  result.prefer_classics = /(классичес|классик|стар(?:ый|ое|ые|ую|ого|ых)\b|\b(?:60|70|80|90)[ -]?х\b)/i.test(q);
  result.prefer_recent = /(нов(?:ый|ое|инки)|современн|последн(?:их|ие)\s+лет|свеж)/i.test(q);
  if (result.prefer_hidden_gems) result.prefer_mainstream = false;
  if (/\bсериал|мини[- ]?сериал|series|show\b/i.test(q)) result.media_type = 'tv';
  else if (/\bфильм|кино|movie\b/i.test(q)) result.media_type = 'movie';

  // Genre keywords mapping (Russian)
  const genreMap = {
    'комеди': '35', 'боевик': '28', 'приключени': '12', 'мульт': '16',
    'криминал': '80', 'документал': '99', 'драм': '18', 'семейн': '10751', 'семь': '10751',
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
  const decadeMatch = q.match(/(?:^|\s)(20|30|40|50|60|70|80|90)[ -]?х(?:\s|$|[,.!?])/i);
  if (decadeMatch) {
    const decade = Number(decadeMatch[1]) + (Number(decadeMatch[1]) < 30 ? 2000 : 1900);
    result.year_from = decade;
    result.year_to = decade + 9;
  }
  const lastYears = q.match(/последн(?:их|ие)\s+(\d{1,2})\s+лет/i);
  if (lastYears) {
    result.year_to = new Date().getUTCFullYear();
    result.year_from = result.year_to - Math.max(1, Number(lastYears[1])) + 1;
  }
  const wordYears = q.match(/последн(?:их|ие)\s+(тр[её]х|четыр[её]х|пяти|шести|семи|восьми|девяти|десяти)\s+лет/i);
  if (wordYears) {
    const years = { трех: 3, трёх: 3, четырех: 4, четырёх: 4, пяти: 5, шести: 6, семи: 7, восьми: 8, девяти: 9, десяти: 10 }[wordYears[1]];
    result.year_to = new Date().getUTCFullYear();
    result.year_from = result.year_to - years + 1;
  }

  const hoursMatch = q.match(/(?:примерно|около)?\s*(\d+(?:[.,]\d+)?)\s*(?:час|часа|часов)/i);
  if (hoursMatch) result.runtime_max = Math.round(Number(hoursMatch[1].replace(',', '.')) * 60 + 15);
  const wordHours = q.match(/(?:примерно|около|на)?\s*(полтора|два|три)\s*(?:час|часа|часов)/i);
  if (wordHours) result.runtime_max = Math.round(({ полтора: 1.5, два: 2, три: 3 }[wordHours[1]]) * 60 + 15);

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
      `SELECT ul.*, mm.data as details, mm.imdb_id, mm.imdb_rating, mm.imdb_votes
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

  const [preferences, feedbackSignals] = await Promise.all([
    tasteProfileService.getPreferences(userId).catch(() => ({})),
    recommendationHistory.getFeedbackSignals(userId).catch(() => ({})),
  ]);
  return {
    watchedItems,
    rejectedIds: new Set(rejected.rows.map(r => r.tmdb_id)),
    highRated: watchedItems.filter(r => r.rating >= 8).slice(0, 20),
    lowRated: watchedItems.filter(r => r.rating <= 4).slice(0, 10),
    profile,
    ratedCount,
    personalWeight,
    isSufficient: profile.isSufficient,
    preferences,
    feedbackSignals,
  };
}

// ─── 3. Search Candidates ───────────────────────────────────────────

function extractKeywordsFromData(data) {
  if (!data) return [];
  const kw = data.keywords?.keywords;
  if (!Array.isArray(kw)) return [];
  return kw.map(k => k.name || '').filter(Boolean);
}

function candidate_has_sufficient_data(row, params) {
  const data = row.data || {};
  const thresholds = candidate_thresholds(params);
  const votes = Number(data.vote_count ?? row.vote_count) || 0;
  const rating = Number(data.vote_average ?? row.vote_average) || 0;
  const popularity = Number(data.popularity ?? row.popularity) || 0;
  const minimumVotes = params.min_vote_count ?? thresholds.minimum_vote_count;
  const minimumRating = params.min_rating ?? thresholds.minimum_tmdb_rating;
  if (votes < minimumVotes || rating < minimumRating) return false;
  if (thresholds.minimum_popularity && popularity > 0 && popularity < thresholds.minimum_popularity) return false;

  // Standard recommendations need enough TMDB context to explain why a title
  // was selected. Explicit hidden-gem requests can use sparse metadata.
  const overview = String(data.overview || row.overview || '').trim();
  const keywords = extractKeywordsFromData(data);
  return params.prefer_hidden_gems || overview.length > 0 || keywords.length > 0;
}

async function search_candidates(userId, params) {
  const startedAt = Date.now();
  const { genres, excluded_genres, year_from, year_to, language } = params;
  const thresholds = candidate_thresholds(params);

  let query = `
    SELECT mm.tmdb_id, mm.media_type, mm.data, mm.release_year, mm.title, mm.poster_path, mm.overview,
           mm.imdb_id, mm.imdb_rating, mm.imdb_votes,
           array_agg(DISTINCT g.id) FILTER (WHERE g.id IS NOT NULL) as genre_ids
    FROM media_metadata mm
    LEFT JOIN media_genres mg ON mg.media_metadata_id = mm.id
    LEFT JOIN genres g ON g.id = mg.genre_id
    WHERE 1 = 1
  `;
  const queryParams = [userId];
  let paramIdx = 2;

  if (params.library_scope === 'watchlist') {
    query += ` AND EXISTS (
      SELECT 1 FROM user_lists ul
      WHERE ul.user_id = $1 AND ul.tmdb_id = mm.tmdb_id
        AND ul.media_type = mm.media_type AND ul.status = 'want_to_watch'
    )`;
  } else if (params.library_scope === 'exclude_watched') {
    query += ` AND NOT EXISTS (
      SELECT 1 FROM user_lists ul
      WHERE ul.user_id = $1 AND ul.tmdb_id = mm.tmdb_id
        AND ul.media_type = mm.media_type AND ul.status IN ('watched', 'not_interested')
    )`;
  } else if (params.library_scope === 'exclude_rejected') {
    query += ` AND NOT EXISTS (
      SELECT 1 FROM user_lists ul
      WHERE ul.user_id = $1 AND ul.tmdb_id = mm.tmdb_id
        AND ul.media_type = mm.media_type AND ul.status = 'not_interested'
    )`;
  } else {
    // Backward-compatible behaviour for the existing KinoLike UI.
    query += ` AND NOT EXISTS (
      SELECT 1 FROM user_lists ul
      WHERE ul.user_id = $1 AND ul.tmdb_id = mm.tmdb_id
        AND ul.media_type = mm.media_type
    )`;
  }

  if (params.media_type) {
    query += ` AND mm.media_type = $${paramIdx++}`;
    queryParams.push(params.media_type);
  }

  if (genres && genres.length > 0) {
    const genreInts = genres.map(g => parseInt(g)).filter(n => !isNaN(n));
    if (genreInts.length > 0) {
      query += ` AND EXISTS (
        SELECT 1 FROM media_genres required_genre
        WHERE required_genre.media_metadata_id = mm.id
          AND required_genre.genre_id = ANY($${paramIdx}::int[])
      )`;
      queryParams.push(genreInts);
      paramIdx++;
    }
  }

  if (excluded_genres && excluded_genres.length > 0) {
    const exInts = excluded_genres.map(g => parseInt(g)).filter(n => !isNaN(n));
    if (exInts.length > 0) {
      query += ` AND NOT EXISTS (
        SELECT 1 FROM media_genres excluded_genre
        WHERE excluded_genre.media_metadata_id = mm.id
          AND excluded_genre.genre_id = ANY($${paramIdx}::int[])
      )`;
      queryParams.push(exInts);
      paramIdx++;
    }
  }

  // Apply quality thresholds before ORDER BY/LIMIT. Previously the query
  // selected the 300 highest-rated rows first (often titles with very few
  // votes), and candidate_has_sufficient_data then discarded all of them.
  query += ` AND COALESCE(mm.data->>'vote_count', '0')::float >= $${paramIdx}`;
  queryParams.push(params.min_vote_count ?? thresholds.minimum_vote_count);
  paramIdx++;
  query += ` AND COALESCE(mm.data->>'vote_average', '0')::float >= $${paramIdx}`;
  queryParams.push(params.min_rating ?? thresholds.minimum_tmdb_rating);
  paramIdx++;
  if (thresholds.minimum_popularity) {
    query += ` AND (
      COALESCE(mm.data->>'popularity', '0')::float <= 0
      OR COALESCE(mm.data->>'popularity', '0')::float >= $${paramIdx}
    )`;
    queryParams.push(thresholds.minimum_popularity);
    paramIdx++;
  }

  query += ` GROUP BY mm.id`;
  query += ` HAVING COUNT(DISTINCT g.id) > 0`;
  query += ` ORDER BY COALESCE(mm.data->>'vote_average', '0')::float DESC`;
  // Ranking compares every candidate with the user's watched catalogue. The
  // configured bound is therefore part of the request latency contract; the
  // previous literal 300 silently bypassed CANDIDATE_LIMIT (60).
  query += ` LIMIT ${config.CANDIDATE_LIMIT}`;

  const { rows } = await db.query(query, queryParams);
  const filtered = rows.filter(row => candidate_has_sufficient_data(row, params)).filter(row => {
    const data = row.data || {};
    if (year_from && row.release_year < year_from) return false;
    if (year_to && row.release_year > year_to) return false;
    const runtime = Number(data.runtime || (Array.isArray(data.episode_run_time) ? data.episode_run_time[0] : 0)) || 0;
    if (params.runtime_min && runtime && runtime < params.runtime_min) return false;
    if (params.runtime_max && runtime && runtime > params.runtime_max) return false;
    if (params.mini_series_only && row.media_type === 'tv' && !/mini/i.test(String(data.type || ''))) return false;
    if (language) {
      const lang = (data.original_language || '').toLowerCase();
      if (lang !== language.toLowerCase()) return false;
    }
    return true;
  });
  console.log(`[Recommendations] candidates DB: ${Date.now() - startedAt}ms (${rows.length} rows, ${filtered.length} usable)`);
  return filtered;
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
  const { components } = calculate_movie_score(movie, profile);
  return Number(components.personal_match) || 0;
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
  return calculate_personal_quality_score(candidate);
}

function build_movie_for_scoring(candidate) {
  return {
    tmdb_id: candidate.tmdb_id, media_type: candidate.media_type,
    details: {
      ...candidate.data, genres: (candidate.data?.genres || []),
      title: candidate.title, poster_path: candidate.poster_path, overview: candidate.overview,
      imdb_id: candidate.imdb_id || candidate.data?.imdb_id || null,
      imdb_rating: candidate.imdb_rating ?? candidate.data?.imdb_rating ?? null,
      imdb_votes: candidate.imdb_votes ?? candidate.data?.imdb_votes ?? null,
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

function getRankingWeights(params, userProfile) {
  const source = userProfile.ratedCount < 3 ? config.AI_SEARCH_COLD_START_WEIGHTS : config.AI_SEARCH_WEIGHTS;
  const weights = { ...source };
  if (params.prefer_hidden_gems) {
    weights.mainstream_score *= 0.20;
    weights.vote_confidence *= 0.50;
    weights.imdb_vote_confidence *= 0.10;
    weights.freshness_score *= 0.25;
  }
  if (params.prefer_mainstream && !params.prefer_hidden_gems) {
    weights.mainstream_score += 0.10;
    weights.query_match -= 0.05;
    weights.personal_match -= 0.05;
  }
  if (params.prefer_classics) {
    weights.freshness_score = 0;
    weights.query_match += 0.03;
    weights.personal_match += 0.02;
  }
  if (params.prefer_recent) {
    weights.freshness_score += 0.10;
    weights.mainstream_score -= 0.05;
    weights.personal_match -= 0.05;
  }

  const positiveKeys = [
    'query_match', 'personal_match', 'mainstream_score', 'positive_similarity',
    'vote_confidence', 'quality_score', 'imdb_quality_score',
    'imdb_vote_confidence', 'freshness_score',
  ];
  const total = positiveKeys.reduce((sum, key) => sum + Math.max(0, Number(weights[key]) || 0), 0);
  if (total > 0) positiveKeys.forEach(key => { weights[key] = Math.max(0, Number(weights[key]) || 0) / total; });
  return weights;
}

function rank_candidates(candidates, params, userProfile, refMovie) {
  const profile = userProfile.profile;
  const weights = getRankingWeights(params, userProfile);

  return candidates.map(c => {
    const queryScore = calculate_query_match(c, params, refMovie);
    const personalScore = calculate_personal_match(c, profile);
    const posSim = calculate_positive_similarity(c, profile);
    const negSim = calculate_negative_similarity(c, profile);
    const mainstreamScore = calculate_mainstream_score(c);
    const voteConfidence = calculate_vote_confidence(c);
    const qualScore = calculate_quality_score(c);
    const imdbQualityScore = calculate_imdb_quality_score(c);
    const imdbVoteConfidence = calculate_imdb_vote_confidence(c);
    const freshnessScore = calculate_freshness_score(c, profile, params);

    const feedback = recommendationHistory.adjustmentFor(c, userProfile.feedbackSignals);
    const components = {
      query_match: queryScore,
      personal_match: personalScore,
      mainstream_score: mainstreamScore,
      positive_similarity: posSim,
      vote_confidence: voteConfidence,
      quality_score: qualScore,
      imdb_quality_score: imdbQualityScore,
      imdb_vote_confidence: imdbVoteConfidence,
      freshness_score: freshnessScore,
      negative_similarity: negSim,
      feedback_adjustment: feedback.adjustment,
    };
    const finalScore = Math.max(0, Math.min(100, calculate_weighted_score(components, weights, {
      imdb_quality_score: has_imdb_rating(c),
      imdb_vote_confidence: has_imdb_rating(c),
    }) + feedback.adjustment));
    if (process.env.RECOMMENDATIONS_DEBUG === 'true') {
      console.debug('[AI Search] score:', JSON.stringify({ movie_id: c.tmdb_id, final_score: finalScore, components }));
    }
    return { candidate: c, score: finalScore, components, feedbackSignals: feedback.signals };
  }).sort((a, b) => b.score - a.score);
}

function apply_diversity(scored, limit = 20, context = {}) {
  const selected = [];
  const genreCount = new Map();
  const directors = new Set();
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const mainstreamMode = !context.prefer_hidden_gems;
  const mainstreamTarget = Math.ceil(limit * 0.60);
  const nicheCap = Math.max(1, Math.floor(limit * 0.20));
  let nicheCount = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    const item = sorted[index];
    const candidate = item.candidate || item;
    const mainstreamScore = Number(item.components?.mainstream_score ?? calculate_mainstream_score(candidate));
    const hasMainstreamData = Boolean(candidate.data && (candidate.data.vote_count != null || candidate.data.popularity != null || candidate.data.vote_average != null));
    const isNiche = hasMainstreamData && mainstreamScore < config.MAINSTREAM_SCORE_MIN;
    const remainingMainstream = sorted.slice(index).filter(entry => {
      const entryCandidate = entry.candidate || entry;
      const score = Number(entry.components?.mainstream_score ?? calculate_mainstream_score(entryCandidate));
      const hasData = Boolean(entryCandidate.data && (entryCandidate.data.vote_count != null || entryCandidate.data.popularity != null || entryCandidate.data.vote_average != null));
      return !hasData || score >= config.MAINSTREAM_SCORE_MIN;
    }).length;
    if (mainstreamMode && isNiche && nicheCount >= nicheCap) continue;
    if (mainstreamMode && isNiche && selected.length < mainstreamTarget && remainingMainstream >= mainstreamTarget - selected.length) continue;
    const genres = [...(candidate.data?.genres || []).map(g => g.id)];
    const primaryGenre = genres[0];
    const crowded = primaryGenre && (genreCount.get(primaryGenre) || 0) >= config.DIVERSITY.maxPerGenre;
    const director = (candidate.data?.credits?.crew || []).find(c => c.job === 'Director')?.name;
    const dirCrowded = director && directors.has(director);
    if ((crowded || dirCrowded) && selected.length >= Math.ceil(limit / 2)) continue;
    selected.push(item);
    if (isNiche) nicheCount += 1;
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
                mm.imdb_id, mm.imdb_rating, mm.imdb_votes,
                array_agg(DISTINCT g.id) FILTER (WHERE g.id IS NOT NULL) as genre_ids
         FROM media_metadata mm LEFT JOIN media_genres mg ON mg.media_metadata_id = mm.id
         LEFT JOIN genres g ON g.id = mg.genre_id WHERE mm.tmdb_id = ANY($1::int[]) GROUP BY mm.id`, [batch]
      );
      const { rows: w } = await db.query('SELECT tmdb_id, media_type, status FROM user_lists WHERE user_id = $1', [userId]);
      const blocked = new Set(w.filter(r => params.library_scope === 'watchlist'
        ? r.status !== 'want_to_watch'
        : params.library_scope === 'exclude_watched'
          ? ['watched', 'not_interested'].includes(r.status)
          : params.library_scope === 'exclude_rejected'
            ? r.status === 'not_interested'
            : true).map(r => `${r.media_type}:${r.tmdb_id}`));
      candidates = [...candidates, ...sim
        .filter(c => !blocked.has(`${c.media_type}:${c.tmdb_id}`) && candidate_has_sufficient_data(c, params))
        .map(c => ({ ...c, _similarBoost: true }))];
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
  if (!params.strict_filters && candidates.length < 5 && (params.year_from || params.year_to)) {
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

async function llm_rerank(query, userProfile, candidates, refMovie, queryContext = {}) {
  if (!client || candidates.length === 0) return candidates;

  const topN = candidates.slice(0, config.AI_RERANK_TOP_N);
  const movieList = topN.map((item, i) => {
    const c = item.candidate || item;
    const components = item.components || {};
    const year = c.release_year || c.data?.release_date?.slice(0, 4) || c.data?.first_air_date?.slice(0, 4) || '?';
    return `${i + 1}. «${c.title || 'Без названия'}» (${year}) — жанры: ${(c.data?.genres || []).map(g => g.name || g.id).join(', ')}, TMDB: ${c.data?.vote_average || '?'} (${c.data?.vote_count || 0}), IMDb: ${c.imdb_rating ?? c.data?.imdb_rating ?? '?'} (${c.imdb_votes ?? c.data?.imdb_votes ?? 0}), популярность: ${c.data?.popularity || 0}, mainstream: ${components.mainstream_score ?? '?'}`;
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
- По умолчанию не считай редкость или малоизвестность преимуществом
- В стандартном запросе отдавай предпочтение достаточно известным фильмам с надёжным количеством оценок
- Не штрафуй фильм только за возраст: признанная классика с большим числом голосов допустима
- Нишевые, экспериментальные и малоизвестные фильмы выбирай при явном запросе, соответствующем профиле или исключительно сильном совпадении
- Учитывай TMDB/IMDb rating, голоса и mainstream как сигналы надёжности, а не как замену вкусовому совпадению
- Для каждого фильма дай КОРОТКУЮ причину (1-2 предложения) на русском
- Используй реальные факты: жанры, сходство с любимыми фильмами

Верни ТОЛЬКО JSON массив:
[{"index": 1, "reason": "Причина выбора"}]`;

  const userMsg = `Запрос: "${query}"
${refMovie ? `Фильм-оригинал: «${refMovie.title}»` : ''}
Профиль: ${profileSummary}
Контекст запроса: mainstream=${Boolean(queryContext.prefer_mainstream)}, hidden_gems=${Boolean(queryContext.prefer_hidden_gems)}, classics=${Boolean(queryContext.prefer_classics)}, recent=${Boolean(queryContext.prefer_recent)}

Кандидаты:
${movieList}`;

  try {
    const response = await client.chat.completions.create({
      model: MODEL, temperature: 0.3, max_tokens: 600, timeout: LLM_TIMEOUT_MS,
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
        imdb_id: c.imdb_id || c.data?.imdb_id || null,
        imdb_rating: c.imdb_rating ?? c.data?.imdb_rating ?? null,
        imdb_votes: c.imdb_votes ?? c.data?.imdb_votes ?? null,
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
    const { score, components } = item;
    const movieItem = build_movie_for_scoring(c);
    const movie = movie_data(movieItem);
    const grounded = profile.isSufficient
      ? reason_for(movie, profile) : { reason: '', matched_movies: [], structured_reasons: { genres: [], similarTo: [], directors: [], actors: [], tasteSignals: [] } };
    const { reason: baseReason, matched_movies } = grounded;

    const parts = [];
    if (baseReason) parts.push(baseReason);
    if (components) {
      if (components.query_match > 20) parts.push(`соответствует вашему запросу`);
      if (components.positive_similarity > 30) parts.push(`похож на фильмы с высокими оценками`);
    }
    if (refMovie) parts.unshift(`Похоже на «${refMovie.title}»`);
    const reason = parts.filter(Boolean).join('. ') || 'Подобрано по вашим предпочтениям';

    const genres = grounded.structured_reasons.genres || [];
    const directors = grounded.structured_reasons.directors || [];
    const actors = grounded.structured_reasons.actors || [];
    const tasteSignals = [];
    if (components?.query_match > 20) tasteSignals.push('matches_request');
    if (components?.positive_similarity > 30) tasteSignals.push('similar_to_high_rated');
    if (components?.quality_score > 65) tasteSignals.push('reliable_quality');
    if (components?.mainstream_score > config.MAINSTREAM_SCORE_MIN) tasteSignals.push('established_popularity');
    return {
      tmdb_id: c.tmdb_id, media_type: c.media_type, title: c.title,
      poster_path: c.poster_path, overview: c.overview,
      vote_average: c.data?.vote_average || 0, release_year: c.release_year,
      imdb_id: c.imdb_id || c.data?.imdb_id || null,
      imdb_rating: c.imdb_rating ?? c.data?.imdb_rating ?? null,
      imdb_votes: c.imdb_votes ?? c.data?.imdb_votes ?? null,
      score, reason, matched_movies,
      structured_reasons: { genres, similarTo: matched_movies, directors, actors, tasteSignals },
      score_components: components || {},
    };
  });
}

// ─── Main Pipeline ──────────────────────────────────────────────────

async function searchWithAI(userId, query, options = {}) {
  const t0 = Date.now();
  const elapsed = () => Date.now() - t0;
  console.log(`[AI Search] Query: "${query}"`);

  console.log('[Recommendations] LLM parse start');
  const parsedParams = await parse_user_request(query);
  console.log(`[Recommendations] LLM parse end: ${elapsed()}ms`);
  const explicitFilters = Object.fromEntries(Object.entries(options.filters || {}).filter(([, value]) => (
    value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0)
  )));
  const params = { ...parsedParams, ...explicitFilters };
  validateSearchParams(params);
  console.log(`[AI Search] Params:`, JSON.stringify(params));

  let refMovie = null;
  if (params.similar_to?.length > 0) {
    refMovie = await findReferenceMovie(params.similar_to[0]);
    if (refMovie) console.log(`[AI Search] Reference: "${refMovie.title}"`);
  }
  console.log(`[Recommendations] reference: ${elapsed()}ms`);

  // These database reads are independent once the optional reference lookup
  // has completed, so do not serialize them on the request critical path.
  const candidatesPromise = searchWithRelaxation(userId, params, refMovie);
  const profilePromise = build_user_profile_data(userId);
  let candidates = await candidatesPromise;
  console.log(`[Recommendations] candidates: ${elapsed()}ms (${candidates.length})`);
  if (candidates.length === 0) {
    console.log(`[Recommendations] total: ${elapsed()}ms (no candidates)`);
    return { query, recommendations: [], refMovie: refMovie?.title || null };
  }

  const userProfile = await profilePromise;
  console.log(`[Recommendations] profile: ${elapsed()}ms (${userProfile.ratedCount} rated)`);
  const prefs = userProfile.preferences || {};
  const manualGenres = prefs.genre_preferences || {};
  candidates = candidates.filter(candidate => {
    const data = candidate.data || {};
    const year = Number(candidate.release_year) || Number(String(data.release_date || data.first_air_date || '').slice(0, 4));
    const runtime = Number(data.runtime) || 0;
    const genres = (data.genres || []).map(g => String(g.id));
    if (options.exclude?.has(`${candidate.media_type}:${candidate.tmdb_id}`)) return false;
    if (genres.some(id => manualGenres[id] === 'dislike')) return false;
    if (prefs.min_year && year && year < prefs.min_year) return false;
    if (prefs.max_year && year && year > prefs.max_year) return false;
    if (prefs.min_rating && Number(data.vote_average || 0) < prefs.min_rating) return false;
    if (prefs.min_vote_count && Number(data.vote_count || 0) < prefs.min_vote_count) return false;
    if (prefs.runtime_min && runtime && runtime < prefs.runtime_min) return false;
    if (prefs.runtime_max && runtime && runtime > prefs.runtime_max) return false;
    if (prefs.include_unknown === false && Number(data.vote_count || 0) < config.MIN_VOTE_COUNT) return false;
    if (prefs.include_classics === false && year && year < 2000) return false;
    return true;
  });
  const ranked = rank_candidates(candidates, params, userProfile, refMovie);
  const diverse = apply_diversity(ranked, config.AI_RERANK_TOP_N, params);
  // Rerank used to be a second sequential LLM request (20 candidates,
  // max_tokens=2000). Its generated explanation was not returned to clients,
  // only the order was used. Keep it available for explicit experiments, but
  // use the deterministic ranking in the latency-sensitive API by default.
  let reranked = diverse;
  if (AI_RERANK_ENABLED) {
    console.log('[Recommendations] LLM rerank start');
    reranked = await llm_rerank(query, userProfile, diverse, refMovie, params);
    console.log(`[Recommendations] LLM rerank end: ${elapsed()}ms`);
  } else {
    console.log('[Recommendations] LLM rerank skipped (AI_RERANK_ENABLED is not true)');
  }
  const llmItems = reranked.map(item => item.candidate ? item : {
    candidate: item,
    score: item.score,
    components: item.components,
    llmReason: item.llmReason,
  });
  const selectedIds = new Set(llmItems.map(item => `${item.candidate.tmdb_id}:${item.candidate.media_type}`));
  const fallbackItems = ranked
    .filter(item => !selectedIds.has(`${item.candidate.tmdb_id}:${item.candidate.media_type}`))
    .slice(0, config.AI_RERANK_TOP_N);
  const finalPool = apply_diversity([...llmItems, ...fallbackItems], config.AI_RERANK_FINAL_N, params);
  const results = generate_recommendation_reasons(finalPool, userProfile, refMovie).slice(0, options.limit || config.AI_RERANK_FINAL_N);

  console.log(`[Recommendations] total: ${elapsed()}ms (${results.length} results)`);
  return { query, recommendations: results, refMovie: refMovie?.title || null,
    profileInfo: { ratedCount: userProfile.ratedCount, isSufficient: userProfile.isSufficient } };
}

module.exports = {
  searchWithAI, parse_user_request, validateSearchParams,
  fallback_parse, keywordRelevance,
  build_user_profile_data, search_candidates, findReferenceMovie,
  calculate_query_match, calculate_personal_match, calculate_positive_similarity,
  calculate_negative_similarity, calculate_quality_score, calculate_mainstream_score,
  calculate_vote_confidence, calculate_imdb_vote_confidence, calculate_imdb_quality_score,
  calculate_freshness_score,
  rank_candidates, apply_diversity, generate_recommendation_reasons,
  getPersonalWeight, getRankingWeights, llm_rerank,
};
