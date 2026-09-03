const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: process.env.AI_API_KEY,
  baseURL: process.env.AI_BASE_URL || 'https://api.openai.com/v1',
});

const MODEL = process.env.AI_MODEL || 'gpt-4o';
const TEMPERATURE = parseFloat(process.env.AI_TEMPERATURE) || 0.7;
const MAX_TOKENS = parseInt(process.env.AI_MAX_TOKENS) || 2000;
const TIMEOUT = parseInt(process.env.AI_TIMEOUT) || 30;
const RECOMMENDATIONS_LIMIT = parseInt(process.env.AI_RECOMMENDATIONS_LIMIT) || 20;

/**
 * AI анализирует просмотренные фильмы и возвращает параметры для TMDB Discover API
 * Вместо того чтобы AI рекомендовал фильмы (галлюцинации), он только анализирует паттерны
 */
async function analyzePreferences(watchedItems, customQuery = null) {
  if (!watchedItems || watchedItems.length === 0) {
    throw new Error('Нет просмотренных фильмов для анализа');
  }

  // Формируем список просмотренных для промпта
  const watchedList = watchedItems.map((item, i) => {
    const rating = item.rating ? `, оценка: ${item.rating}/10` : '';
    const genres = item.genres ? ` | Жанры: ${item.genres}` : '';
    const year = item.year ? ` (${item.year})` : '';
    return `${i + 1}. ${item.title}${year} — ${item.media_type === 'movie' ? 'Фильм' : 'Сериал'}${rating}${genres}`;
  }).join('\n');

  const queryPart = customQuery 
    ? `\n\nДополнительный запрос пользователя: "${customQuery}"\nУчти это при анализе предпочтений.`
    : '';

  const systemPrompt = `Ты — аналитик кино-предпочтений. Проанализируй список просмотренных фильмов и сериалов пользователя с их оценками и верни параметры для поиска рекомендаций через TMDB Discover API.

Формат ответа — JSON объект:
{
  "movie_params": {
    "with_genres": "28,12,878",
    "without_genres": "27,10749",
    "vote_average.gte": 6.5,
    "sort_by": "popularity.desc",
    "primary_release_date.gte": "2018-01-01",
    "with_original_language": "en|ru"
  },
  "tv_params": {
    "with_genres": "18,80",
    "without_genres": "10767",
    "vote_average.gte": 7.0,
    "sort_by": "popularity.desc",
    "first_air_date.gte": "2018-01-01"
  },
  "analysis": "Краткий анализ предпочтений пользователя (2-3 предложения на русском)"
}

Правила:
- with_genres: ID жанров которые пользователь любит (оценки 7+). Через запятую.
- without_genres: ID жанров которые пользователь не любит (оценки 5 и ниже). Через запятую.
- vote_average.gte: минимальный рейтинг TMDB. Ставь 6.5-7.5 если пользователь смотрит качественное кино.
- sort_by: popularity.desc или vote_average.desc
- primary_release_date.gte / first_air_date.gte: если пользователь смотрит современное кино — ставь 5-7 лет назад. Если классическое — не ставь ограничение.
- with_original_language: если пользователь смотрит только русское или только английское — укажи. Иначе не ставь.
- Если данных мало для выводов — ставь умеренные параметры.
- Отвечай ТОЛЬКО JSON-объектом, без дополнительного текста

ID жанров фильмов:
28-Боевик, 12-Приключения, 16-Анимация, 35-Комедия, 80-Криминал, 99-Документальный, 18-Драма, 10751-Семейный, 14-Фэнтези, 36-Исторический, 27-Ужасы, 10402-Музыка, 9648-Детектив, 10749-Мелодрама, 878-Фантастика, 10770-ТВ-фильм, 53-Триллер, 10752-Военный, 37-Вестерн

ID жанров сериалов:
10759-Боевик/Приключения, 16-Анимация, 35-Комедия, 80-Криминал, 99-Документальный, 18-Драма, 10751-Семейный, 10762-Дети, 9648-Детектив, 10763-Новости, 10764-Реалити, 10765-Sci-Fi/Fantasy, 10766-Мыльная опера, 37-Вестерн, 10767-Ток-шоу, 10768-Военный, 37-Вестерн`;

  const userPrompt = `Пользователь посмотрел следующие фильмы/сериалы (с оценками от 1 до 10):
${watchedList}
${queryPart}

Проанализируй предпочтения и верни параметры для TMDB Discover API.`;

  try {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: TEMPERATURE,
      max_tokens: MAX_TOKENS,
      timeout: TIMEOUT * 1000,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      console.error('AI вернул пустой ответ:', JSON.stringify(response.choices[0]));
      throw new Error('AI не вернул контент');
    }
    
    // Парсим JSON, убираем markdown обёртку если есть
    let cleaned = content.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    }
    
    const preferences = JSON.parse(cleaned);
    
    if (!preferences.movie_params && !preferences.tv_params) {
      throw new Error('AI не вернул параметры для Discover API');
    }
    
    return preferences;
  } catch (error) {
    if (error instanceof SyntaxError) {
      // Невалидный JSON — пробуем ещё раз (одна попытка)
      console.log('Невалидный JSON от AI, повторная попытка...');
      const retry = await client.chat.completions.create({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS,
        timeout: TIMEOUT * 1000,
      });
      
      const retryContent = retry.choices[0]?.message?.content;
      if (!retryContent) throw new Error('AI не вернул контент при повторе');
      let retryCleaned = retryContent.trim();
      if (retryCleaned.startsWith('```')) {
        retryCleaned = retryCleaned.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
      }
      return JSON.parse(retryCleaned);
    }
    throw error;
  }
}

/**
 * Генерирует текстовую причину рекомендации на основе анализа
 */
async function generateReason(itemTitle, itemType, analysis, userQuery = null) {
  const queryPart = userQuery ? `\nПользователь также запросил: "${userQuery}"` : '';
  
  try {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: 'Ты — кинорекомендатель. Напиши короткую причину рекомендации (1-2 предложения на русском). Отвечай только текстом причины, без дополнительного форматирования.' },
        { role: 'user', content: `Анализ предпочтений пользователя: ${analysis}\n${queryPart}\n\nПочему пользователю может понравиться "${itemTitle}" (${itemType === 'movie' ? 'фильм' : 'сериал'})?` },
      ],
      temperature: 0.8,
      max_tokens: 150,
      timeout: 10000,
    });
    
    return response.choices[0]?.message?.content?.trim() || 'Рекомендовано на основе ваших предпочтений';
  } catch (err) {
    return 'Рекомендовано на основе ваших предпочтений';
  }
}

module.exports = { analyzePreferences, generateReason };
