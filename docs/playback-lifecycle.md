# Диагностика playback lifecycle

Проверено для настроенного Jellyfin Server 10.11.8.

## Найденная причина

До исправления Artplayer получал не URL TorrServer, а same-origin URL вида
`/api/streaming/jellyfin/proxy?path=...`. Backend создавал этот URL из ответа
Jellyfin `PlaybackInfo` (`MediaSources[].TranscodingUrl` либо `/Videos/.../stream`).

`PlaybackInfo` и `PlaySessionId` уже создавались, но KinoLike не отправлял
официальные Jellyfin-события `Sessions/Playing`, `Sessions/Playing/Progress` и
`Sessions/Playing/Stopped`. При закрытии плеера `hls.js` уничтожался не во всех
ветках, native/direct media resource не освобождался, а proxy использовал
`mediaStream.pipe(res)` без отмены upstream `fetch` при разрыве браузерного
соединения.

Следовательно, подтверждённая по коду утечка потребителя находилась в цепочке
Browser → KinoLike proxy → Jellyfin. Jellyfin продолжал читать STRM, а для
TorrServer это выглядело как всё ещё активный streaming consumer. Доказательств,
что TorrServer после закрытия Jellyfin → TorrServer сам продолжает именно
активную трансляцию, нет, поэтому TorrServer-specific Stop/Delete не добавлялся.

## Новая последовательность

1. Backend валидирует item и получает Jellyfin `PlaybackInfo`.
2. Сервер сохраняет привязанную к KinoLike user/client запись playback session.
3. После фактического `video:play/playing` отправляется Jellyfin Playing.
4. Каждые 15 секунд и на pause/seek отправляется Progress; позиция сохраняется.
5. Единый `stopPlayback(reason)` синхронно освобождает media и идемпотентно
   вызывает backend STOP.
6. Backend берёт ItemId/MediaSourceId/deviceId из своей записи, а не доверяет
   этим значениям из браузера, и отправляет Jellyfin Playing/Stopped.
7. При отсутствии heartbeat 3 минуты watchdog безопасно закрывает сессию.

## Runtime-проверка соединений

Для временной расширенной диагностики установить `PLAYBACK_DEBUG=true` и
перезапустить KinoLike. В логах ожидаются:

```text
[Playback]
START
Item: ...
PlaySessionId: ...

[Playback]
HLS destroyed

[Playback]
STOP
Reason: player-close
Position: ...
PlaySessionId: ...

[Playback]
Jellyfin stop sent
Session closed
```

При отмене незавершённого media request backend также пишет, что соединение
Browser → Jellyfin proxy закрыто и upstream aborted. После этого нужно сверить
логи/активные устройства Jellyfin: у данного PlaySessionId не должно быть
активного playback и Jellyfin не должен держать HTTP-соединение к URL из STRM.
В TorrServer торрент должен оставаться в списке, но его активный streaming
consumer и скорость отдачи должны исчезнуть после освобождения уже выданного
буфера.

## Проверка resume и seek для STRM

`JELLYFIN_USER_TOKEN` в `.env` должен быть access token того Jellyfin-пользователя,
который смотрит через KinoLike. Это не administrative API key: Jellyfin может
принять lifecycle event, авторизованный API key, но не обновить
`UserData.PlaybackPositionTicks`. Токен не выводится в логи и используется
только для `Playing`, `Progress`, `Stopped` и чтения UserData.

Включить `PLAYBACK_DEBUG=true`. Для resume на 00:10:00 в логе должны быть
ровно следующие существенные признаки:

```text
Resume:
Jellyfin ticks: 6000000000
Seconds: 600
Requested start: 00:10:00
```

Следующий `PlaybackInfo` должен содержать query-параметр
`StartTimeTicks=6000000000` (и `IsPlayback=true`), а не только последующий
browser seek. Для HLS `StartTimeTicks` является единственным механизмом
первичного resume: `video.currentTime` после создания нового потока не
устанавливается. `Progress` и `Stopped` прибавляют начальное смещение HLS,
поэтому в Jellyfin сохраняется абсолютная позиция фильма.

Прогнать один STRM-фильм с 00:00:00, 00:05:00, 00:30:00 и 01:00:00, затем
проверить seek 00:05→00:30, 00:30→01:00 и 01:00→00:15. В Network сравнить
`PlaybackInfo`, `MediaSourceId`, `PlaySessionId`, выбранные дорожки, HLS URL
и Range у proxy с Jellyfin Web. При реальном закрытии должен быть один
`PlaybackStopped` для соответствующего `PlaySessionId`; у старого generation
нет права остановить новый generation.

Проверить отдельно: крестик/overlay/Escape, переход и Back, reload/закрытие
вкладки, смену дорожки, фильм → фильм, серию → серию, autoplay следующей серии,
`ended` и потерю frontend (watchdog через 3–4 минуты). После обычной остановки
повторное открытие должно предлагать сохранённую позицию; после `ended` позиция
для продолжения очищается.
