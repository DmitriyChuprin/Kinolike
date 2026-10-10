# Интеграция IMDb

TMDB остаётся основным источником названий, описаний, постеров, биографий и
каталожных объектов KinoLike. IMDb используется только для стабильных внешних
ID, рейтинга, количества голосов и дополнительного индекса фильмографии.

Источник — только [IMDb Non-Commercial Datasets](https://developer.imdb.com/non-commercial-datasets/):

- `name.basics.tsv.gz`;
- `title.principals.tsv.gz`;
- `title.basics.tsv.gz`;
- `title.ratings.tsv.gz`.

У `title.principals` есть важное ограничение: набор содержит principal cast/crew,
а не каждый credit с сайта IMDb. Поэтому страница персоны объединяет полный
список TMDB credits с доступными IMDb principal credits. Scraping не используется.

## Связывание

Персоны связываются только по цепочке:

```text
TMDB person_id -> /person/{id}/external_ids -> IMDb nm...
```

Локальные фильмы и сериалы получают `tt...` через TMDB external IDs. IMDb-only
работа разрешается через точный TMDB `/find/{tt...}?external_source=imdb_id`.
Имя человека и название фильма не используются для автоматического связывания.
Если TMDB не вернул единственный результат, связь не создаётся.

## Хранение и производительность

- `media_metadata` остаётся единственной локальной сущностью фильма/сериала;
- `people` хранит мост TMDB person ID <-> IMDb name ID;
- `imdb_titles` — вспомогательный индекс только экранных типов без дублирования
  TMDB-постеров и описаний;
- `imdb_ratings` — компактный полный snapshot `title.ratings`, который можно
  обновлять ежедневно независимо от тяжёлого индекса фильмографии;
- `person_credits` — индекс актёрских principal credits по `imdb_person_id`;
- `imdb_import_runs` и `imdb_dataset_files` содержат журнал и HTTP validators.

Файлы читаются через `createReadStream -> gunzip -> readline`. Данные поступают
в `UNLOGGED` staging-таблицы пакетами через PostgreSQL `UNNEST`, затем одним
транзакционным merge/upsert заменяют рабочий snapshot. До успешного чтения всех
четырёх файлов рабочие таблицы не удаляются и не изменяются. PostgreSQL advisory
lock не допускает параллельные импорты.

Повторная загрузка использует `ETag` и `Last-Modified`. Если сервер не даёт
валидатор, загруженный файл сравнивается по SHA-256. Импорт идемпотентен, а
исчезнувшие из очередного полного snapshot записи удаляются только внутри
успешной финальной транзакции.

Частый импорт рейтингов идёт отдельно через `imdb_rating_staging`: файл читается
потоково, валидные строки поступают в PostgreSQL пакетами через `UNNEST`, затем
одна транзакция выполняет upsert snapshot и обновляет локальный read-cache в
`media_metadata`. Поэтому рекомендации не делают сетевых запросов и не создают
N+1. Если рейтинг связанного тайтла изменился, кэш рекомендаций инвалидируется
в той же транзакции и будет безопасно рассчитан заново. Незавершённая загрузка
или ошибка parsing/БД не меняет рабочие рейтинги.

## Рекомендации

```text
IMDb confidence = min(log10(votes + 1) / 6, 1) * 100
IMDb quality    = (rating / 10) * IMDb confidence
```

В фоновой персональной выдаче базовые положительные веса: personal match 45%,
IMDb quality 15%, IMDb confidence 10%, mainstream 10%, similarity 10%, TMDB
quality 5% и TMDB vote confidence 5%. В AI-поиске сохраняется отдельный вес
query match. Если IMDb отсутствует, его вес пропорционально перераспределяется
между доступными сигналами; тайтл не исключается.

Для обычного запроса IMDb confidence участвует в ранжировании и mainstream
composition. Для `prefer_hidden_gems` (включая «малоизвестный», «редкий»,
«нишевый») его вес почти отключается, а существующие пороги ослабляются. Возраст
не входит в общий quality/mainstream score: эпоха учитывается только при явном
запросе нового/классики или как изученное предпочтение пользователя.

## Известные работы

Для каждого доступного показателя вычисляется нормализованная компонента:

```text
R  = clamp(IMDb rating / 10)
IV = min(1, log10(IMDb votes + 1) / 6)
TV = min(1, log10(TMDB vote_count + 1) / 6)
P  = min(1, log10(TMDB popularity + 1) / 3)
K  = 1 для known_for, иначе 0

work_score = 100 * (0.45R + 0.25IV + 0.15TV + 0.10P + 0.05K)
```

Вес отсутствующего числового источника перераспределяется между доступными
компонентами. Логарифмическая нормализация голосов не позволяет работе с очень
малым числом голосов обойти массово оценённую работу только за счёт rating.

## Запуск

Первоначальная загрузка и последующее ручное обновление выполняются одной
идемпотентной командой:

```bash
npm run update-imdb-data
```

Ежедневное обновление только рейтингов:

```bash
npm run update-imdb-ratings
```

Полезные параметры:

```bash
npm run update-imdb-data -- --skip-download
npm run update-imdb-data -- --force-import
npm run update-imdb-data -- --resolve-limit=1000
```

`--skip-download` читает ранее сохранённые файлы из `IMDB_DATA_DIR`.
`--force-import` заново строит snapshot даже при неизменившихся HTTP validators.

Для встроенного периодического обновления рейтингов:

```dotenv
IMDB_AUTO_UPDATE=true
IMDB_UPDATE_INTERVAL_HOURS=24
IMDB_UPDATE_INITIAL_DELAY_MINUTES=10
```

В Docker Compose каталог datasets хранится в отдельном volume `imdb-data`, а
таблицы — в существующем PostgreSQL volume. Для полной начальной загрузки нужно
предусмотреть несколько гигабайт диска под gzip-файлы, staging и индексы БД.

Альтернатива встроенному scheduler — cron (бизнес-логика остаётся в CLI):

```cron
30 3 * * * cd /path/to/kinolike && npm run update-imdb-ratings >> /var/log/kinolike-imdb.log 2>&1
```

Проверка importer на малом snapshot:

```bash
npm run test:imdb-integration
```

Этот тест следует запускать только с отдельной тестовой PostgreSQL: импорт
считает переданные fixtures полным IMDb snapshot.
