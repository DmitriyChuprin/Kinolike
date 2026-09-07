# Мой киноплан

Веб-приложение для отслеживания фильмов и сериалов (аналог Кинопоиска).

## Возможности

- **Каталог** — популярные фильмы и сериалы из TMDB
- **Списки** — хочу посмотреть, смотрю, просмотрено, отложено
- **Просмотренные** — оценки 1–10, статистика, фильтры
- **Рекомендации** — ИИ на основе OpenAI-compatible API
- **Поиск** — с автодополнением через TMDB
- **Профиль** — статистика, настройки, экспорт/импорт
- **Тёмная/светлая тема**
- **Детальная информация** — год, жанры, режиссёры, актёры для каждого фильма/сериала

## Технологии

- **Frontend**: Vanilla HTML5 + CSS3 + JS (SPA hash-based)
- **Backend**: Node.js 20 + Express 4
- **БД**: PostgreSQL 16
- **AI**: OpenAI-compatible API
- **TMDB**: API v3 через backend proxy (с кэшированием в БД)
- **Прокси**: SOCKS5/VLESS для обхода блокировок TMDB в России
- **Docker**: Docker Compose (app + PostgreSQL)

## Запуск

### Через Docker

```bash
# Создайте .env файл (см. .env.example)
cp .env.example .env
# Заполните TMDB_API_KEY, JWT_SECRET, AI_API_KEY

docker-compose up -d
```

### Для разработки

```bash
npm install
cp .env.example .env
# Заполните переменные окружения
npm run dev
```

## Конфигурация (.env)

| Переменная | Описание |
|-----------|----------|
| PORT | Порт сервера (по умолчанию 3000) |
| TMDB_API_KEY | API ключ TMDB |
| JWT_SECRET | Секрет для JWT токенов |
| AI_BASE_URL | URL OpenAI-compatible API |
| AI_API_KEY | Ключ API |
| AI_MODEL | Модель (по умолчанию gpt-4o) |
| TMDB_PROXY_ENABLED | Включить прокси для TMDB |
| TMDB_PROXY_TYPE | Тип прокси (socks5) |
| TMDB_PROXY_HOST | Хост прокси |
| TMDB_PROXY_PORT | Порт прокси |
| TMDB_PROXY_USERNAME | Имя пользователя прокси |
| TMDB_PROXY_PASSWORD | Пароль прокси |
| PGHOST | Хост PostgreSQL |
| PGPORT | Порт PostgreSQL |
| PGDATABASE | Имя базы данных |
| PGUSER | Пользователь PostgreSQL |
| PGPASSWORD | Пароль PostgreSQL |

## Структура проекта

```
kinolike/
├── client/           # Frontend (vanilla)
│   ├── index.html    # SPA entry point
│   ├── css/          # Стили
│   └── js/           # Модули
├── server/           # Backend (Node.js + Express)
│   ├── index.js      # Entry point
│   ├── routes/       # API маршруты
│   ├── services/     # TMDB, AI сервисы
│   ├── models/       # Модели данных
│   ├── db/           # PostgreSQL + миграции
│   └── middleware/    # JWT auth
├── docker-compose.yml
├── Dockerfile
└── .env.example
```

## База данных

### Таблицы

- **users** — пользователи
- **user_lists** — списки фильмов/сериалов (хочу посмотреть, смотрю, просмотрено и т.д.)
- **media_metadata** — метаданные фильмов/сериалов (название, год, постер, описание)
- **genres** — справочник жанров
- **media_genres** — связь фильм/сериал ↔ жанры
- **media_directors** — режиссёры и создатели сериалов
- **media_actors** — актёры с персонажами
- **recommendations** — кэш рекомендаций ИИ
- **streaming_links** — ссылки на стриминг (TorrServer/Jellyfin)
- **tmdb_cache** — кэш ответов TMDB API

### Миграции

Миграции автоматически применяются при старте сервера. Файлы миграций находятся в `server/db/migrations/`.

## Прокси для TMDB

В России `api.themoviedb.org` заблокирован через DNS-отравление (возвращает `127.0.0.1`). Для обхода используется SOCKS5 прокси:

### Настройка прокси

1. Установите xray-core
2. Создайте конфиг клиента (см. `~/bin/xray-client.json`)
3. Запустите прокси: `~/bin/xray run -c ~/bin/xray-client.json`
4. В `.env` установите:
   ```
   TMDB_PROXY_ENABLED=true
   TMDB_PROXY_TYPE=socks5
   TMDB_PROXY_HOST=172.18.0.1
   TMDB_PROXY_PORT=1080
   ```

### Архитектура прокси

```
kinolike (Docker) → SOCKS5 → xray клиент → VLESS → VPS3 → интернет → api.themoviedb.org
```

## Лицензия

MIT
