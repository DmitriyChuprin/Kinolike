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

## Рекомендательный алгоритм

Персональные рекомендации строятся на основе анализа просмотренных фильмов пользователя и их оценок.

### Веса признаков (FEATURE_WEIGHTS)

| Признак | Вес | Описание |
|---------|-----|----------|
| genres | 0.25 | Жанры фильма |
| keywords | 0.25 | Ключевые слова TMDB (тематика) |
| directors | 0.15 | Режиссёры |
| overview | 0.15 | Текстовое описание (токенизировано) |
| actors | 0.10 | Актёрский состав (топ-10) |
| quality | 0.05 | Качество TMDB (vote_average + vote_count) |
| countries | 0.025 | Страны производства |
| languages | 0.015 | Язык оригинала |
| eras | 0.01 | Десятилетие выпуска |

### Веса схожести (SIMILARITY_WEIGHTS)

| Признак | Вес |
|---------|-----|
| genres | 0.30 |
| directors | 0.15 |
| actors | 0.10 |
| overview | 0.15 |
| keywords | 0.10 |
| countries | 0.05 |
| languages | 0.05 |
| eras | 0.10 |

### Формула оценки

```
score = 50 + weighted_sum × 50
```

Где `weighted_sum` = Σ(component × weight) + similarity × 0.125

- **component** — нормализованное предпочтение пользователя по каждому признаку (от -1 до 1)
- **similarity** = avg(сходство с высокооценёнными) − avg(сходство с низкооценёнными)
- **quality** = нормализованный рейтинг TMDB × 0.7 + популярность × 0.3

### Коэффициенты оценок

| Оценка | Вес |
|--------|-----|
| 10 | +5 |
| 9 | +4 |
| 8 | +3 |
| 7 | +2 |
| 6 | +1 |
| 5 | 0 |
| 4 | −1 |
| 3 | −2 |
| 2 | −3 |
| 1 | −4 |

### Диверсификация

- Максимум 3 фильма одного жанра (`maxPerGenre`)
- Максимум 1 фильм одного режиссёра (`maxPerDirector`)
- Ограничения вступают в силу после заполнения половины лимита результатов

### Минимум данных

- Минимум 2 оценённых фильма для генерации рекомендаций
- Минимум 20 голосов на TMDB для кандидата

### Тестирование

```bash
node server/tests/recommendations.test.js
```

Тесты проверяют:
- Извлечение ключевых слов из данных TMDB
- Построение профиля пользователя с различными оценками
- Оценку кандидатов (положительные/отрицательные веса)
- Схожесть (высокая vs низкая)
- Диверсификацию по жанрам
- Исключение просмотренных фильмов
- Обработку недостаточного количества оценок

## Лицензия

MIT
