# TWITCH_SETUP

Точные значения из текущего состояния: взяты из кода, из собранного бандла и из
реально выполненных запросов. Там, где чего-то **нет** или что-то **не
проверено**, это написано прямым текстом.

Публичный адрес: **https://gudinigta6.duckdns.org**

---

## 0. Как это включается

```bash
docker compose up -d --build
```

Поднимает postgres, redis, api, dev-сервер на `https://localhost:8080`, сборку
публичного бандла, ingress и DuckDNS-updater. Ничего не уезжает в облако:
Caddy, база, Redis и вся обработка остаются на этой машине.

Дальше стек поднимается сам после перезагрузки или перезапуска Docker, а
проверять расширение DevTools не нужно — см.
[§10 «Диагностика без DevTools»](#10-диагностика-без-devtools).

---

## 1. Как устроен публичный вход

```
интернет :443
   └─ gudini-caddy          TLS, Let's Encrypt, уже владеет 80/443
        └─ host.docker.internal:8081
             └─ gta-phuket ingress (Caddyfile в этом репозитории)
                  ├─ /api/*, /socket.io/*  → api:4000
                  └─ всё остальное         → собранный бандл (web/dist)
```

**Почему не свой Caddy на 443.** Порты 80 и 443 на этой машине уже держит
`gudini-caddy`: он обслуживает `gudinijr.duckdns.org` и `lotomal.duckdns.org` и
хранит сертификаты. Второй Caddy эти порты просто не займёт. Поэтому
`gudinigta6.duckdns.org` подключён туда же одним site-блоком — точно так же, как
там уже подключён `lotomal`, отдельный локальный проект через
`host.docker.internal`.

Вся маршрутизация gta-phuket при этом живёт в **этом** репозитории
(`Caddyfile`), в gudini добавлены только TLS и один проброс. Копия блока —
`deploy/gudini-caddy-snippet.caddy`.

**Почему наружу отдаётся собранный бандл, а не dev-сервер.** Vite dev раздаёт
`/@fs` и всё дерево исходников. Публиковать его нельзя. Поэтому сервис
`webbuild` при каждом `up` собирает `web/dist`, и ingress отдаёт именно его.
Dev-сервер остаётся на `https://localhost:8080` и слушает только loopback.

Сертификат: **Let's Encrypt через TLS-ALPN-01 на 443**, токен DuckDNS для этого
не нужен. DNS-01 здесь намеренно не используется: `DUCKDNS_TOKEN` в стеке gudini
принадлежит другому аккаунту DuckDNS и для `gudinigta6` возвращает `KO`.

### Что закрыто

| | |
| --- | --- |
| Postgres | `127.0.0.1:55432`, наружу не публикуется |
| Redis | `127.0.0.1:63790`, наружу не публикуется |
| API | `127.0.0.1:4000`, снаружи только через ingress |
| Dev-сервер | `127.0.0.1:8080` |
| `/api/dev/*`, `/dev.html` | **404** на публичном адресе (проверено) |

Симулятор выключен тремя независимыми замками: ingress отдаёт 404, сервер не
регистрирует эти маршруты без `DEV_MODE`, и `PUBLIC_BUILD` вообще не кладёт
`dev.html` в публичный бандл.

---

## 2. Порты в роутере

**Менять ничего не нужно.** Проброс `TCP 443 → 192.168.1.68` уже существует и
работает — это доказано тем, что Let's Encrypt успешно выпустил сертификат для
`gudinigta6.duckdns.org` через TLS-ALPN-01, а это требует входящего соединения
из интернета на 443 этой машины.

Если когда-нибудь придётся настраивать заново:

| Протокол | Внешний порт | Куда | Обязателен |
| --- | --- | --- | --- |
| TCP | 443 | `192.168.1.68:443` | да |
| TCP | 80 | `192.168.1.68:80` | нет, только для редиректа http→https |

* LAN IP этой машины: **192.168.1.68** (адаптер Ethernet)
* Шлюз: **192.168.1.1**

Стоит закрепить за машиной этот IP в DHCP роутера, иначе после перезагрузки
адрес сменится и проброс перестанет попадать куда надо.

### CGNAT

**Его нет.** Проверено без участия провайдера:

1. Внешний IP — `37.150.10.39`, не из диапазона CGNAT `100.64.0.0/10`.
2. Второй хоп трассировки — `37.150.8.1`, публичный адрес в той же подсети, что
   и внешний IP. При CGNAT там был бы приватный или `100.64.x.x`.
3. Let's Encrypt достучался снаружи на 443 и выпустил сертификат.

Единственный простой тест, который стоит сделать самому:

> Выключи на телефоне Wi-Fi, оставь мобильный интернет, открой
> **https://gudinigta6.duckdns.org/privacy**

Если страница открылась и замок без предупреждений — публичный доступ работает.

**Важное замечание про проверку с этого же компьютера.** Изнутри локальной сети
`https://gudinigta6.duckdns.org` может не открываться: многие роутеры не умеют
NAT hairpin (обращение к своему внешнему IP изнутри). Это **не** значит, что
снаружи не работает. Здесь именно так и вышло: снаружи всё отвечает, изнутри
таймаут.

---

## 3. Что проверено фактически

Проверялось через контейнер в сети `gudini_default` с
`--resolve gudinigta6.duckdns.org:443:<ip caddy>`, то есть по настоящему TLS с
настоящим SNI, минуя только сам роутер:

| Проверка | Результат |
| --- | --- |
| Сертификат | `ssl_verify=0` — валидный Let's Encrypt |
| `/api/health` | `200`, `{"ok":true}` |
| `/privacy`, `/config.html`, `/video_overlay.html`, `/mobile.html`, `/streamer`, `/obs`, `/admin` | `200` |
| `/api/dev/state`, `/dev.html` | `404` |
| Socket.IO handshake | `200`, сервер отдаёт `upgrades:["websocket"]` |
| WebSocket upgrade | **`HTTP/1.1 101 Switching Protocols`** |

То есть `wss://gudinigta6.duckdns.org/socket.io/` работает через оба прокси.

Не проверено мной и требует тебя: открытие с мобильного интернета, реальный
Twitch Local Test, реальный redemption, GPS с телефона.

---

## 4. Пути в Twitch Console

| Поле | Значение |
| --- | --- |
| **Testing Base URI** | `https://gudinigta6.duckdns.org/` |
| **Video - Fullscreen Path** | `video_overlay.html` |
| **Mobile Path** | `mobile.html` |
| **Config Path** | `config.html` |
| **Live Config Path** | *(пусто)* |

Для локальной работы без интернета Testing Base URI можно вернуть на
`https://localhost:8080/` — обе схемы рабочие.

### Callback-адреса (взяты из кода, не придуманы)

`server/src/twitch/eventsub.ts` и `server/src/twitch/oauth.ts` строят их из
`PUBLIC_API_URL`:

```
EventSub callback : https://gudinigta6.duckdns.org/api/eventsub/twitch
OAuth redirect    : https://gudinigta6.duckdns.org/api/oauth/twitch/callback
Privacy Policy    : https://gudinigta6.duckdns.org/privacy
```

OAuth redirect вписывается в **Console → Applications → твоё приложение → OAuth
Redirect URLs**, символ в символ.

Scopes: `channel:manage:redemptions`, `channel:read:redemptions`.

Подписки EventSub: `channel.channel_points_custom_reward_redemption.add` и
`.update`, версия `1`, условие `{ broadcaster_user_id: TWITCH_CHANNEL_ID }`.

---

## 5. Allowlists в Capabilities

### Allowlist for URL Fetching Domains

```
https://api.mapbox.com
https://events.mapbox.com
https://gudinigta6.duckdns.org
wss://gudinigta6.duckdns.org
```

Обоснование по пунктам:

* **Mapbox** — снято с живых запросов: `api.mapbox.com` отдаёт стиль
  (`/styles/v1/mapbox/...`), тайлы (`/v4/...`), шрифты (`/fonts/v1/...`) и
  сессии (`/map-sessions/v1`); `events.mapbox.com` — телеметрия Mapbox GL,
  включённая по умолчанию. Все запросы типа `fetch`.
* **Наш домен** — при Local Test через публичный адрес расширение раздаётся с
  `https://gudinigta6.duckdns.org`, и `VITE_API_BASE` пуст, поэтому все вызовы
  идут на тот же origin и формально покрыты `connect-src 'self'`. Но для Hosted
  Test (файлы на CDN Twitch) `'self'` — это уже `ext-twitch.tv`, и запись нужна.
  Лишней она не бывает, поэтому добавляй сразу.
* **`wss://`** отдельной строкой — намеренная перестраховка. CSP сопоставляет
  схемы строго, а какую именно строку Twitch подставляет в `connect-src`,
  документация не фиксирует. Лишняя запись безвредна, а при её отсутствии
  сокет может молча упереться в CSP.

Если `wss://` Twitch не примет как значение — не страшно: клиент настроен как
`transports: ['websocket', 'polling']` и при блокировке WebSocket сам
перейдёт на long-polling поверх обычного https.

### Allowlist for Image Domains

**Пусто.** Ни одного запроса с `initiatorType: img` к внешним хостам нет:
Mapbox забирает спрайты и глифы через `fetch`.

### Allowlist for Media Domains

**Пусто.** Ни аудио, ни видео расширение не проигрывает.

### Остальное в Capabilities

| Пункт | Значение | Почему |
| --- | --- | --- |
| Request Identity Link | **Yes** | без numeric user id redemption не сопоставить с покупателем |
| Chat | No | расширение в чат не пишет |
| Configuration Service | **Custom / My Own Service** | Config Path есть, но настройки лежат в нашей базе; к `Twitch.ext.configuration` в коде нет ни одного обращения |
| Privacy Policy URL | `https://gudinigta6.duckdns.org/privacy` | |

---

## 6. REAL_TWITCH

`DEV_MODE` остаётся как был — симулятор, поддельные extension-токены, GPS-ходок.
Переключатель на настоящий Twitch отдельный:

```
REAL_TWITCH=false   # локальная заглушка, /api/dev/* доступны
REAL_TWITCH=true    # настоящие награды, redemption и EventSub
```

При `REAL_TWITCH=true`:

* заглушка Helix выключается безусловно (`useDevHelix()` проверяет флаг первым);
* `/api/dev/*` не регистрируются — симулированный redemption не может быть
  принят за оплаченный;
* сервер **отказывается стартовать**, если чего-то не хватает, вместо того чтобы
  тихо сломаться через час: пустой `TWITCH_*`, нечисловой `TWITCH_CHANNEL_ID`,
  не-https или localhost в `PUBLIC_API_URL`.

### Что нужно заполнить в `.env`

| Переменная | Где взять | Обязательна при REAL_TWITCH |
| --- | --- | --- |
| `TWITCH_EXT_SECRET` | Extension → Settings → Secret Keys (base64) | **да** |
| `TWITCH_CLIENT_ID` | Console → Applications → твоё приложение | **да** |
| `TWITCH_CLIENT_SECRET` | там же, New Secret | **да** |
| `TWITCH_CHANNEL_ID` | числовой id канала, не логин | **да** |
| `TWITCH_EVENTSUB_SECRET` | придумать длинную случайную строку | **да** |
| `PUBLIC_API_URL` | `https://gudinigta6.duckdns.org` | **да** |
| `PUBLIC_WEB_URL` | `https://gudinigta6.duckdns.org` | да |
| `PRIVACY_CONTACT` | почта для запросов по данным | для review |
| `DUCKDNS_TOKEN` | DuckDNS, только в `.env` | для updater |

`TWITCH_EXT_CLIENT_ID` объявлен в схеме, но **нигде не читается**: JWT зрителя
проверяется секретом, client id для этого не нужен. Оставлен, чтобы не ломать
существующие `.env`.

Секретов во фронтенде нет: в браузер уходит только публичный токен Mapbox.

После заполнения и `docker compose up -d --force-recreate api`, `config.html`
покажет не «ЛОКАЛЬНАЯ ЗАГЛУШКА», а настоящий статус и реальный Channel ID.

---

## 7. EventSub: быстрый ответ

Twitch ждёт быстрый 2xx и при задержке повторяет доставку. Обработка одного
redemption делает несколько вызовов Twitch API (подтвердить или вернуть баллы,
переписать награду, освободить чужие слоты) и занимает секунды — держать вебхук
открытым всё это время означает напрашиваться на таймаут, а таймаут означает
повторную доставку события, которое уже обрабатывается.

Поэтому порядок такой:

1. проверка подписи — иначе `403`, дальше ничего не происходит;
2. дедупликация по `message-id` (Redis + таблица `eventsub_events`);
3. **ответ `204`**;
4. обработка уже после ответа.

Событие при этом не может потеряться: оно записано в `eventsub_events` **до**
ответа, результат обработки проставляется в `processed_at`, а всё, что упало,
подбирает сметка `retryPendingEvents` каждые 15 секунд (до 5 попыток).
`pruneEventSubEvents` удаляет только обработанные строки — необработанная всё
ещё должна зрителю либо waypoint, либо возврат.

---

## 8. Сборка расширения

```bash
npm run ext:build
```

`vite build` → отбор файлов по манифесту → zip → CSP-проверка.

ZIP: `web/twitch-extension.zip`, в git не коммитится. В него входят
`video_overlay.html`, `mobile.html`, `config.html` и всё, что они импортируют,
включая CSP-воркер Mapbox.

Для Hosted Test собирать с публичным адресом:

```bash
VITE_API_BASE=https://gudinigta6.duckdns.org \
VITE_MAPBOX_PUBLIC_TOKEN=pk.xxxxx \
VITE_DEV_MODE=false \
npm run ext:build
```

Для **Local Test через публичный адрес** этого не требуется: бандл и API уже на
одном origin.

### CSP

`npm run ext:check` роняет сборку на blob-воркере, `eval`, `new Function`,
инлайновом `<script>`, чужом `script src`, абсолютных путях и пропавшем
Mapbox-воркере. Текущий результат — чисто.

Единственный внешний скрипт — официальный
`https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js`.

---

## 9. Резервный вариант, если 443 перестанет быть доступен

```bash
docker compose --profile tunnel up -d cloudflared
docker compose logs cloudflared | grep trycloudflare.com
```

Полученный адрес подставить в `PUBLIC_API_URL`, `PUBLIC_WEB_URL` и Testing Base
URI, пересоздать `api`, нажать «СИНХР. EVENTSUB» в `/admin`. Приложение,
база и Redis всё так же остаются здесь — тоннель только пробрасывает HTTPS.

Сейчас это не нужно: прямой 443 работает.

---

## 10. Диагностика без DevTools

Расширение само сообщает серверу, что с ним произошло у зрителя, а `/admin`
показывает это вместе с вердиктом одной строкой. Открывать DevTools, что-то
включать или настраивать не нужно ни владельцу, ни зрителю. Зритель ничего из
этого не видит.

Точные имена событий, формат и правила приватности — в
[docs/EXTENSION_DIAGNOSTICS.md](docs/EXTENSION_DIAGNOSTICS.md). Этот раздел —
как этим пользоваться.

### Что делать владельцу

1. Запустить Docker Desktop. Стек поднимется сам (см. ниже). После изменений в
   коде или в `.env` — `docker compose up -d --build`.
2. Запустить стрим. Канал в эфире, видео не на паузе.
3. Открыть свой канал на twitch.tv как обычный зритель. На плеере должна быть
   кнопка **🗺 КАРТА**, по нажатию открывается карта Пхукета.
4. Открыть `https://localhost:8080/admin.html` (с этого компьютера; снаружи —
   `https://gudinigta6.duckdns.org/admin`), войти паролем
   `ADMIN_SESSION_SECRET` и смотреть раздел **TWITCH EXTENSION DIAGNOSTICS**.

Раздел обновляется сам каждые 5 секунд. В нём:

* **вердикт** — код и одна строка по-русски (таблица ниже);
* **последняя сессия** — что успело произойти в последнем загруженном
  оверлее: HTML, Helper и его версия, onAuthorized, channelId, тип зрителя,
  размер iframe, видимость, кнопка карты, открытие карты, число ошибок и
  нарушений CSP;
* **последние 50 событий** — время, событие, channelId,
  anonymous / logged_in / identified, размер окна, видимость, Helper, кнопка,
  ошибка;
* **последние 50 запросов Twitch к страницам расширения** — время, путь,
  статус, Referer, Sec-Fetch-Dest, User-Agent.

### Откуда берутся данные

Три независимых источника, чтобы поломка одного не прятала остальные:

| Источник | Где работает | Что доказывает |
| --- | --- | --- |
| Журнал запросов | ingress Caddy (и dev-сервер на 8080) → api по порту 5140 внутри Docker | Twitch действительно запросил страницу; с каким Referer, Sec-Fetch-Dest и статусом |
| `gtamap-boot.js` | обычный скрипт из самого HTML, сразу после Twitch Helper | HTML разобран, Helper есть, onAuthorized, onVisibilityChanged, onHighlightChanged, размер iframe, ошибки, CSP |
| Приложение | React-бандл | бандл запустился, кнопка карты отрисована и реально видна, карта открыта |

Журнал запросов хранит только страницы расширения (`video_overlay`, `mobile`,
`config`, `gtamap-boot.js`, `gtamap-raw.css`) и `/assets/*`, загруженные с них.
Порт 5140 наружу не публикуется. Если api лежит, Caddy продолжает отдавать
расширение, строки журнала за это время просто не доходят.

### Вердикты

| Код | Что значит | Что делать |
| --- | --- | --- |
| `ok` | Кнопка карты видна зрителю, onAuthorized пришёл | Ничего |
| `ok_unauthorized` | Кнопка видна, карта открывается, но onAuthorized ещё не пришёл — покупка точки пока недоступна | Подождать полминуты. Если не пришёл вовсе — обновить страницу канала `Ctrl+Shift+R` |
| `pending` | Оверлей загрузился меньше 10 секунд назад и ещё не отчитался | Подождать, раздел обновится сам |
| `no_data` | Twitch ещё ни разу не запрашивал страницы расширения | Запустить стрим и открыть канал. Если так и остаётся: расширение не активировано в слоте Overlay на канале, или Testing Base URI не `https://gudinigta6.duckdns.org/` |
| `request_only` | Twitch запросил страницу, но её скрипты не отчитались | В таблице запросов посмотреть `/gtamap-boot.js`: нет его или статус не `200` — `docker compose up -d --build`. Есть и `200` — скрипт заблокировал браузер: открыть канал без блокировщика рекламы (инкогнито) |
| `helper_missing` | Twitch Helper не загрузился в iframe | Почти всегда блокировщик рекламы или трекеров на twitch.tv. Отключить его для twitch.tv, `Ctrl+Shift+R` |
| `bundle_missing` | HTML загрузился, а приложение не запустилось | В таблице запросов `/assets/*` со статусом `404` — бандл устарел, `docker compose up -d --build`. Иначе причина — в колонке «ошибка» (`resource_error`, `runtime_error`, `csp_violation`) |
| `trigger_missing` | Приложение запустилось, но кнопка карты так и не отрисовалась (React упал на первой отрисовке) | Это ошибка приложения. Текст вердикта заканчивается последней ошибкой страницы — готовое описание для исправления |
| `iframe_hidden` | Страница ещё ни разу не была на экране: Twitch скрыл iframe (видео на паузе, стрим офлайн), дал ему нулевой размер, или канал открыт в фоновой вкладке. Текст вердикта называет, что именно | Снять видео с паузы, проверить, что стрим в эфире, открыть вкладку со стримом. Это не ошибка приложения |
| `trigger_hidden` | Кнопка карты есть, но не видна; в тексте вердикта написано чем (display, visibility, opacity, вне экрана, перекрыта) | Это ошибка приложения. Текст вердикта — готовое описание для исправления. Для проверки можно включить `SMOKE_TEST=true` |

Вердикт судит по замеру кнопки, сделанному, пока страница была на экране.
Если кнопка была видна, переход во вкладку `/admin`, закрытие вкладки со
стримом или пауза вердикт не портят: остаётся `ok`, с припиской «Сейчас
страница не на экране». Страница настройки (`config.html`) и мобильная
(`mobile.html`) не путаются с оверлеем: вердикт сравнивает запрос Twitch только
с отчётом той же страницы.

### Режим SMOKE_TEST

Для случая «на плеере ничего не видно, и непонятно, загрузилось ли вообще».

```
SMOKE_TEST=true      # в .env
docker compose up -d --build
```

В самом `video_overlay.html`, ещё до React и до любого запроса к API,
появляется большая жёлтая кнопка **EXTENSION LOADED** — слева 10%, сверху 25%.
Ей нужен только HTML и один свой CSS-файл (если он не загрузился, тот же вид
ей задаёт `gtamap-boot.js`, а в событии `html_loaded` будет `rawCss: false`). Она не зависит от React, Mapbox, GPS, API, onAuthorized,
REAL_TWITCH и Channel Points: если Twitch загрузил iframe, она обязана быть
видна.

Когда React запускается, он превращает эту же кнопку в **🗺 КАРТА**, и по
нажатию открывается карта. Пока карта открыта, кнопка спрятана.

Как читать:

| На плеере | Значит |
| --- | --- |
| было `EXTENSION LOADED`, стало `🗺 КАРТА` | всё работает |
| `EXTENSION LOADED` так и не меняется | HTML загрузился, React не запустился или упал — вердикт `bundle_missing` или `trigger_missing` скажет почему |
| сырая кнопка была видна, а кнопка React пропала | проблема в приложении — вердикт `trigger_hidden` с припиской «Кнопка EXTENSION LOADED при этом видна» |
| не видно ничего, но в таблице запросов есть GET `/video_overlay.html` с Referer `https://supervisor.ext-twitch.tv/` | Twitch сам спрятал или сжал iframe; столбцы «размер окна» и «видимость» в событиях говорят, как именно |

**Перед отправкой на review** в `.env` должно быть `SMOKE_TEST=false` и
`DEV_MODE=false` (для `npm run ext:build` вне Docker — ещё и
`VITE_DEV_MODE=false`, а `VITE_SMOKE_TEST`, если добавляли, тоже `false`).
Сама диагностика при этом остаётся включённой: она зрителю не видна.

### Testing Base URI

| Поле в Twitch Console | Значение |
| --- | --- |
| **Testing Base URI** | `https://gudinigta6.duckdns.org/` |
| **Video - Fullscreen Path** | `video_overlay.html` |

Остальные пути — в [§4](#4-пути-в-twitch-console).

### Автоподъём после перезапуска Docker

У `api`, `web`, `postgres`, `redis` и `ingress` (как и у `duckdns`) стоит
`restart: unless-stopped`: после перезагрузки компьютера или перезапуска Docker
Desktop они поднимаются сами, без `docker compose up`. Остановленное вручную
(`docker compose stop`) остаётся остановленным.

* Docker Desktop должен сам стартовать при входе в Windows: **Settings →
  General → Start Docker Desktop when you sign in to your computer**. На этой
  машине это уже включено.
* Политика применяется к контейнерам, созданным после её появления в
  `docker-compose.yml`, поэтому один раз нужен `docker compose up -d`.
* `webbuild` одноразовый и при перезапуске Docker заново не собирает: ingress
  отдаёт последний собранный бандл. После изменений в коде —
  `docker compose up -d --build`.
* Ingress запущен с `--watch`: правку `Caddyfile` он подхватывает сам, без
  перезапуска (`caddy reload` здесь не работает — в `Caddyfile` выключен
  admin-эндпоинт). Ошибочная правка только пишется в лог, старый конфиг
  продолжает работать.

### Приватность

На сервер не уходит и не хранится: JWT, OAuth- и helix-токены, секреты, cookie,
токены из query string, user id зрителя. Зритель сведён к типу: `anonymous`,
`logged_in` (вошёл, но личность не раскрыл) или `identified`. В журнале запросов
нет IP, заголовков кроме Referer, Sec-Fetch-Dest, Sec-Fetch-Site и User-Agent, и
query-параметров кроме Twitch-овских (`anchor`, `platform`, `mode`, `state`,
`language`, `locale`, `popout`). Caddy удаляет `Authorization` и `Cookie`,
затирает значения `?token=` и `?code=` и весь query у заголовка `Referer` ещё
до того, как строка уходит в журнал. Всё хранится 7 дней и не больше 5000
строк; журнал запросов принимает не больше 20 строк в секунду (с запасом на
рейд), лишнее отбрасывает.
