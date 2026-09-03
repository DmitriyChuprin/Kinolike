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

## Технологии

- **Frontend**: Vanilla HTML5 + CSS3 + JS (SPA hash-based)
- **Backend**: Node.js 20 + Express 4
- **БД**: SQLite3 (better-sqlite3)
- **AI**: OpenAI-compatible API
- **TMDB**: API v3 через backend proxy
- **Docker**: Один контейнер, Express раздаёт статику

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
| DB_PATH | Путь к файлу SQLite |
| TMDB_API_KEY | API ключ TMDB |
| JWT_SECRET | Секрет для JWT токенов |
| AI_BASE_URL | URL OpenAI-compatible API |
| AI_API_KEY | Ключ API |
| AI_MODEL | Модель (по умолчанию gpt-4o) |
| TMDB_PROXY_ENABLED | Включить прокси для TMDB |
| TMDB_PROXY_TYPE | Тип прокси (socks5) |
| TMDB_PROXY_HOST | Хост прокси |
| TMDB_PROXY_PORT | Порт прокси |

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
│   ├── db/           # SQLite
│   └── middleware/    # JWT auth
├── docker-compose.yml
├── Dockerfile
└── .env.example
```
