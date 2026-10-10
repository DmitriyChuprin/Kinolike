import { expect, test } from '@playwright/test';

const movie = { id: 550, title: 'Бойцовский клуб', release_date: '1999-10-15', vote_average: 8.4, vote_count: 1000, genres: [{ id: 18, name: 'Драма' }], overview: 'Описание', credits: { cast: [] }, external_ids: {} };
const user = { id: 1, username: 'tester', email: 'test@example.com', is_admin: false, jellyfin_enabled: false, preferred_streaming_source: 'phantom' };
let signedIn = false;
let lastListPayload: Record<string, unknown> | null = null;

test.beforeEach(async ({ page }) => {
  signedIn = false; lastListPayload = null;
  page.on('pageerror', error => { throw error; });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/me') return route.fulfill({ status: signedIn ? 200 : 401, contentType: 'application/json', body: JSON.stringify(signedIn ? { user } : { error: 'Требуется авторизация' }) });
    if (url.pathname === '/api/auth/login') { signedIn = true; return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ user }) }); }
    if (url.pathname === '/api/tmdb/movie/550') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(movie) });
    if (url.pathname === '/api/lists/item/movie/550') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ item: null }) });
    if (url.pathname === '/api/lists' && route.request().method() === 'POST') { lastListPayload = route.request().postDataJSON(); return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ item: { id: 7, tmdb_id: 550, media_type: 'movie', status: lastListPayload?.status, details: movie } }) }); }
    if (url.pathname === '/api/lists/7' && route.request().method() === 'PUT') { const update = route.request().postDataJSON(); return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ item: { id: 7, tmdb_id: 550, media_type: 'movie', status: 'watched', rating: update.rating, notes: update.notes, details: movie } }) }); }
    if (url.pathname === '/api/streaming/link/movie/550') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ link: null }) });
    if (url.pathname === '/api/streaming/phantom/check') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ available: true, source: 'phantom', type: 'movie', voices: [{ id: 'voice-1', name: 'Оригинал' }] }) });
    if (url.pathname === '/api/streaming/phantom/playback') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ url: 'https://media.invalid/test.m3u8', type: 'm3u8', source: 'phantom', translation: 'voice-1' }) });
    if (url.pathname === '/api/streaming/progress') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ position: 0, duration: 0, updatedAt: null, revision: 0, completed: false, translationId: null }) });
    if (url.pathname === '/api/trailers/movie/550') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ found: false, trailer: null }) });
    if (url.pathname === '/api/tmdb/search') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [movie], total_pages: 1, total_results: 1 }) });
    return route.fulfill({ contentType: 'application/json', body: '{}' });
  });
});

test('guest can open a movie directly and protected playback stays gated', async ({ page }) => {
  await page.goto('/movie/550');
  await expect(page.getByRole('heading', { name: 'Бойцовский клуб' })).toBeVisible();
  await expect(page.getByText('Войдите, чтобы открыть источники просмотра')).toBeVisible();
});

test('theme is keyboard accessible and persists', async ({ page }) => {
  await page.goto('/movie/550');
  const light = page.getByRole('radio', { name: 'Светлая' });
  await light.focus();
  await light.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('login redirects to the requested page', async ({ page }) => {
  await page.goto('/login?next=%2Fmovie%2F550');
  await page.getByPlaceholder('Email').fill('test@example.com');
  await page.getByPlaceholder('Пароль').fill('password');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/movie\/550$/);
  await expect(page.getByRole('heading', { name: 'Бойцовский клуб' })).toBeVisible();
});

test('search result opens for a guest', async ({ page }) => {
  await page.goto('/search?q=Бойцовский');
  await expect(page.getByText('Бойцовский клуб').first()).toBeVisible();
  await page.getByText('Бойцовский клуб').first().click();
  await expect(page).toHaveURL(/\/movie\/550$/);
});

test('watched confirmation supports an optional rating and Escape', async ({ page }) => {
  signedIn = true;
  await page.goto('/movie/550');
  const watched = page.getByRole('button', { name: 'Просмотрено' });
  await watched.focus(); await watched.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Отметить просмотренным' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(watched).toBeFocused();
  await watched.click();
  await page.getByRole('button', { name: 'Оценка 8' }).click();
  await page.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(dialog).toBeHidden();
  expect(lastListPayload).toMatchObject({ tmdb_id: 550, media_type: 'movie', status: 'watched' });
});

test('player code is loaded only after playback is requested', async ({ page }) => {
  signedIn = true;
  const scripts: string[] = [];
  page.on('response', response => { if (response.request().resourceType() === 'script') scripts.push(response.url()); });
  await page.goto('/movie/550');
  expect(scripts.some(url => /PhantomPlayer|artplayer|hls-/.test(url))).toBe(false);
  await page.getByRole('button', { name: 'Проверить онлайн' }).click();
  await page.getByRole('button', { name: 'Смотреть онлайн' }).click();
  await expect(page.getByRole('dialog', { name: 'Онлайн-просмотр: Бойцовский клуб' })).toBeVisible();
  expect(scripts.some(url => /PhantomPlayer/.test(url))).toBe(true);
});
