// TMDB search has no global sort parameter. Collect a complete, bounded result
// set before sorting, then paginate it. Never return a silently truncated set.
const MAX_SEARCH_PAGES = 50;
const PAGE_SIZE = 20;

function badRequest(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function createCatalogService(tmdbRequest) {
  const searches = new Map();

  async function search({ query, type = 'multi', page = 1, year = '', sort = 'relevance' }) {
    if (typeof query !== 'string' || query.trim().length < 2 || query.length > 200) throw badRequest('Введите от 2 до 200 символов для поиска');
    if (!['multi', 'movie', 'tv', 'person'].includes(type)) throw badRequest('Неизвестный тип поиска');
    if (!['relevance', 'popularity', 'rating', 'year'].includes(sort)) throw badRequest('Неизвестная сортировка');
    page = Number(page);
    if (!Number.isInteger(page) || page < 1 || page > 500) throw badRequest('Некорректная страница');
    if (year && !/^[1-9]\d{3}$/.test(String(year))) throw badRequest('Укажите год из четырёх цифр');
    if (type === 'person' && (year || ['rating', 'year'].includes(sort))) throw badRequest('Для людей доступна сортировка по популярности или совпадению');
    const base = { query: query.trim(), include_adult: false };
    if (!year && sort === 'relevance') {
      const data = await tmdbRequest(`/search/${type}`, { ...base, page });
      return { ...data, total_pages: Math.min(500, data.total_pages || 0), results: data.results.map(item => ({ ...item, media_type: item.media_type || type })) };
    }

    const key = JSON.stringify([base.query, type, year]);
    let entry = searches.get(key);
    if (!entry || entry.expires < Date.now()) {
      const promise = (async () => {
        const types = type === 'multi' ? (year ? ['movie', 'tv'] : ['multi']) : [type];
        const sources = await Promise.all(types.map(async mediaType => {
          const params = { ...base, ...(year ? { [mediaType === 'tv' ? 'first_air_date_year' : 'primary_release_year']: year } : {}) };
          const first = await tmdbRequest(`/search/${mediaType}`, { ...params, page: 1 });
          if (first.total_pages > MAX_SEARCH_PAGES) throw badRequest('Слишком много совпадений для сортировки. Уточните название или выберите год и тип.', 422);
          return { mediaType, params, first };
        }));
        const all = sources.flatMap(source => source.first.results.map(item => ({ ...item, media_type: item.media_type || source.mediaType })));
        const jobs = sources.flatMap(source => Array.from({ length: Math.max(0, source.first.total_pages - 1) }, (_, i) => ({ ...source, page: i + 2 })));
        // Limit parallel requests to the upstream API.
        for (let offset = 0; offset < jobs.length; offset += 4) {
          const batch = await Promise.all(jobs.slice(offset, offset + 4).map(async job => {
            const data = await tmdbRequest(`/search/${job.mediaType}`, { ...job.params, page: job.page });
            return data.results.map(item => ({ ...item, media_type: item.media_type || job.mediaType }));
          }));
          all.push(...batch.flat());
        }
        return [...new Map(all.map(item => [`${item.media_type}:${item.id}`, item])).values()]
          .filter(item => !year || String(item.release_date || item.first_air_date || '').slice(0, 4) === String(year));
      })();
      entry = { promise, expires: Date.now() + 5 * 60 * 1000 };
      if (searches.size >= 30) searches.delete(searches.keys().next().value);
      searches.set(key, entry);
      promise.catch(() => { if (searches.get(key) === entry) searches.delete(key); });
    }
    let items = [...await entry.promise];
    if (sort === 'rating' || sort === 'year') items = items.filter(item => item.media_type !== 'person');
    const date = item => item.release_date || item.first_air_date || '';
    items.sort((a, b) => sort === 'rating' ? (b.vote_average || 0) - (a.vote_average || 0) || (b.vote_count || 0) - (a.vote_count || 0) : sort === 'year' ? date(b).localeCompare(date(a)) : sort === 'popularity' ? (b.popularity || 0) - (a.popularity || 0) : 0);
    return { page, results: items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), total_results: items.length, total_pages: Math.ceil(items.length / PAGE_SIZE) };
  }

  async function catalog({ collection = 'popular', type = 'movie', genre = '', page = 1 }) {
    const endpoints = { popular: '/movie/popular', cinema: '/movie/now_playing', upcoming: '/movie/upcoming', top: '/movie/top_rated', tv: '/trending/tv/week' };
    if (!Object.hasOwn(endpoints, collection) || !['movie', 'tv'].includes(type)) throw badRequest('Неизвестная подборка');
    if (genre && !/^\d{1,6}$/.test(String(genre))) throw badRequest('Некорректный жанр');
    page = Number(page);
    if (!Number.isInteger(page) || page < 1 || page > 500) throw badRequest('Некорректная страница');
    const mediaType = genre ? type : collection === 'tv' ? 'tv' : 'movie';
    const params = { page, ...(genre ? { with_genres: genre, sort_by: 'popularity.desc', include_adult: false } : ['cinema', 'upcoming'].includes(collection) ? { region: 'RU' } : {}) };
    const data = await tmdbRequest(genre ? `/discover/${mediaType}` : endpoints[collection], params, { ttlHours: 6 });
    return { ...data, total_pages: Math.min(500, data.total_pages || 0), results: data.results.map(item => ({ ...item, media_type: mediaType })) };
  }
  return { search, catalog };
}

module.exports = { createCatalogService };
