const assert = require('assert');
const videohub = require('../services/videohub');
const phantom = require('../services/phantom');

const stream = 'http://127.0.0.1:9118/lite/cdnvideohub/video.m3u8?vkId=video_1&title=Example&play=true';
assert.strictEqual(videohub.lampacStreamUrl(stream).pathname, '/lite/cdnvideohub/video.m3u8');
assert.strictEqual(videohub.lampacStreamUrl(stream).hostname, '192.168.1.103');
assert.throws(() => videohub.lampacStreamUrl('https://example.com/playlist.m3u8'), /unsafe/);

const base = new URL(stream);
assert.strictEqual(videohub.resolvePlaylistValue(base, '/proxy/hls/segment.ts?token=private').pathname, '/proxy/hls/segment.ts');
assert.strictEqual(videohub.resolvePlaylistValue(base, '../admin'), null);
assert.strictEqual(videohub.resolvePlaylistValue(base, 'https://example.com/segment.ts'), null);
const manifest = videohub.rewriteManifest('#EXTM3U\n/proxy/hls/segment.ts?token=private', base, 7);
assert.ok(manifest.includes('/api/streaming/videohub/hls/'));
assert.ok(!manifest.includes('token=private'));

// CDNvideohub emits Lampac's standard season/voice/episode data-json cards.
const series = phantom.parseDataJson('<i data-json="{&quot;url&quot;:&quot;http://127.0.0.1:9118/lite/cdnvideohub?s=2&quot;,&quot;s&quot;:2}"></i><i data-json="{&quot;stream&quot;:&quot;http://127.0.0.1:9118/lite/cdnvideohub/video.m3u8?vkId=4&quot;,&quot;s&quot;:2,&quot;e&quot;:4,&quot;name&quot;:&quot;4 серия&quot;}"></i>');
assert.deepStrictEqual(phantom.normalizeSeasons(series), [2]);
assert.deepStrictEqual(phantom.normalizeEpisodes(series).map(({ season, episode }) => [season, episode]), [[2, 4]]);
console.log('✓ VideoHUB Lampac stream validation and HLS rewrite');
