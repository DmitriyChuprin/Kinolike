# SPEC.md — «Мой киноплан»: план реализации

## Краткое описание

SPA-приложение для отслеживания фильмов и сериалов (аналог Кинопоиска).
Данные хранятся на сервере (SQLite). Ключевые фичи: раздел «Просмотренные»
с оценками 1–10 и раздел «Рекомендации» на основе ИИ (OpenAI-compatible API).
Всё запускается одной командой `docker-compose up`.

---

## Технологический стек

| Слой       | Технология                                          |
|------------|-----------------------------------------------------|
| Frontend   | Vanilla HTML5 + CSS3 + JS (без сборщиков, без фреймворков) |
| Роутинг    | SPA hash-based (`#/path`)                           |
| Стили      | CSS Grid/Flexbox, CSS-переменные для тем             |
| Backend    | Node.js 20 + Express 4                             |
| БД         | SQLite3 через `better-sqlite3` (файл в Docker volume) |
| Auth       | bcryptjs + JWT (httpOnly cookie)                    |
| AI         | OpenAI-compatible API через `openai` npm-пакет       |
| TMDB       | API v3, проксируется через backend                   |
| Прокси TMDB| SOCKS5 (`socks-proxy-agent`) или VLESS              |
| Безопасность | helmet, express-rate-limit, CORS                   |
| Docker     | Один контейнер (node:20-alpine), Express раздаёт статику |

---

## Структура файлов

```
kinolike/
├── client/                         # Frontend (vanilla)
│   ├── index.html                  # SPA entry point
│   ├── css/
│   │   ├── style.css               # Глобальные стили, темы, сетка
│   │   ├── components.css          # Карточки, модалки, тосты, шкала оценок
│   │   └── animations.css          # Fade-in, slide, scale, пульсация
│   └── js/
│       ├── app.js                  # Hash-роутинг, навигация, тема
│       ├── api.js                  # Обёртка fetch → backend
│       ├── auth.js                 # Логин/регистрация/профиль
│       ├── movies.js               # Каталог (главная, табы фильм/сериал)
│       ├── lists.js                # Списки: хочу, смотрю, отложено
│       ├── detail.js               # Детальная страница фильма/сериала
│       ├── watched.js              # Просмотренные + оценки 1–10
│       ├── recommendations.js      # ИИ-рекомендации
│       ├── stats.js                # Статистика
│       ├── search.js               # Поиск с автодополнением (debounce 300ms)
│       └── ui.js                   # Модалки, тосты, анимации, переключатель темы
├── server/
│   ├── index.js                    # Express entry point, static serving
│   ├── routes/
│   │   ├── auth.js                 # POST register/login, GET /me, PUT profile
│   │   ├── lists.js                # CRUD списков + export/import
│   │   ├── watched.js              # Просмотренные + rate + stats
│   │   ├── tmdb.js                 # Прокси ко всем TMDB-эндпоинтам
│   │   ├── recommendations.js      # AI-рекомендации + кэш
│   │   └── stats.js                # GET /api/stats/overview
│   ├── middleware/
│   │   └── auth.js                 # JWT-проверка
│   ├── services/
│   │   ├── ai.js                   # OpenAI-compatible клиент + промпт
│   │   └── tmdb.js                 # TMDB API обёртка + прокси (SOCKS5/VLESS)
│   ├── models/
│   │   ├── user.js                 # users CRUD
│   │   ├── listItem.js             # user_lists CRUD
│   │   └── recommendation.js       # recommendations CRUD + кэш
│   ├── db/
│   │   ├── database.js             # Инициализация better-sqlite3
│   │   └── schema.sql              # DDL: users, user_lists, recommendations
│   └── utils/
│       └── helpers.js              # Вспомогательные функции
├── docker-compose.yml
├── Dockerfile
├── .env                            # Конфиг (TMDB, JWT, AI, прокси)
├── .env.example
├── package.json
└── README.md
```

---

## Ключевые страницы

### 1. Каталог (главная, `#/`)
- Слайдер популярных (TMDB), табы Фильмы/Сериалы
- Секции: Популярные, Сейчас в кино, Новинки, Похожие на то что смотрите

### 2. Хочу посмотреть (`#/want`)
- Список `want_to_watch`, фильтры (тип, жанр, год), сортировка
- Кнопка «Начать смотреть» → `watching`, экспорт/импорт

### 3. Смотрю (`#/watching`)
- Список `watching`, кнопка «Пометить просмотренным» → `watched`

### 4. Просмотренные (`#/watched`) ★ КЛЮЧЕВАЯ ФИЧА
- Оценки 1–10 (число + цветовая шкала: 9–10 зелёный → 1–2 красный)
- Сортировка: по оценке, дате, году, рейтингу TMDB
- Фильтры: тип, жанр, год, диапазон оценки
- Статистика на странице: количество, средняя оценка, топ жанров

### 5. Отложено (`#/onhold`)
- Список `on_hold`, фильтры и сортировка

### 6. Рекомендации (`#/recommendations`) ★ КЛЮЧЕВАЯ ФИЧА
- Цвет-акцент: бирюзовый `#00d4aa`
- AI формирует рекомендации на основе просмотренных + оценок
- Кэш в БД (TTL 24ч), инвалидация при изменении просмотров
- Карточки: постер, название, год, рейтинг, жанры, причина ИИ, score ИИ
- Кнопки: добавить в любой список

### 7. Детальная страница (`#/movie/:id`, `#/tv/:id`)
- Backdrop + постер, метаданные из TMDB
- Актёры (топ-10), трейлер (YouTube embed), похожие
- Кнопки статусов + оценка/заметка для «Просмотрено»

### 8. Профиль (`#/profile`)
- Данные пользователя, статистика, смена пароля, тема
- Экспорт/импорт JSON

### 9. Поиск (`#/search`)
- Автодополнение (debounce), фильтры (год, жанр), бесконечный скролл

---

## UI-компоненты

- **Карточка фильма**: постер (w342), название, год, рейтинг TMDB (цвет), жанры (до 4), hover-scale
- **Модалка добавления**: выбор статуса + оценка 1–10 + заметка
- **Тост-уведомления**: slide-up, авто-скрытие 3с
- **Шкала оценок**: кликабельное число 1–10, цвет маркировки
- **Табы с бейджами**: количество в каждом статусе
- **Поиск**: мини-карточки в выпадашке

---

## Дизайн

- Тёмная тема по умолчанию, светлая по переключателю
- Основной фон: `#111113`, карточки: `#1a1a2e`, акцент: `#e50914` (красный)
- Сетка: 4–5 колонок десктоп / 3 планшет / 2 мобайл
- Шрифт: Inter / System UI
- Иконки: Lucide или SVG
- Анимации: fade-in + slide-up (0.3s), hover scale 1.02, ступенчатый fade-in для рекомендаций

---

## Зависимости (npm)

**Production:**
| Пакет | Версия | Назначение |
|-------|--------|------------|
| express | ^4.18 | HTTP-сервер + static |
| better-sqlite3 | ^9.4 | SQLite driver |
| bcryptjs | ^2.4 | Хэширование паролей |
| jsonwebtoken | ^9.0 | JWT |
| cors | ^2.8 | CORS |
| dotenv | ^16.3 | .env загрузка |
| helmet | ^7.1 | Security headers |
| express-rate-limit | ^7.1 | Rate limiting |
| openai | ^4.0 | OpenAI-compatible API клиент |
| node-fetch | ^3.3 | HTTP-запросы к TMDB |
| socks-proxy-agent | ^8.0 | SOCKS5 прокси для TMDB |

**Dev:**
| Пакет | Версия | Назначение |
|-------|--------|------------|
| nodemon | ^3.0 | Авто-рестарт при разработке |

---

## База данных (SQLite)

Три таблицы, DDL в `server/db/schema.sql`:

1. **users** — id, username, email, password_hash, avatar_url, created_at
2. **user_lists** — id, user_id, tmdb_id, media_type (movie|tv), status (want_to_watch|watching|watched|on_hold), rating (1–10), notes, added_at, updated_at, watched_at. UNIQUE(user_id, tmdb_id, media_type)
3. **recommendations** — id, user_id, tmdb_id, media_type, reason, score, generated_at, expires_at. UNIQUE(user_id, tmdb_id, media_type)

---

## API эндпоинты (сводка)

| Метод | Путь | Описание |
|-------|------|----------|
| POST | /api/auth/register | Регистрация |
| POST | /api/auth/login | Вход → JWT |
| GET | /api/auth/me | Текущий пользователь |
| PUT | /api/auth/profile | Обновить профиль |
| GET | /api/lists | Список (фильтры: status, media_type, sort) |
| POST | /api/lists | Добавить |
| PUT | /api/lists/:id | Обновить статус/оценку |
| DELETE | /api/lists/:id | Удалить |
| GET | /api/lists/export | Экспорт JSON |
| POST | /api/lists/import | Импорт JSON |
| GET | /api/watched | Просмотренные (сортировка, фильтры) |
| PUT | /api/watched/:id/rate | Оценить |
| GET | /api/watched/stats | Статистика просмотренных |
| GET | /api/recommendations | Получить рекомендации (кэш 24ч) |
| POST | /api/recommendations/generate | Принудительная генерация |
| DELETE | /api/recommendations/cache | Очистить кэш |
| GET | /api/stats/overview | Общая статистика |
| GET | /api/tmdb/* | Прокси TMDB (search, movie, tv, genres, credits, similar, videos) |

---

## AI-интеграция

- Клиент: `openai` npm-пакет, base URL + API key + model из .env
- Промпт: система — «кинорекомендатель», пользователь — список просмотренных с оценками и жанрами
- Формат ответа: JSON-массив `{tmdb_id, media_type, reason, score}`
- Кэширование: таблица `recommendations`, TTL 24ч, инвалидация при изменении `user_lists`
- Ошибки: таймаут 30с, повтор 1 раз при невалидном JSON

---

## Проксирование TMDB

- SOCKS5: `socks-proxy-agent` — все запросы к api.themoviedb.org
- VLESS: через node-v2ray или аналог (опционально)
- Настройка через .env, применяется ТОЛЬКО к TMDB, НЕ к AI
- Health check при старте, retry через 5с при ошибке

---

## Docker

- Один контейнер: `node:20-alpine`
- Express раздаёт `client/` как static
- SQLite volume: `app-data:/data`
- Порт: 3000
- Запуск: `docker-compose up -d`

---

## Порядок реализации (рекомендуемый)

1. **Инфраструктура**: Dockerfile, docker-compose.yml, package.json, .env.example
2. **Backend-ядро**: index.js, db/database.js, schema.sql, middleware/auth.js
3. **Auth**: routes/auth.js, models/user.js
4. **TMDB-прокси**: services/tmdb.js (с прокси), routes/tmdb.js
5. **Списки**: models/listItem.js, routes/lists.js, routes/watched.js
6. **Frontend-ядро**: index.html, app.js (роутинг), api.js, ui.js, style.css
7. **Каталог**: movies.js — главная страница с табами и слайдером
8. **Страницы списков**: lists.js (хочу, смотрю, отложено)
9. **Просмотренные**: watched.js — оценки, фильтры, сортировка, статистика
10. **Детальная страница**: detail.js
11. **Поиск**: search.js с автодополнением
12. **ИИ-рекомендации**: services/ai.js, routes/recommendations.js, recommendations.js
13. **Профиль + статистика**: auth.js (профиль), stats.js
14. **Финальная полировка**: анимации, мобильная адаптация, тестирование
