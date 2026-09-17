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
