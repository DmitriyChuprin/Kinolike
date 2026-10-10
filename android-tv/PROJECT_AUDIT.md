# Аудит существующего KinoLike

## Архитектура

Express (`server/index.js`) обслуживает React SPA и `/api/*`. PostgreSQL хранит пользователей, списки, TMDB-кэш/метаданные и позиции просмотра. React (`src/services/api.ts`) работает с теми же API, cookie credentials и ранее сохранённым Bearer-токеном. Android-модуль изолирован и не меняет backend/frontend.

## Авторизация, сессии, CORS

- Основные маршруты: `/api/auth/register|login|logout|me|profile|password`.
- JWT живёт 7 дней и по умолчанию возвращается только в `httpOnly` cookie `token`; JSON-токен включается лишь переменной `LEGACY_AUTH_TOKENS=true`.
- `Authorization: Bearer` имеет приоритет над cookie и мигрируется сервером в cookie.
- Production-cookie имеет `Secure`; `SameSite=Lax`, `Path=/`.
- CORS разрешает запросы без `Origin` и origins из `CORS_ORIGINS`, с `credentials: true`.
- CSRF middleware проверяет unsafe browser-запросы с cookie и `Origin`; запрос без `Origin` или с `Authorization` пропускается.

## Каталог и поиск

- `/api/tmdb/search` и `/api/tmdb/catalog` используют единый catalog service и пагинацию.
- Публичные TMDB-маршруты дают popular/trending/now playing/upcoming/top rated для movie/tv.
- `/api/tmdb/movie/:id` и `/api/tmdb/tv/:id` возвращают raw TMDB v3 JSON с добавленными credits/similar/keywords/external IDs из backend cache/service.
- `/api/tmdb/image` проксирует и кэширует постеры, сохраняя сетевые обходы TMDB на серверной стороне.
- Пользовательские `/api/lists`, `/api/watched`, `/api/recommendations` защищены общей JWT middleware.

## TMDB-модель

Канонический ключ — `(tmdb_id, media_type)`. Movie использует `title`, `release_date`; TV — `name`, `first_air_date`. Общие поля: `poster_path`, `backdrop_path`, `overview`, `vote_average`, `vote_count`, `genre_ids`/`genres`. Детали TV содержат `number_of_seasons` и `seasons`. Backend задаёт локаль `ru-RU`, кэширует raw JSON и обогащает IMDb, не заменяя TMDB.

## Playback-интеграции для следующего этапа

- Phantom — Lampac adapter; нормализует сезоны, эпизоды, озвучки и HLS, скрывает provider-specific HTML/token details. Позиции и optimistic revision хранятся в `phantom_watch_positions`.
- VideoHUB — резервный Lampac/CDNvideohub adapter. Разрешает Kinopoisk ID через `/externalids`, валидирует URL и переписывает HLS на авторизованный KinoLike proxy.
- Jellyfin — серверная интеграция с API key/user token. Ищет строго по TMDB ProviderId с безопасным fallback title+year, проксирует playback, tracks и lifecycle событий. Доступ дополнительно ограничен `user_jellyfin_access`.
- Эти секреты/URL не должны попадать в Android-клиент; Media3 должен получать только KinoLike playback/proxy URL.
