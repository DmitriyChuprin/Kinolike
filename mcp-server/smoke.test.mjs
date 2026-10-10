/**
 * Smoke test for the kinolike MCP server v2.1.
 * Spawns the server over stdio and calls tools the way Hermes does.
 * Uses a prepared test account and may add items to its watchlist.
 * Set KINOLIKE_TOKEN and optionally KINOLIKE_URL before running.
 * Run from mcp-server/ dir: node smoke.test.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

if (!process.env.KINOLIKE_TOKEN) {
  console.error('Set KINOLIKE_TOKEN for a prepared test account before running this test.');
  process.exit(1);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? ` :: ${detail}` : ''}`);
}

const transport = new StdioClientTransport({
  command: 'node',
  args: [fileURLToPath(new URL('./index.js', import.meta.url))],
  env: {
    ...process.env,
    KINOLIKE_URL: process.env.KINOLIKE_URL || 'http://localhost:3001',
  },
});

const client = new Client({ name: 'smoke-test', version: '1.0.0' });
await client.connect(transport);

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content || []).map(c => c.text || '').join('\n');
  return { text, isError: !!r.isError };
}

const { tools } = await client.listTools();
const getTool = n => tools.find(t => t.name === n);
check('all 10 tools registered', tools.length === 10, tools.map(t => t.name).join(','));
check('add_to_watchlist has media_type', !!getTool('add_to_watchlist')?.inputSchema?.properties?.media_type);
check('mark_watched has media_type', !!getTool('mark_watched')?.inputSchema?.properties?.media_type);
check('movie_details has media_type', !!getTool('movie_details')?.inputSchema?.properties?.media_type);

// 1. search
let r = await call('search', { query: 'Повелитель бури', limit: 3 });
check('search finds movie + tmdb id', /Повелитель бури/.test(r.text) && /12162/.test(r.text), (r.text.split('\n')[2] || r.text).slice(0, 90));

// 2. movie_details by tmdb_id — old bug returned a DIFFERENT movie
r = await call('movie_details', { tmdb_id: 12162 });
check('movie_details(12162) = Повелитель бури', /Повелитель бури/.test(r.text) && !/Greatest Lie/.test(r.text), r.text.split('\n').slice(0, 2).join(' | '));
check('movie_details shows my list status', /My status: want_to_watch/.test(r.text));

// 3. TV auto-detection (no media_type given)
r = await call('movie_details', { tmdb_id: 1396 });
check('movie_details(1396) = Во все тяжкие, Type: tv', /Во все тяжкие/.test(r.text) && /Type: tv/.test(r.text), r.text.split('\n').slice(0, 2).join(' | '));

// 4. unknown id → friendly 404 (isError + message)
r = await call('movie_details', { tmdb_id: 999999999 });
check('movie_details unknown id → not-found error', r.isError && /not found/i.test(r.text), r.text.slice(0, 90));

// 5. old bug: add by tmdb_id+media_type → worked (old version: 422 always)
//    Idempotent: 12162 already in watchlist → "Already in your watchlist."
r = await call('add_to_watchlist', { tmdb_id: 12162, media_type: 'movie' });
check('add_to_watchlist(tmdb_id+type) idempotent', /Already in your watchlist/.test(r.text), r.text.slice(0, 90));

// 6. old bug: tmdb_id ALONE → 422; now auto-detects (also already in list)
r = await call('add_to_watchlist', { tmdb_id: 12162 });
check('add_to_watchlist(tmdb_id alone) auto-detects type', /Already in your watchlist|Added/.test(r.text), r.text.slice(0, 90));

// 7. old bug: title path dropped media_type → 422
r = await call('add_to_watchlist', { title: 'Повелитель бури' });
check('add_to_watchlist(title) works', /Already in your watchlist|Added/.test(r.text), r.text.slice(0, 90));

// 8. duplicate detection friendly message (old: dead code, raw API error text)
r = await call('add_to_watchlist', { tmdb_id: 12162, media_type: 'movie' });
check('duplicate → friendly message', /Already in your watchlist/.test(r.text), r.text.slice(0, 60));

// 9. get_watchlist + item_id + tv filter
r = await call('get_watchlist', {});
check('get_watchlist shows item_id', /item_id: \d+/.test(r.text), r.text.split('\n')[0]);
const movieLine = r.text.split('\n').find(l => /Повелитель бури/.test(l));
check('get_watchlist entry formatted with type', !!movieLine && /\[movie\]/.test(movieLine), movieLine || '');
r = await call('get_watchlist', { media_type: 'tv' });
const tvLines = r.text.split('\n').filter(l => l.startsWith('• '));
check('get_watchlist media_type=tv → only tv', tvLines.length > 0 && tvLines.every(l => /\[tv\]/.test(l)), `${tvLines.length} tv items`);

// 10. get_watched: user rating labeled "my rating" (old: showed TMDB rating as user's)
r = await call('get_watched', { limit: 5 });
check('get_watched shows my rating + item_id', /my rating: (\d+\/10|—)/.test(r.text), (r.text.split('\n')[1] || r.text.slice(0, 90)));

// 11. recommendations + profile
r = await call('recommendations', { query: 'фантастика на вечер', limit: 3 });
check('recommendations ok', !r.isError && /Recommendations|No recommendations/.test(r.text), r.text.split('\n')[0]);
r = await call('profile', {});
check('profile ok', /Taste Profile/.test(r.text));

// 12. movie_details on a watched item shows my rating (regression: status display)
r = await call('movie_details', { tmdb_id: 27205 });
check('movie_details(27205) shows status watched + rating 10', /My status: watched/.test(r.text) && /My rating: 10\/10/.test(r.text), r.text.split('\n').slice(-2).join(' | '));

await client.close();

const failed = results.filter(x => !x.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
if (failed.length) {
  console.log('FAILED:', failed.map(f => f.name).join('; '));
  process.exit(1);
}
