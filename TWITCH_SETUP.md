# TWITCH_SETUP

Точные значения из текущего состояния репозитория: взяты из кода, из собранного
бандла и из реально пойманных сетевых запросов, а не из общих соображений. Там,
где чего-то **нет**, это написано прямым текстом.

Цель этого файла — Twitch **Local Test**. Hosted Test здесь не настраивается.

---

## 0. Что нужно сделать один раз

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-certs.ps1
```

Ставит доверенный localhost-сертификат (нужен `mkcert`, см. раздел 3). Дальше:

```bash
docker compose up -d --build
```

И всё. Vite, API, Postgres, Redis поднимаются одной командой; отдельно ничего
на Windows запускать не надо.

---

## 1. Что пакуется в Twitch Extension ZIP

| | |
| --- | --- |
| Источник | `web/dist/` (результат `vite build`) |
| Скрипт упаковки | `web/scripts/build-extension.mjs` |
| Промежуточная папка | `web/extension-build/` (пересоздаётся при каждом запуске) |
| Готовый архив | `web/twitch-extension.zip` |

Список файлов берётся из **манифеста Vite** (`dist/.vite/manifest.json`), а не
из разбора HTML. Это принципиально: Mapbox-воркер подключается из JavaScript
через `new URL('mapbox-gl-csp-worker-*.js', import.meta.url)` и ни в одном теге
не встречается — при разборе HTML он бы молча не попал в ZIP, и карта на Twitch
просто не запустилась бы.

В архив входят три Twitch-поверхности и всё, что они импортируют. Остальные
(`admin`, `dev`, `obs`, `streamer`, `index`) собираются в тот же `web/dist/`, но
в ZIP **не попадают**.

Текущий архив — 18 файлов, 0.84 МБ:

```
video_overlay.html
mobile.html
config.html
assets/video_overlay-*.js   assets/mobile-*.js   assets/config-*.js
assets/App-*.js  assets/App-*.css
assets/twitch-*.js  assets/api-*.js  assets/format-*.js
assets/theme-*.js   assets/theme-*.css
assets/mapbox-*.js  assets/mapbox-*.css
assets/mapbox-gl-csp-worker-*.js     ← без него карта не стартует
assets/config-*.css  assets/index-*.css
```

Хеши меняются при каждой пересборке — сверяйся со свежим ZIP.

HTML лежат **в корне** архива, и все ссылки на ассеты относительные
(`./assets/...`) благодаря `base: './'`. Скрипт упаковки падает, если находит
абсолютный путь: Twitch раздаёт ZIP из под-каталога, и `/assets/...` там
ведёт в никуда.

---

## 2. Пути в Developer Console → Extension → Asset Hosting

| Поле в консоли | Значение |
| --- | --- |
| **Video - Fullscreen Path** | `video_overlay.html` |
| **Mobile Path** | `mobile.html` |
| **Config Path** | `config.html` |
| **Live Config Path** | *(пусто)* |
| Video - Component Path | не используется |
| Panel Path | не используется |

Совпадает с тем, что уже выставлено в консоли.

### video_overlay.html

Прозрачный fullscreen overlay. В свёрнутом состоянии на видео не рисуется
**ничего**, кроме невидимой кликабельной зоны ровно над мини-картой, которую
OBS вжигает в кадр: `left 1.5% / bottom 4% / width 19.5% / height 30%`. Проверено
в браузере — при 1024px ширины зона получилась 15px слева, 31px снизу, 200×230.

Корневой элемент имеет `pointer-events: none`, поэтому клики мимо зоны уходят в
плеер Twitch. Карта Mapbox **не создаётся**, пока оверлей свёрнут (проверено:
`canvas.mapboxgl-canvas` = 0 до раскрытия, 1 после), так что закрытая карта не
нагружает и не перехватывает плеер.

Геометрия зоны — контракт с OBS: `--hit-*` в `web/src/viewer/viewer.css` и
`--mm-*` в `web/src/obs/obs.css` должны меняться вместе.

### mobile.html

Отдельная поверхность, а не копия десктопной. Своя точка входа
(`web/src/mobile/main.tsx`) и свои стили (`web/src/mobile/mobile.css`):
непрозрачный фон, карта во весь экран без отступа под контролы плеера, targets
от 48px, `font-size: 16px` в поле поиска (иначе iOS Safari зумит страницу),
`env(safe-area-inset-*)`, отдельная раскладка для ландшафта.

Логика и контракт с бэкендом общие с оверлеем — переиспользуется `viewer/App`
с флагом `forceMobile`.

### config.html

Поверхность владельца канала. Только чтение: бэкенд, авторизация Twitch,
Channel ID, GPS, Mapbox, приём точек и слоты — плюс ссылка на полную
админ-панель.

Данные приходят из `GET /api/ext/broadcaster/status`, который требует ext-JWT с
`role === 'broadcaster'` и отдаёт **только булевы значения и счётчики**: ни
токена, ни секрета, ни координат. Проверено: с токеном зрителя → `403`.

---

## 3. Testing Base URI

```
https://localhost:8080/
```

Работает. `docker compose up -d --build` поднимает Vite по HTTPS на 8080 внутри
контейнера `web`; он же проксирует `/api` и `/socket.io` на контейнер `api`,
поэтому расширение, REST и `wss://` живут на одном доверенном origin, и
смешанного контента нет.

### Сертификат

Нужен `mkcert` — **один раз**:

```powershell
winget install FiloSottile.mkcert
```

Затем в новом терминале:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-certs.ps1
docker compose up -d --force-recreate web
```

Скрипт делает `mkcert -install` (ставит локальный CA в хранилище Windows) и
выпускает пару в `certs/`. Директория в `.gitignore` целиком — приватный ключ
никогда не коммитится.

**Почему именно mkcert, а не самоподписанный сертификат.** Twitch открывает
расширение в iframe, а браузер не станет встраивать страницу с недоверенным
сертификатом — экрана «всё равно продолжить» для фрейма не существует. mkcert
выпускает сертификаты от CA, который сам же добавляет в доверенные, поэтому
предупреждения нет вообще.

Если `certs/` пуста, контейнер всё равно поднимает HTTPS на 8080 с временным
самоподписанным сертификатом, чтобы схема и порт не менялись, и пишет в лог, что
Local Test в таком виде работать не будет. Это подтвердилось на практике:
встроенный браузер отказался открывать такую страницу — ровно как откажется Twitch.

---

## 4. Backend

Локальный. Ничего никуда не деплоится.

| | Значение |
| --- | --- |
| Внутри Docker | `api:4000` |
| Снаружи напрямую | `http://localhost:4000` |
| Через HTTPS-прокси | `https://localhost:8080/api/...` |
| `PUBLIC_API_URL` | `https://localhost:8080` |
| `PUBLIC_WEB_URL` | `https://localhost:8080` |

`PUBLIC_API_URL` — единственный источник и для EventSub-колбэка, и для OAuth
redirect URI (`server/src/twitch/eventsub.ts`, `server/src/twitch/oauth.ts`).

### EventSub callback

```
/api/eventsub/twitch
```

Полный URL: `${PUBLIC_API_URL}/api/eventsub/twitch`

Для **Local Test это не нужно**: локальный тест работает на симулированных
redemption через `/api/dev/redeem`, которые проходят через настоящий
signature-verified вебхук. Twitch до `localhost` не достучится и не должен.

Для **REAL TWITCH TEST** нужен публичный HTTPS — см. раздел 8.

Подписки: `channel.channel_points_custom_reward_redemption.add` и `.update`,
версия `1`, условие `{ broadcaster_user_id: TWITCH_CHANNEL_ID }`.

### Broadcaster OAuth redirect URI

```
https://localhost:8080/api/oauth/twitch/callback
```

Эту строку вписать в **Console → Applications → твоё приложение → OAuth
Redirect URLs**, символ в символ.

Scopes: `channel:manage:redemptions`, `channel:read:redemptions`.

---

## 5. Allowlists в Developer Console → Extension → Capabilities

Составлено по **реально пойманным** запросам: расширение открыто, карта
раскрыта, тайлы загружены, затем снят `performance.getEntriesByType('resource')`
и отфильтрованы внешние хосты.

### Allowlist for URL Fetching Domains

```
api.mapbox.com
events.mapbox.com
```

| Хост | Что именно запрашивается | Тип |
| --- | --- | --- |
| `api.mapbox.com` | `/styles/v1/mapbox/...`, `/v4/mapbox.mapbox-streets-v8,...`, `/fonts/v1/mapbox/...`, `/map-sessions/v1` | `fetch` |
| `events.mapbox.com` | `/events/v2` — телеметрия Mapbox GL, включена по умолчанию | `fetch` |

Наш собственный API в этот список **для Local Test добавлять не нужно**:
расширение раздаётся с `https://localhost:8080`, и API там же, то есть попадает
под `connect-src 'self'`. Для REAL TWITCH TEST и для загруженного ZIP сюда
добавляется хост тоннеля.

`extension-files.twitch.tv` в allowlist не нужен — это домен самого Twitch, с
которого грузится официальный Extension Helper.

### Allowlist for Image Domains

**Пусто.**

Ни одного запроса с `initiatorType: img` к внешним хостам не зафиксировано:
Mapbox GL забирает спрайты и глифы через `fetch`, а не через `<img>`, поэтому
они уже покрыты URL Fetching.

### Allowlist for Media Domains

**Пусто.** Расширение не проигрывает ни аудио, ни видео.

### Шрифты

Внешних нет. `theme.css` объявляет `'Inter', -apple-system, …`, но `Inter`
нигде не подгружается — фактически системный стек. Google Fonts не нужен.

### Configuration Service

Выбрать **Custom / My Own Service**.

Почему: у расширения есть Config Path и есть настройки, но хранятся они в нашей
базе и правятся через `PUT /api/admin/settings`. Twitch Configuration Service
не используется — в коде нет ни одного обращения к `Twitch.ext.configuration`.

«No configuration» было бы неверно: конфигурация существует, и `config.html`
реально отдаётся владельцу канала. Выбор «Custom» также означает, что мы не
должны начать полагаться на `Twitch.ext.configuration` — и не полагаемся.

### Request Identity Link

Поставить **Yes**. Без реального numeric user id redemption невозможно
сопоставить с тем, кто заказал точку, — см. раздел 7.

---

## 6. Переменные окружения

Читаются сервером:

| Переменная | Обязательна | Где используется |
| --- | --- | --- |
| `TWITCH_EXT_SECRET` | **да** | проверка JWT зрителя. base64 из Extension → Settings → Secret Keys |
| `TWITCH_CHANNEL_ID` | **да** | сверка `channel_id` в JWT, условие EventSub. Числовой id, не логин |
| `TWITCH_CLIENT_ID` | да\* | Helix: Custom Rewards + EventSub |
| `TWITCH_CLIENT_SECRET` | да\* | обмен кода OAuth, app access token |
| `TWITCH_EVENTSUB_SECRET` | да\* | HMAC-подпись вебхука |
| `PUBLIC_API_URL` | **да** | из него строятся EventSub callback и OAuth redirect |
| `PUBLIC_WEB_URL` | да | куда вернуть браузер после OAuth; allow-list для redirect |

\* Для Local Test без ключей Twitch: при `DEV_MODE=true` и пустом
`TWITCH_CLIENT_ID` Helix подменяется локальной заглушкой, награды и redemption
эмулируются. Карта и маршруты при этом настоящие.

Браузерный бандл:

| Переменная | Значение для Local Test |
| --- | --- |
| `VITE_API_BASE` | **пусто** — расширение раздаётся с того же origin, что и API |
| `VITE_MAPBOX_PUBLIC_TOKEN` | `pk.…` |
| `VITE_MAPBOX_STYLE_URL` | по умолчанию `mapbox://styles/mapbox/dark-v11` |
| `VITE_DEV_MODE` | `true` локально, `false` в прод-сборке |

| Прочее | |
| --- | --- |
| `WEB_PORT` | `8080` |
| `CLOUDFLARE_TUNNEL_TOKEN` | пусто (см. раздел 8) |

Объявлено, но не используется: `TWITCH_EXT_CLIENT_ID` (есть в схеме
`server/src/env.ts`, нигде не читается — JWT проверяется секретом).

---

## 7. Identity Linking

`Twitch.ext.actions.requestIdShare()` вызывается **только** из кнопки
«Разрешить доступ к аккаунту», которая появляется после того, как зритель уже
выбрал точку и получил `needs_id_share`. При открытии расширения identity не
запрашивается — проверено по коду: единственный вызов в UI это
`onIdShare={requestIdShare}` в `web/src/viewer/App.tsx`.

Бэкенд всегда проверяет ext-JWT и берёт `user_id` только из него. Токен с
нечисловым `user_id` (опаковым) считается непривязанным.

Фактическая матрица, снятая запросами к работающему API:

| Случай | `/api/ext/state` | `/api/ext/quote` | `/api/ext/broadcaster/status` |
| --- | --- | --- | --- |
| Аноним (не залогинен) | `200` | `403 needs_id_share` | `403 forbidden` |
| Залогинен, identity не дана | `200` | `403 needs_id_share` | `403 forbidden` |
| Identity разрешена | `200` | `200` | `403 forbidden` |
| Broadcaster (linked) | `200` | `200` | `200` |
| Broadcaster (не linked) | `200` | `403 needs_id_share` | `200` |
| Без токена | `401` | — | — |

Читается так: карту видят все, включая анонимов; платить может только тот, кого
можно опознать; страница настройки — только владелец канала, причём ему для неё
identity не нужна (роль лежит в JWT).

Отказ пользователя обрабатывается пассивно: Twitch просто заново вызывает
`onAuthorized` без `user_id`, карточка остаётся в состоянии с кнопкой, ничего не
ломается и повторный запрос не навязывается.

---

## 8. Два режима работы

### LOCAL DEV / Twitch Local Test — по умолчанию

```
Twitch Extension → https://localhost:8080 → Docker
```

EventSub не нужен: оплата эмулируется через `/api/dev/redeem`, который собирает
настоящий подписанный EventSub-payload и отправляет его в тот же вебхук.

### REAL TWITCH TEST — опционально

```
Twitch Extension → https://<tunnel> → Docker
Twitch EventSub  → https://<tunnel> → Docker
```

Всё по-прежнему считается локально; тоннель только пробрасывает HTTPS.

```bash
docker compose --profile tunnel up -d cloudflared
docker compose logs cloudflared | grep trycloudflare.com
```

Полученный URL положить в `.env` в `PUBLIC_API_URL` и `VITE_API_BASE`, затем:

```bash
docker compose up -d --force-recreate api web
```

и нажать «СИНХР. EVENTSUB» в `/admin`. Хост тоннеля добавить в
**Allowlist for URL Fetching Domains**.

Профиль `tunnel` не входит в обычный `docker compose up` — для локальной работы
он не нужен.

---

## 9. Команды

| Что | Команда |
| --- | --- |
| Поднять всё | `docker compose up -d --build` |
| Сертификат (один раз) | `powershell -ExecutionPolicy Bypass -File scripts\setup-certs.ps1` |
| Тесты | `npm test` |
| Типы | `npm run typecheck` |
| Прод-сборка | `npm run build` |
| Extension ZIP + CSP-проверка | `npm run ext:build` |
| Только CSP-проверка | `npm run ext:check` |
| Сквозной сценарий | `node scripts/acceptance.mjs` |
| Тоннель | `docker compose --profile tunnel up -d cloudflared` |

Прод-сборка расширения (для будущего Hosted Test, не для Local Test):

```bash
VITE_API_BASE=https://<tunnel-или-домен> \
VITE_MAPBOX_PUBLIC_TOKEN=pk.xxxxx \
VITE_DEV_MODE=false \
npm run ext:build
```

ZIP: `web/twitch-extension.zip` (в git не коммитится).

---

## 10. CSP: что проверено и чем

### Mapbox-воркер — починено

Раньше бандл содержал
`window.URL.createObjectURL(new Blob([...], {type:"text/javascript"}))` —
Mapbox GL так запускает свой web worker, а CSP расширений Twitch такие воркеры
запрещает (blob подпадает под запрет `eval`). Локально это не видно: на обычной
странице CSP нет, поэтому карта работала, а на Twitch не запустилась бы.

Теперь:

* `web/vite.config.ts` подменяет голый импорт `mapbox-gl` на
  `mapbox-gl/dist/mapbox-gl-csp.js` — сборку **без** Blob-воркера;
* `web/src/shared/mapbox.ts` ставит `mapboxgl.workerUrl` на файл воркера,
  подключённый через `?url`, то есть настоящий файл в бандле;
* ссылка в собранном коде — `new URL("mapbox-gl-csp-worker-*.js",
  import.meta.url)`, то есть относительно самого модуля. Это работает и на
  `https://localhost:8080/`, и на хешированном пути Twitch CDN.

Подтверждено в браузере: воркер запрашивается как обычный файл
(`mapbox-gl-csp-worker.js` в списке ресурсов), карта поднимается.

### Автоматическая проверка

```bash
npm run ext:check
```

`web/scripts/check-extension-csp.mjs` проходит по `web/extension-build/` и
роняет сборку, если найдёт:

* `createObjectURL(new Blob(...))` или `new Worker("blob:...")`;
* `eval(`, `new Function(`, `document.write(`;
* инлайновый `<script>` или `on*`-атрибут в HTML;
* `<script src>` с домена, отличного от `extension-files.twitch.tv`;
* абсолютные пути `src="/..."` в HTML;
* отсутствие Mapbox CSP-воркера в бандле.

Текущий результат: `13 файлов, чисто`. Проверка входит в `npm run ext:build`.

### Внешние скрипты

Один, официальный:

```html
<script src="https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js"></script>
```

`mapbox-gl` и `socket.io-client` собираются в бандл из npm. Google Fonts и
Google Analytics не используются.

---

## 11. Что открыть руками и что должно быть видно

| URL | Что должно быть |
| --- | --- |
| `https://localhost:8080/video_overlay.html` | Почти пустая страница. Слева снизу при наведении — рамка и подсказка «Открыть карту». Клик раскрывает карту Пхукета с поиском |
| `https://localhost:8080/mobile.html` | Нижняя панель «WAYPOINT / Отправь стримера в точку / КАРТА». Кнопка открывает карту во весь экран |
| `https://localhost:8080/config.html` | Панель статуса: бэкенд, авторизация Twitch, Channel ID, GPS, Mapbox, приём точек, ссылка на админку |

Замок в адресной строке должен быть без предупреждений. Если предупреждение
есть — сертификат ещё не выпущен, см. раздел 3.

`config.html` вне Twitch покажет «Только для владельца канала», если открыть её
без broadcaster-токена; локально страница сама берёт dev-токен с ролью
broadcaster, поэтому откроется полностью.
