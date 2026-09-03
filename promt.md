Создай полнофункциональное веб-приложение для отслеживания фильмов и сериалов,
похожее на Кинопоиск. Данные хранятся на сервере в базе данных — localStorage
НЕ ИСПОЛЬЗУЕТСЯ. Раздел «Рекомендации» — ключевая фича, работает на основе
ИИ (OpenAI-compatible API). Раздел «Просмотренные» с системой оценок (1-10).
Всё запускается через Docker Compose.

---

## Технологии

### Frontend
- HTML5 + CSS3 + JavaScript (vanilla)
- CSS Grid / Flexbox
- Fetch API
- Шрифт: Inter / System UI
- Иконки: Lucide или SVG

### Backend
- Node.js + Express
- SQLite3 (better-sqlite3)
- Аутентификация: bcrypt + JWT
- CORS

### AI Integration
- OpenAI-compatible API (формат: base URL + API key + model name)
- Поддержка любых OpenAI-compatible провайдеров (OpenAI, OpenRouter, Ollama, etc.)
- Настройки AI в .env (base URL, API key, model name)
- AI вызывается ТОЛЬКО на сервере (через backend)

### API
- TMDB API v3 (проксируется через backend)

### Docker
- Docker Compose для запуска всего приложения
- Отдельный контейнер для backend (Node.js)
- Frontend раздаётся из контейнера backend (Express static)
- SQLite хранится в Docker volume
- Всё в одном docker-compose.yml

---

## Структура проекта

```
project/
├── client/                    # Frontend
│   ├── index.html
│   ├── css/
│   │   ├── style.css
│   │   ├── components.css
│   │   └── animations.css
│   └── js/
│       ├── app.js             # Роутинг (SPA hash-based)
│       ├── api.js             # Запросы к backend
│       ├── auth.js
│       ├── movies.js          # Каталог фильмов/сериалов
│       ├── lists.js           # Управление списками
│       ├── detail.js          # Детальная страница
│       ├── watched.js         # Раздел «Просмотренные» + оценки
│       ├── recommendations.js # Раздел «Рекомендации» (ИИ)
│       ├── stats.js           # Статистика
│       ├── search.js
│       └── ui.js              # Модалки, тосты, анимации
├── server/
│   ├── index.js               # Express entry point
│   ├── routes/
│   │   ├── auth.js
│   │   ├── lists.js
│   │   ├── tmdb.js            # Proxy к TMDB API
│   │   ├── recommendations.js # AI рекомендации
│   │   └── stats.js
│   ├── middleware/
│   │   └── auth.js            # JWT middleware
│   ├── services/
│   │   ├── ai.js              # AI сервис (OpenAI-compatible)
│   │   └── tmdb.js            # TMDB API обёртка
│   ├── models/
│   │   ├── user.js
│   │   ├── listItem.js
│   │   └── recommendation.js
│   ├── db/
│   │   ├── database.js
│   │   └── schema.sql
│   └── utils/
│       └── helpers.js
├── docker-compose.yml
├── Dockerfile
├── .env
├── package.json
└── README.md
```

---

## База данных (SQLite)

```sql
-- Пользователи
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_url TEXT DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Списки фильмов/сериалов
CREATE TABLE user_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'tv')),
  status TEXT NOT NULL DEFAULT 'want_to_watch'
    CHECK(status IN ('want_to_watch','watching','watched','on_hold')),
  rating INTEGER CHECK(rating IS NULL OR (rating >= 1 AND rating <= 10)),
  notes TEXT DEFAULT NULL,
  added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  watched_at DATETIME DEFAULT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, tmdb_id, media_type)
);

-- Кэш рекомендаций (чтобы не генерировать каждый раз заново)
CREATE TABLE recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'tv')),
  reason TEXT,
  score REAL,
  generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, tmdb_id, media_type)
);
```

---

## API Эндпоинты

### Аутентификация
- POST /api/auth/register { username, email, password }
- POST /api/auth/login { email, password } → JWT
- POST /api/auth/logout
- GET  /api/auth/me
- PUT  /api/auth/profile { username, email, avatar_url }

### Списки (JWT required)
- GET  /api/lists ?status=...&media_type=...&sort=...
- POST /api/lists { tmdb_id, media_type, status }
- PUT  /api/lists/:id { status, rating, notes, watched_at }
- DELETE /api/lists/:id
- GET  /api/lists/export → JSON
- POST /api/lists/import { json }

### Просмотренные (специализированные)
- GET  /api/watched ?sort=rating|added_at|year&genre=...&year=...
- PUT  /api/watched/:id/rate { rating (1-10), notes, watched_at }
- GET  /api/watched/stats → статистика

### Рекомендации (ИИ, JWT required)
- GET  /api/recommendations ?refresh=true&type=movie|tv&limit=20
- POST /api/recommendations/generate
- DELETE /api/recommendations/cache

### Статистика
- GET  /api/stats/overview

### TMDB Proxy
- GET  /api/tmdb/search?query=...&type=movie|tv
- GET  /api/tmdb/movie/popular
- GET  /api/tmdb/movie/:id
- GET  /api/tmdb/movie/:id/credits
- GET  /api/tmdb/movie/:id/similar
- GET  /api/tmdb/movie/:id/videos
- GET  /api/tmdb/tv/popular
- GET  /api/tmdb/tv/:id
- GET  /api/tmdb/tv/:id/credits
- GET  /api/tmdb/tv/:id/similar
- GET  /api/tmdb/tv/:id/videos
- GET  /api/tmdb/genres
- GET  /api/tmdb/genres/movie
- GET  /api/tmdb/genres/tv

---

## Интеграция ИИ (OpenAI-compatible)

### Конфигурация (.env)
- AI_BASE_URL=https://api.openai.com/v1
- AI_API_KEY=***
- AI_MODEL=gpt-4o
- AI_TEMPERATURE=0.7
- AI_MAX_TOKENS=***
- AI_TIMEOUT=30
- AI_RECOMMENDATIONS_LIMIT=20
- AI_CACHE_TTL=24

### Как работает AI сервис (server/services/ai.js)

1) Собираем данные пользователя:
   - Все просмотренные фильмы/сериалы (из user_lists WHERE status = 'watched')
   - Оценки пользователя (rating)
   - Жанры из TMDB (tmdb_id → TMDB genres)
   - Названия, описания, годы

2) Формируем промпт для AI:

   System prompt:
   "Ты — кинорекомендатель. На основе списка просмотренных фильмов и сериалов
    пользователя с их оценками, рекомендуй 15-20 новых фильмов/сериалов,
    которые ему могут понравиться. Рекомендации должны быть на основе:
    - Жанров (предпочитаемые жанры)
    - Оценок (что оценено высоко/низко)
    - Стиля и настроения (драмы, комедии, триллеры и т.д.)
    - Акторов и режиссёров

    Формат ответа — JSON массив объектов:
    [
      {
        "tmdb_id": 123,
        "media_type": "movie",
        "reason": "Причина рекомендации (на русском, 2-3 предложения)",
        "score": 9.5
      }
    ]

    Важно:
    - tmdb_id — реальный ID фильма/сериала из TMDB
    - media_type — 'movie' или 'tv'
    - reason — текст на русском языке
    - score — уверенность в рекомендации (0-10)
    - НЕ включай фильмы/сериалы, которые пользователь уже смотрел
    - Основывайся на TMDB ID из TMDB API"

   User prompt:
   "Пользователь посмотрел следующие фильмы/сериалы (с оценками):
    1. Film A (movie, оценка 9) — жанры: драма, триллер
    2. TV Show B (tv, оценка 8) — жанры: комедия
    3. Film C (movie, оценка 5) — жанры: фантастика
    ...
    Рекомендуй что-то, что он ещё не смотрел."

3) Отправляем запрос к AI API (POST к AI_BASE_URL/chat/completions)
4) Получаем ответ → парсим JSON
5) Сохраняем в таблицу recommendations (кэш)
6) Возвращаем список рекомендаций клиенту

### Кэширование рекомендаций
- Кэш хранится в recommendations (в БД)
- Время жизни кэша: 24 часа (AI_CACHE_TTL)
- При запросе GET /api/recommendations:
  • Если кэш есть и не истёк → возвращаем из кэша
  • Если кэш нет или истёк → генерируем заново
  • Принудительная регенерация: ?refresh=true
- При добавлении/удалении из «Просмотренных» — инвалидировать кэш

### Обработка ошибок AI
- Таймаут запроса (30 сек)
- Некорректный JSON → повторная попытка (1 раз)
- Ошибка API → сообщение пользователю «Не удалось сгенерировать рекомендации»
- Rate limit → повтор через 10 сек

---

## Дизайн (стиль Кинопоиск)

### Цветовая схема (тёмная тема по умолчанию)
- Основной фон:      #111113
- Карточки:          #1a1a2e
- Акцент 1:          #e50914 (красный)
- Акцент 2:          #7b2ff7 (фиолетовый)
- ИИ-акцент:         #00d4aa (бирюзовый — для «Рекомендации»)
- Текст:             #ffffff
- Текст вторичный:   #a0a0b0
- Успех:             #4caf50
- Предупреждение:    #ff9800
- Ошибка:            #f44336

### Цветовая схема (светлая тема по переключателю)
- Основной фон:      #f5f5f5
- Карточки:          #ffffff
- Акцент 1:          #e50914
- Текст:             #222222

### Сетка карточек
- Десктоп: 4–5 колонок
- Планшеты: 3 колонки
- Мобильные: 2 колонки

### Хедер
- Логотип: «Мой киноплан» (иконка + текст)
- Навигация (горизонтальная, адаптивная):
  • Главная
  • Хочу посмотреть
  • Смотрю
  • Просмотренные
  • Отложено
  • Рекомендации
- Поле поиска с автодополнением (debounce 300ms)
- Кнопка аккаунта (выпадающее меню: Профиль, Статистика, Настройки, Выйти)
- Кнопка переключения тёмная/светлая тема

### Навигация
- SPA (роутинг через hash или History API)
- Переходы между страницами — анимация fade / slide
- Боковое меню на мобильных (гамбургер)
- Хлебные крошки на детальной странице

---

## Страницы

### 1. КАТАЛОГ (Главная)
- Слайдер популярных фильмов/сериалов (TMDB)
- Табы: «Фильмы» / «Сериалы»
- Секции:
  • «Популярные» (самые рейтинговые)
  • «Сейчас в кинотеатрах» (now_playing / on_the_air)
  • «Новинки» (recently released)
  • «Похожие на то, что вы смотрите» (персонализированные, на основе списка пользователя)
- Карточки с постером, названием, рейтингом, годом

### 2. ХОЧУ ПОСМОТРЕТЬ
- Отдельная страница со списком фильмов/сериалов в статусе «want_to_watch»
- Фильтрация: по типу (movie/tv), жанру, году
- Сортировка: по дате добавления, рейтингу TMDB, году
- Счётчик: сколько в списке
- Переключение статуса (например, «Начать смотреть» → «watching»)
- Экспорт/импорт списка

### 3. СМОТРЮ
- Список фильмов/сериалов в статусе «watching»
- Фильтрация и сортировка как в «Хочу посмотреть»
- Кнопка «Пометить как просмотренное» (статус → «watched»)

### 4. ПРОСМОТРЕННЫЕ (раздел с оценками) — КЛЮЧЕВАЯ ФИЧА
- Отдельная страница с просмотренными фильмами/сериалами
- Каждый элемент показывает:
  • Постер, название, год
  • Статус: «Просмотрено»
  • Личная оценка (1-10) — отображается числом и/или звёздочками
  • Дата просмотра
  • Заметка/отзыв (раскрывается при клике)
- Система оценок:
  • Оценка 1-10 (число + визуальная шкала / звёзды)
  • Цветовая маркировка:
    - 9-10 — ярко-зелёный (отлично)
    - 7-8 — зелёный (хорошо)
    - 5-6 — жёлтый (средне)
    - 3-4 — оранжевый (плохо)
    - 1-2 — красный (ужасно)
  • Оценка ставится через клик на шкалу или ввод числа
- Сортировка:
  • По оценке (от высокой к низкой, от низкой к высокой)
  • По дате просмотра
  • По году
  • По рейтингу TMDB
- Фильтрация:
  • По типу (movie/tv)
  • По жанру
  • По году
  • По диапазону оценки (например, только 8-10)
- Статистика на странице:
  • Общее количество просмотренных
  • Средняя оценка
  • Количество фильмов / сериалов раздельно
  • Топ жанров

---

### 5. ОТЛОЖЕНО
- Список в статусе «on_hold»
- Фильтрация и сортировка

### 6. РЕКОМЕНДАЦИИ (ИИ) — КЛЮЧЕВАЯ ФИЧА
- Отдельная страница с заголовком: «Рекомендации на основе ваших просмотренных фильмов»
- Акцентный цвет: бирюзовый (#00d4aa)
- Наверху — статус генерации (загрузка... / сгенерировано / ошибка)
- Кнопка «Обновить рекомендации»
- Список рекомендаций — карточки с:
  • Постером (загружается по tmdb_id)
  • Названием (русское + оригинальное)
  • Годом
  • Рейтингом TMDB
  • Жанрами
  • Причина рекомендации (от ИИ, на русском, 2-3 предложения)
  • Оценка ИИ (confidence score 0-10, визуально)
  • Кнопки: «Хочу посмотреть», «Смотрю», «Просмотрено», «Отложить»
- Рекомендации делятся на секции:
  • «Рекомендации на основе ваших оценок»
  • «Популярные у пользователей с похожим вкусом» (если AI даёт)
  • «Новые для вас» (жанры, которые пользователь редко смотрит)
- При первом входе:
  • Если ни одного просмотренного нет → сообщение:
    «Добавьте несколько просмотренных фильмов или сериалов,
     чтобы получить персонализированные рекомендации»
  • Если есть просмотры → начать генерацию
- Анимация: карточки появляются по очереди (ступенчатый fade-in, 0.15s задержка)
- Кнопка «Пометить как просмотренное» — прямой переход в статус «watched» с полем оценки

### 7. ДЕТАЛЬНАЯ СТРАНИЦА ФИЛЬМА/СЕРИАЛА
- Большой постер + backdrop (фоновое изображение)
- Название (русское + оригинальное)
- Год, длительность (фильм) / количество сезонов/серий (сериал)
- Рейтинг TMDB (цветовая индикация)
- Список жанров
- Описание (полное)
- Бюджет, сборы (фильм, если есть)
- Актёрский состав (топ-10, из TMDB credits)
- Ссылка на TMDB
- Кнопки статусов: «Хочу посмотреть», «Смотрю», «Просмотрено», «Отложить»
- Для статуса «Просмотрено»:
  • Поля для оценки 1-10 (шкала / звёзды)
  • Поле для заметки/отзыва
  • Дата просмотра (автоматически или ручная)
- Похожие фильмы/сериалы (TMDB similar)
- Трейлер (YouTube embed, из TMDB videos)

### 8. ПРОФИЛЬ
- Имя пользователя, email, аватар (URL или загрузка)
- Статистика:
  • Всего в списке
  • Хочу посмотреть
  • Смотрю
  • Просмотрено
  • Отложено
  • Средняя оценка
  • Топ жанров
- Настройки:
  • Обновление имени, email
  • Смена пароля
  • Переключение темы
- Экспорт/импорт списка (JSON)

### 9. ПОИСК
- Результаты поиска с фильтрами (год, жанр, рейтинг)
- Постеры, название, год, рейтинг TMDB, жанры
- Пагинация (бесконечный скролл или кнопка «Загрузить ещё»)

---

## UI-компоненты

### Карточка фильма/сериала
- Постер (TMDB w342/w500)
- Название (русское + оригинальное)
- Год
- Рейтинг TMDB (зелёный >7, жёлтый 5-7, красный <5)
- Жанры (до 3-4)
- Краткое описание (до 150 символов, расширение по клику)
- Статусная кнопка (Хочу посмотреть / Смотрю / Просмотрено / Отложить)
- Кнопка «Подробнее»
- Анимация: fade-in при появлении, scale при наведении

### Модальное окно добавления
- При нажатии на кнопку статуса — мини-модалка:
  • Выбор статуса
  • Если «Просмотрено» — поля оценки (1-10) и заметки
  • Кнопка «Сохранить»

### Тост-уведомления
- Toast-сообщения внизу экрана (успех: зелёный, ошибка: красный)
- Автоскрытие через 3 секунды

### Шкала оценок
- Шкала 1-10 (число + визуальная полоса или звёзды)
- Выбранная оценка — цветом показывает качество
- Автосохранение при изменении

### Табы (фильтрация статусов)
- Табы вверху страницы списков
- Каждый таб — бейдж с количеством
- Активный таб — подсвечен

### Сортировка
- Выпадающее меню:
  • Дата добавления (новые/старые)
  • Рейтинг TMDB (высокий/низкий)
  • Год (новые/старые)
  • Личная оценка (высокая/низкая)

### Поиск с автодополнением
- Поле поиска в хедере
- Автодополнение (debounce 300ms)
- Результаты — мини-карточки (постер + название + год)
- Клик на результат → детальная страница

---

## Анимации

- Появление карточек: fade-in + slide-up (0.3s)
- Наведение на карточку: scale 1.02, з тенью
- Переходы между страницами: fade + slide (0.3s)
- Удаление карточки: fade-out + slide-up
- Модальные окна: fade-in + scale от 0.95
- Тост-уведомления: slide-up + fade
- Табы: плавная подсветка active
- Рекомендации: ступенчатый fade-in карточек (по одному с задержкой 0.15s)
- Индикатор загрузки рекомендаций: пульсация или спиннер

---

## Обработка ошибок

- Таймауты API: TMDB 5с, AI 30с
- 404 — «Не найдено»
- 500 — «Ошибка сервера»
- Нет соединения — «Проверьте подключение к интернету»
- Валидация формы регистрации/входа
- Защита от SQL-инъекций (параметризованные запросы)
- Защита от XSS (экранирование вывода)
- Rate limiting на API
- CORS: разрешить только фронтенд
- JWT: проверка на каждом защищённом эндпоинте
- Ошибка AI: повтор 1 раз, сообщение «Не удалось сгенерировать рекомендации»

---

## Проксирование запросов к TMDB

### Конфигурация прокси (.env)
- TMDB_PROXY_ENABLED=true|false
- TMDB_PROXY_TYPE=socks5|vless
- TMDB_PROXY_HOST=127.0.0.1
- TMDB_PROXY_PORT=1080
- TMDB_PROXY_USERNAME=
- TMDB_PROXY_PASSWORD=
- TMDB_PROXY_VLESS_UUID=
- TMDB_PROXY_VLESS_ADDRESS=your-domain.com
- TMDB_PROXY_VLESS_PORT=443
- TMDB_PROXY_VLESS_PATH=
- TMDB_PROXY_VLESS_TLS=true|false
- TMDB_PROXY_VLESS_FLOW=... (optional, e.g. "xtls-rprx-vision")

### Как работает прокси

1) Для SOCKS5:
   - Используется библиотека socks-proxy-agent
   - Все запросы к TMDB API проходят через SOCKS5 прокси
   - Поддержка аутентификации (username/password)

2) Для VLESS:
   - Используется библиотека vmess/vless proxy (node-v2ray или аналог)
   - Илиisis прямой TCP через socks5/h2 (зависит от реализации)
   - Поддержка TLS
   - UUID для аутентификации

3) Настройка прокси в backend:
   - Через .env переменные
   - Прокси применяется ТОЛЬКО к запросам к TMDB API
   - Запросы к AI API НЕ проксируются
   - Запросы к пользовательскому фронтенду НЕ проксируются

4) Реализация в server/services/tmdb.js:
   - Динамическое подключение прокси при старте сервера
   - Проверка прокси (health check) при запуске
   - Логирование: «Прокси подключен: socks5://host:port» или «Прокси отключен»
   - Ошибка прокси: повторный запрос через 5 секунд, затем ошибка

### Пример конфигурации прокси в .env
```
# --- Proxy for TMDB requests ---
TMDB_PROXY_ENABLED=true
TMDB_PROXY_TYPE=socks5
TMDB_PROXY_HOST=127.0.0.1
TMDB_PROXY_PORT=1080
TMDB_PROXY_USERNAME=
TMDB_PROXY_PASSWORD=

# --- Or VLESS proxy ---
# TMDB_PROXY_ENABLED=true
# TMDB_PROXY_TYPE=vless
# TMDB_PROXY_VLESS_UUID=uuid-here
# TMDB_PROXY_VLESS_ADDRESS=your-domain.com
# TMDB_PROXY_VLESS_PORT=443
# TMDB_PROXY_VLESS_TLS=true
# TMDB_PROXY_VLESS_FLOW=xtls-rprx-vision
```

### Зависимости для прокси
- "socks-proxy-agent": "^8.0.0" (для SOCKS5)
- Дополнительные библиотеки для VLESS (node-v2ray или аналогичные)

---
---

## Конфигурация (.env)

```
# Server
PORT=3000
DB_PATH=/data/app.db

# TMDB
TMDB_API_KEY=***

# JWT
JWT_SECRET=***

# AI (OpenAI-compatible)
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=***
AI_MODEL=gpt-4o
AI_TEMPERATURE=0.7
AI_MAX_TOKENS=***
AI_TIMEOUT=30
AI_RECOMMENDATIONS_LIMIT=20
AI_CACHE_TTL=24

# Proxy for TMDB
TMDB_PROXY_ENABLED=true
TMDB_PROXY_TYPE=socks5
TMDB_PROXY_HOST=127.0.0.1
TMDB_PROXY_PORT=1080
TMDB_PROXY_USERNAME=
TMDB_PROXY_PASSWORD=***
# Or VLESS
# TMDB_PROXY_TYPE=vless
# TMDB_PROXY_VLESS_UUID=***
# TMDB_PROXY_VLESS_ADDRESS=your-domain.com
# TMDB_PROXY_VLESS_PORT=443
# TMDB_PROXY_VLESS_TLS=true
```

---

## Docker Compose

### docker-compose.yml
```yaml
version: '3.8'

services:
  app:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - app-data:/data
    env_file:
      - .env
    restart: unless-stopped

volumes:
  app-data:
```

### Dockerfile
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server/ ./server/
COPY client/ ./client/
EXPOSE 3000
CMD ["node", "server/index.js"]
```

### Запуск
```
docker-compose up -d
```

---

## Зависимости (package.json)

```json
{
  "name": "my-kino-plan",
  "version": "1.0.0",
  "scripts": {
    "start": "node server/index.js",
    "dev": "nodemon server/index.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "bcryptjs": "^2.4.3",
    "jsonwebtoken": "^9.0.0",
    "better-sqlite3": "^9.4.3",
    "cors": "^2.8.5",
    "dotenv": "^16.3.1",
    "helmet": "^7.1.0",
    "express-rate-limit": "^7.1.0",
    "openai": "^4.0.0",
    "node-fetch": "^3.3.0",
    "socks-proxy-agent": "^8.0.0"
  },
  "devDependencies": {
    "nodemon": "^3.0.0"
  }
}
```

---

## Важные условия

1. Все данные — SQLite (на сервере), localStorage НЕ используется
2. API ключ TMDB — ТОЛЬКО на сервере (проксируется через backend)
3. JWT — для аутентификации (хранится на клиенте в localStorage или httpOnly cookie)
4. Локализация — русский язык, все тексты на русском
5. Адаптивный дизайн (мобильные, планшеты, десктоп)
6. Тёмная тема по умолчанию, светлая по переключателю
7. Код чистый, комментированный
8. Без сборщиков (без webpack/vite) — проект работает напрямую
9. Всё в одном проекте, можно запустить одной командой (docker-compose up)
10. Сайт полноценный, похожий на Кинопоиск
11. Раздел «Просмотренные» — ключевой: с оценками 1-10, статистикой, фильтрацией и сортировкой
12. Раздел «Рекомендации» — ключевой: ИИ (OpenAI-compatible), кэширование, персонализация
13. Проксирование TMDB запросов — через SOCKS5 или VLESS (настраивается в .env)
14. Docker Compose — для запуска всего приложения
15. SQLite хранится в Docker volume (данные не теряются при перезапуске)
16. Все запросы к TMDB проходят через backend proxy (API ключ не виден клиенту)
17. AI вызывается только на сервере (API ключ не виден клиенту)
18. Кэш рекомендаций — 24 часа, инвалидируется при изменении просмотров
