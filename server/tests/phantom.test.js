const assert = require('assert');
const phantom = require('../services/phantom');

const movieLookup = phantom.buildLookupQuery({
  tmdbId: 157336, imdbId: 'tt0816692', title: 'Интерстеллар', originalTitle: 'Interstellar',
  year: 2014, mediaType: 'movie', originalLanguage: 'en',
});
assert.strictEqual(movieLookup.get('orid'), null, 'TMDB id must never become Phantom orid');
assert.strictEqual(movieLookup.get('kinopoisk_id'), null, 'TMDB id must never become Kinopoisk id');
assert.strictEqual(movieLookup.get('imdb_id'), 'tt0816692', 'IMDb id must be sent to Phantom');
assert.strictEqual(movieLookup.get('title'), 'Интерстеллар');
assert.strictEqual(movieLookup.get('serial'), '0');
const titleFallback = phantom.buildLookupQuery({ tmdbId: 157336, title: 'Interstellar', year: 2014, mediaType: 'movie', originalLanguage: 'en' });
assert.strictEqual(titleFallback.has('orid'), false);
assert.strictEqual(titleFallback.has('imdb_id'), false);
assert.strictEqual(titleFallback.has('kinopoisk_id'), false);
assert.strictEqual(titleFallback.get('title'), 'Interstellar');
const seriesLookup = phantom.buildLookupQuery({ imdbId: 'tt0944947', kinopoiskId: '464963', title: 'Игра престолов', mediaType: 'tv', season: 2, translationId: '66' });
assert.strictEqual(seriesLookup.get('serial'), '1');
assert.strictEqual(seriesLookup.get('imdb_id'), 'tt0944947');
assert.strictEqual(seriesLookup.get('kinopoisk_id'), '464963');
assert.strictEqual(seriesLookup.get('s'), '2');
assert.strictEqual(seriesLookup.get('t'), '66');

const film = phantom.parseDataJson('<div data-json="[{&quot;stream&quot;:&quot;http://127.0.0.1:9118/lite/phantom/video.m3u8?id=1\\u0026token=x&quot;,&quot;translate&quot;:&quot;Дублированный&quot;,&quot;maxquality&quot;:&quot;2160p&quot;}]"></div>');
assert.strictEqual(film[0].stream.includes('&token=x'), true, 'JSON unicode escapes must be decoded');
assert.deepStrictEqual(phantom.normalizeVoices(film), [{ id: 'Дублированный', name: 'Дублированный', quality: '2160p' }]);
assert.strictEqual(phantom.lampacStreamUrl(film[0].stream).origin, 'http://192.168.1.103:9118', 'Lampac loopback URL must be canonicalized server-side');
const multiVoice = phantom.parseDataJson('<i data-json="{&quot;stream&quot;:&quot;http://127.0.0.1:9118/lite/phantom/video.m3u8?id=1&quot;,&quot;translate&quot;:&quot;Дублированный&quot;}"></i><i data-json="{&quot;stream&quot;:&quot;http://127.0.0.1:9118/lite/phantom/video.m3u8?id=2&quot;,&quot;translate&quot;:&quot;Оригинальный&quot;}"></i>');
assert.deepStrictEqual(phantom.normalizeVoices(multiVoice).map((voice) => voice.name), ['Дублированный', 'Оригинальный']);
assert.strictEqual(phantom.findStream(multiVoice, { translationId: 'Оригинальный' }).stream.includes('id=2'), true);
const seriesSelectors = phantom.parseDataJson("<div data-json='{&quot;url&quot;:&quot;http://127.0.0.1:9118/lite/phantom?s=1&amp;t=34&quot;}'>LostFilm</div><div data-json='{&quot;stream&quot;:&quot;http://127.0.0.1:9118/lite/phantom/video.m3u8&quot;,&quot;s&quot;:1,&quot;e&quot;:1,&quot;name&quot;:&quot;1 серия&quot;}'></div>");
assert.deepStrictEqual(phantom.normalizeVoices(seriesSelectors).map((voice) => voice.name), ['LostFilm']);

const series = [{ url: 'http://127.0.0.1:9118/lite/phantom?s=2' }, { url: 'http://127.0.0.1:9118/lite/phantom?s=1' }];
assert.deepStrictEqual(phantom.normalizeSeasons(series), [1, 2]);
const voices = [{ stream: 'http://127.0.0.1:9118/lite/phantom/video.m3u8?t=34', voice_name: 'LostFilm' }];
assert.deepStrictEqual(phantom.normalizeVoices(voices), [{ id: '34', name: 'LostFilm', quality: undefined }]);
const episodes = [{ s: 1, e: 2, name: '2 серия', details: 'LostFilm' }, { s: 1, e: 1, name: '1 серия' }];
assert.deepStrictEqual(phantom.normalizeEpisodes(episodes).map((episode) => episode.episode), [1, 2]);

// Lampac's selected-translation response has no t/translate_id on episode
// cards: t is applied to the lookup URL, while s/e identify the stream.
const selectedSeries = [
  { s: 1, e: 1, stream: 'http://127.0.0.1:9118/lite/phantom/video.m3u8?id_file=s1e1' },
  { s: 1, e: 2, stream: 'http://127.0.0.1:9118/lite/phantom/video.m3u8?id_file=s1e2' },
  { s: 1, e: 3, stream: 'http://127.0.0.1:9118/lite/phantom/video.m3u8?id_file=s1e3' },
  { s: 1, e: 10, stream: 'http://127.0.0.1:9118/lite/phantom/video.m3u8?id_file=s1e10' },
  { s: 2, e: 1, stream: 'http://127.0.0.1:9118/lite/phantom/video.m3u8?id_file=s2e1' },
  { s: 2, e: 2, stream: 'http://127.0.0.1:9118/lite/phantom/video.m3u8?id_file=s2e2' },
];
for (const [season, episode, id] of [[1, 1, 's1e1'], [1, 2, 's1e2'], [1, 3, 's1e3'], [1, 10, 's1e10'], [2, 1, 's2e1'], [2, 2, 's2e2']]) {
  assert.ok(phantom.findStream(selectedSeries, { season, episode, translationId: '66' }).stream.includes(id), `must select S${season}E${episode}`);
}
assert.strictEqual(phantom.findStream(selectedSeries, { season: 1, episode: 5, translationId: '66' }), null, 'an absent selected episode must not fall back to episode 1');

// Some Phantom builds carry selector identity only in the card URL.
const urlAddressedEpisode = [{ stream: 'http://127.0.0.1:9118/lite/phantom/video.m3u8?s=3&e=7&id_file=url-card' }];
assert.deepStrictEqual(phantom.normalizeEpisodes(urlAddressedEpisode).map((item) => [item.season, item.episode]), [[3, 7]]);
assert.ok(phantom.findStream(urlAddressedEpisode, { season: 3, episode: 7 }).stream.includes('url-card'));

const base = new URL('http://192.168.1.103:9118/lite/phantom/video.m3u8?x=1');
assert.strictEqual(phantom.resolvePlaylistValue(base, 'http://127.0.0.1:9118/proxy/a.m3u8?token=1').pathname, '/proxy/a.m3u8');
assert.strictEqual(phantom.resolvePlaylistValue(base, '/proxy/a.m3u8?token=1').pathname, '/proxy/a.m3u8');
assert.strictEqual(phantom.resolvePlaylistValue(base, 'segment-001.ts?part=1').pathname, '/lite/phantom/segment-001.ts');
assert.strictEqual(phantom.resolvePlaylistValue(base, 'https://example.com/x'), null);
assert.strictEqual(phantom.resolvePlaylistValue(base, '//example.com/x'), null);
assert.strictEqual(phantom.resolvePlaylistValue(base, '../admin'), null);

const rewritten = phantom.rewriteManifest('#EXTM3U\n/proxy/a.m3u8?x=1\nsegment.ts?x=2', base, 7);
assert.ok(!rewritten.includes('127.0.0.1:9118'));
assert.strictEqual((rewritten.match(/\/api\/streaming\/phantom\/hls\//g) || []).length, 2);
console.log('✓ Phantom HTML parser, normalization, HLS rewrite and SSRF guards');
