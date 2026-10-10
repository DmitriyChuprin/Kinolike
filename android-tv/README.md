# KinoLike TV — этап 1

Нативный Android TV-клиент KinoLike без WebView и Google Play Services. Первый этап показывает каталог и метаданные; видеоплеер намеренно не включён.

## Возможности

- подключение к существующему серверу KinoLike по HTTPS;
- вход существующей учётной записью и восстановление `httpOnly` cookie-сессии;
- главная страница с фильмами, сериалами и Phantom-разделом «Продолжить просмотр»;
- подробности фильма и сериала, включая сезоны;
- управление D-pad/пультом, заметный фокус и TV-компоненты Compose;
- понятные состояния загрузки, сетевых ошибок и пустых выдач.

## Требования

- JDK 17;
- Android SDK Platform 37 и Build Tools 36;
- доступ к Google Maven и Maven Central при первой сборке;
- сервер KinoLike с корректным публичным HTTPS-сертификатом.

Минимальная версия клиента — API 23 (Android 6.0). Это не утверждение о версии Android конкретной модели SberBox: перед развёртыванием проверьте её командой `adb shell getprop ro.build.version.sdk`. Compose for TV поддерживает API 21+, но API 23 выбран как практический минимум для TLS и современных AndroidX-зависимостей.

## Сборка

Из каталога `android-tv/`:

```bash
./gradlew testDebugUnitTest assembleDebug
```

APK появится в `app/build/outputs/apk/debug/app-debug.apk`.

## Сборка APK в GitHub Actions

Workflow **KinoLike TV APK** собирает debug APK в облаке. Он запускается
автоматически при push в `main`, если изменились файлы в `android-tv/` или
`.github/workflows/android-tv.yml`. Его также можно запустить вручную:

1. Откройте репозиторий на GitHub и перейдите в **Actions**.
2. Выберите workflow **KinoLike TV APK**.
3. Нажмите **Run workflow**, выберите ветку и подтвердите запуск.
4. После успешной сборки откройте этот запуск и в разделе **Artifacts**
   скачайте `KinoLike-TV-debug`. В архиве находится
   `app-debug.apk`.

Артефакт хранится 30 дней. Workflow использует JDK 17, Android SDK Platform 37
и Build Tools 36.0.0; секреты для сборки не требуются и в репозиторий не
добавляются.

## Установка на SberBox

1. Включите режим разработчика и отладку по сети/ADB на приставке.
2. Узнайте IP-адрес SberBox и подключитесь:

```bash
adb connect 192.168.1.50:5555
adb devices
```

3. Установите или обновите приложение:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

4. Запустите «KinoLike TV» из TV launcher. При необходимости запуск можно проверить напрямую:

```bash
adb shell am start -n ru.kinolike.tv/.MainActivity
```

Для APK из GitHub Actions сначала распакуйте скачанный артефакт, затем укажите
путь к `app-debug.apk` в команде `adb install -r`. Ключ `-r` обновляет
приложение поверх установленного и сохраняет его данные: настройки сервера и
сессию. Не используйте `adb uninstall ru.kinolike.tv`, если данные нужно
сохранить. Если приложение было подписано другим ключом, Android потребует
сначала удалить старую версию; это удалит его локальные данные.

Удаление: `adb uninstall ru.kinolike.tv`.

## Сервер и авторизация

Клиент принимает только `https://` URL. Cleartext HTTP запрещён в network security config. Логин вызывает `POST /api/auth/login`; сервер устанавливает JWT в cookie `token` (`HttpOnly`, `SameSite=Lax`, 7 дней). Cookie хранится в private SharedPreferences приложения и передаётся OkHttp только подходящему HTTPS-host/path. На старте `GET /api/auth/me` проверяет сохранённую сессию.

Android-приложение не посылает браузерный заголовок `Origin`, поэтому CORS к нему неприменим. Backend также допускает unsafe Bearer/cookie-запросы без `Origin`; новые endpoints для TV не добавлялись.

## Использованные API

- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`;
- `GET /api/tmdb/trending/movie/week`;
- `GET /api/tmdb/movie/popular`;
- `GET /api/tmdb/trending/tv/week`;
- `GET /api/tmdb/movie/top_rated`;
- `GET /api/tmdb/{movie|tv}/{id}`;
- `GET /api/tmdb/image?path=...&size=...`;
- `GET /api/streaming/progress/continue`.

TMDB JSON используется в исходном контракте backend: `title`/`name`, `release_date`/`first_air_date`, `poster_path`, `backdrop_path`, `overview`, `vote_average`, `number_of_seasons`, `seasons`. Изображения всегда идут через KinoLike proxy, а не напрямую из TMDB.

## Ограничения этапа 1

- «Продолжить просмотр» сейчас основан на таблице/API Phantom. Jellyfin хранит UserData отдельно и не предоставляет общего списка продолжения через текущий KinoLike API.
- При недоступности endpoint прогресса раздел скрывается, но каталог остаётся рабочим.
- Регистрация, изменение списков, поиск и проигрывание не входят в этот этап.
- Сессия защищена sandbox приложения, но не аппаратным Keystore: backend-cookie является чувствительной и очищается при выходе/смене сервера.

## Следующий этап: Media3/ExoPlayer

Потребуются `androidx.media3` (ExoPlayer, HLS, UI), TV-оверлей управления и интеграция только с backend-прокси KinoLike:

- Phantom/VideoHUB: `check`, `voices`, `episodes`, `playback`, HLS proxy и `PUT /api/streaming/progress` с revision;
- Jellyfin: resolve/playback, выбор audio/subtitle tracks, lifecycle `session/start|progress|stop` и восстановление позиции;
- обработка токенизированных HLS URL, cookies/headers, ошибок источника, next episode и intro/credits segments.

Секреты Phantom, VideoHUB и Jellyfin должны оставаться на backend. Клиенту нельзя обращаться к этим сервисам напрямую.
