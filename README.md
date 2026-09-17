# GTA Phuket — IRL waypoint system для Twitch

Зрители открывают карту прямо поверх Twitch-плеера, выбирают место в Пхукете,
сервер строит **настоящий пеший маршрут** от твоего живого GPS, считает цену в
Channel Points, и после **реальной оплаты через Twitch** точка становится
активным waypoint: она появляется на мини-карте в OBS и на телефоне стримера.

```
Twitch Extension → карта Пхукета → точка → walking route → цена
      → Twitch Custom Reward → зритель redeem'ит → EventSub → waypoint
      → OBS HUD + навигация на телефоне
```

---

## Содержание

1. [Что внутри](#что-внутри)
2. [Важные ограничения Twitch](#важные-ограничения-twitch-читать-обязательно)
3. [Быстрый старт локально](#быстрый-старт-локально)
4. [Что нужно получить: Mapbox](#mapbox)
5. [Что нужно получить: Twitch](#twitch)
6. [Настройка Extension](#настройка-extension)
7. [Broadcaster OAuth и Channel Points](#broadcaster-oauth-и-channel-points)
8. [EventSub](#eventsub)
9. [OBS Browser Source](#obs-browser-source)
10. [Телефон стримера](#телефон-стримера)
11. [Админка](#админка)
12. [Локальный тест без стрима и без баллов](#локальный-тест-без-стрима-и-без-баллов)
13. [Hosted Test на Twitch](#hosted-test-на-twitch)
14. [Production deploy](#production-deploy)
15. [Тесты](#тесты)
16. [Формула цены](#формула-цены)
17. [Приватность и безопасность](#приватность-и-безопасность)
18. [Архитектура](#архитектура)
19. [Диагностика](#диагностика)

---

## Что внутри

| Поверхность | URL | Для кого |
| --- | --- | --- |
| Twitch Video - Fullscreen | `/video_overlay.html` | зрители, поверх плеера |
| Twitch Mobile | `/mobile.html` | зрители с телефона |
| Twitch Config | `/config.html` | владелец канала, статус связки |
| OBS Browser Source | `/obs.html` | вшивается в видео |
| Телефон стримера (PWA) | `/streamer.html` | ты на улице |
| Live-админка | `/admin.html` | ты или модератор |
| Симулятор Twitch-плеера | `/dev.html` | только локально, DEV_MODE |
| API | `/api/*` | всё вышеперечисленное |

Всё это раздаётся одним контейнером по HTTPS на `https://localhost:8080/`.
Настройка Twitch-расширения — в [TWITCH_SETUP.md](TWITCH_SETUP.md).

Стек: Node 20 + TypeScript + Fastify + Socket.IO + PostgreSQL + Redis,
фронтенд — React 18 + Vite + Mapbox GL JS v3.

---

## Важные ограничения Twitch (читать обязательно)

Это не недоработки — это то, что Twitch физически не даёт сделать. Система
построена вокруг них, а не вопреки.

**1. Нет API «списать N баллов у зрителя».**
Не существует `deductChannelPoints(userId, amount)`. Единственный официальный
способ взять Channel Points — показать зрителю **Custom Reward** с нужной ценой
и дождаться, пока он сам его активирует.

Поэтому здесь сделан **пул управляемых наград**: приложение создаёт, например,
10 наград `IRL WAYPOINT 01…10`, держит их выключенными, а когда зритель выбрал
точку — переписывает одну из них в `WAYPOINT • A7K3` с рассчитанной ценой и
включает. Зритель открывает баллы канала и активирует именно её.

**2. Extension не может программно открыть панель Channel Points.**
Такого API нет. Интерфейс честно пишет зрителю, где её найти, и показывает
название награды крупно. Никакой кнопки «открыть баллы» здесь нет и не будет —
она была бы обманом.

**3. Вернуть баллы можно только до подтверждения.**
Награда создаётся с `should_redemptions_skip_request_queue: false`, поэтому
redemption попадает в очередь запросов и его можно перевести в `CANCELED` —
Twitch вернёт баллы. После `FULFILLED` вернуть их API уже нельзя. В админке
кнопка «Отменить» честно сообщает об этом.

**4. Одно задание за раз.**
Пока waypoint активен, остальные зрители не могут купить новый. Если несколько
человек успели зарезервировать награды, побеждает тот, кто заплатил первым;
остальным награды сразу выключаются, а любой опоздавший redemption
отменяется с возвратом баллов.

**5. Наградами может управлять только то же приложение, которое их создало.**
`TWITCH_CLIENT_ID` в `.env` должен быть тем же самым, под которым прошёл
broadcaster OAuth.

---

## Быстрый старт локально

Нужны Docker и Docker Compose.

```bash
git clone <this repo> && cd gta-phuket
cp .env.example .env
```

Открой `.env` и заполни минимум:

```
MAPBOX_PUBLIC_TOKEN=pk....
MAPBOX_SERVER_TOKEN=pk....     # можно тот же токен для локальной разработки
VITE_MAPBOX_PUBLIC_TOKEN=pk....
DEV_MODE=true
```

Twitch-ключи для локального теста **не нужны** — см.
[Локальный тест](#локальный-тест-без-стрима-и-без-баллов).

Один раз выпусти локальный сертификат (нужен `mkcert`, ставится через
`winget install FiloSottile.mkcert`):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-certs.ps1
```

```bash
docker compose up -d --build
```

Поднимется:

| Сервис | Порт | Проверка |
| --- | --- | --- |
| web (Vite, HTTPS) | 8080 | https://localhost:8080 |
| api | 4000 | https://localhost:8080/api/health |
| postgres | 55432 | — |
| redis | 63790 | — |

Контейнер `web` терминирует TLS сам и проксирует `/api` и `/socket.io` на `api`,
поэтому расширение, REST и `wss://` живут на одном доверенном origin. Без
сертификата HTTPS всё равно поднимется — с временным самоподписанным, о чём
будет сказано в логах; Twitch Local Test в таком виде работать не будет.

Миграции применяются автоматически при старте `api`.

Проверка одной командой:

```bash
node scripts/acceptance.mjs
```

Этот скрипт проходит весь сценарий по HTTP и печатает, на каком шаге что-то не
так.

---

## Mapbox

Нужен аккаунт на https://account.mapbox.com.

1. **Public token** (`pk.…`) — уходит в браузер, рисует тайлы карты.
   В дашборде ограничь его по URL (`https://*.ext-twitch.tv/*`, твой домен).
   Кладётся и в `MAPBOX_PUBLIC_TOKEN`, и в `VITE_MAPBOX_PUBLIC_TOKEN`.
2. **Server token** — `MAPBOX_SERVER_TOKEN`, используется сервером для
   Directions и Geocoding. **Никогда не попадает в браузер.** Для локальной
   разработки можно использовать тот же public-токен.

Используются:

* Mapbox GL JS v3 — карта, POI, клик по заведению (`queryRenderedFeatures`)
* Directions API, профиль `walking` — только с сервера
* **Search Box API** (`/search/searchbox/v1/forward`) — поиск мест, только с
  сервера, ограничен bbox Пхукета
* Geocoding v6 — запасной вариант, если Search Box ничего не нашёл

> Поиск намеренно идёт через Search Box, а не через Geocoding: в Geocoding v6
> вообще нет типа POI — только страны, города, улицы и адреса, поэтому запрос
> «Jungceylon» там возвращает пусто. Магазины, ТЦ, бары, пляжи и
> достопримечательности живут в Search Box.

Стиль по умолчанию — `mapbox://styles/mapbox/dark-v11`, у него есть слои
`poi-label`, из которых берутся названия и категории заведений.

> Стиль `mapbox/standard` в этом проекте работать будет, но кликабельных POI
> в нём нет — останется только выбор произвольной точки.

---

## Twitch

Нужны **две разные сущности** в https://dev.twitch.tv/console.

### 1. Extension

`Console → Extensions → Create Extension`.

* Тип: **Video - Fullscreen** и **Video - Component** (нужен Fullscreen Overlay).
* После создания: `Settings → Extension Client ID` → `TWITCH_EXT_CLIENT_ID`
* `Settings → Secret Keys → Create` → base64-строка → `TWITCH_EXT_SECRET`

Этим секретом Twitch подписывает JWT каждого зрителя; сервер проверяет подпись
сам и берёт `channel_id`, `user_id`, `role` **только** из токена.

### 2. Application

`Console → Applications → Register Your Application`.

* OAuth Redirect URL: `https://ВАШ_API/api/oauth/twitch/callback`
  (локально — `http://localhost:4000/api/oauth/twitch/callback`)
* Client ID → `TWITCH_CLIENT_ID`
* New Secret → `TWITCH_CLIENT_SECRET`

Это приложение создаёт и редактирует Custom Rewards и подписывается на EventSub.

### 3. Твой channel id

Числовой id канала (не логин). Узнать можно так:

```bash
curl -H "Client-Id: $TWITCH_CLIENT_ID" -H "Authorization: Bearer $APP_TOKEN" \
  "https://api.twitch.tv/helix/users?login=ТВОЙ_ЛОГИН"
```

→ `TWITCH_CHANNEL_ID`.

---

## Настройка Extension

В `Console → Extensions → <твоё расширение> → Asset Hosting`:

| Поле | Значение |
| --- | --- |
| Video - Fullscreen Path | `video_overlay.html` |
| Mobile Path | `mobile.html` |
| Config Path | `config.html` |
| Live Config Path | *(пусто)* |
| Testing Base URI | `https://localhost:8080/` для local test |

В `Capabilities`:

* **Request Identity Link** — обязательно **включить**.
  Без реального `user_id` невозможно сопоставить redemption с тем, кто заказал
  точку. Расширение вызывает `Twitch.ext.actions.requestIdShare()`, а сервер
  до получения связки отвечает `needs_id_share` и не выдаёт расчёт.
* **Allowlist for URL Fetching Domains** — добавь домен своего API,
  иначе CSP расширения заблокирует запросы.

Сборка бандла для загрузки:

```bash
VITE_API_BASE=https://ВАШ_API \
VITE_MAPBOX_PUBLIC_TOKEN=pk.... \
npm run build -w web

npm run ext:zip -w web        # → web/twitch-extension.zip
```

`VITE_API_BASE` обязателен: файлы расширения хостит Twitch, и без него бандл
будет стучаться сам в себя.

---

## Broadcaster OAuth и Channel Points

Нужные scopes (запрашиваются автоматически):

```
channel:manage:redemptions   создание и правка наград, FULFILLED/CANCELED
channel:read:redemptions     подписка EventSub на redemption
```

Подключение:

1. Залогинься на Twitch **под аккаунтом канала**.
2. Открой `https://ВАШ_API/api/oauth/twitch/start`
   (или кнопку «Подключить Twitch» в админке).
3. Подтверди доступ.

После callback сервер:

* сохранит access/refresh токены (refresh обновляется автоматически под
  Redis-локом, чтобы параллельные запросы не сожгли refresh-токен);
* создаст пул наград `IRL WAYPOINT 01…N` (выключенные, цена 1);
* подпишется на EventSub;
* вернёт тебя в админку с отчётом, что получилось, а что нет.

Награды **не удаляются** при уменьшении пула — только выключаются, потому что
удаление награды стирает и её историю redemption'ов.

---

## EventSub

Единственный источник истины об оплате.

Callback: `POST https://ВАШ_API/api/eventsub/twitch`

Подписки: `channel.channel_points_custom_reward_redemption.add`
и `.update` (вторая — для аудита ручных действий модератора).

Сервер проверяет:

* подпись `sha256=HMAC(secret, messageId + timestamp + rawBody)` в
  constant-time, по **сырым байтам** тела;
* возраст сообщения (старше 10 минут — отказ);
* дубликаты по `Twitch-Eventsub-Message-Id` (Redis + таблица `eventsub_events`,
  чтобы повтор пережил перезапуск Redis);
* дубликаты по id самого redemption.

Затем сверяет redemption с квотой: reward, ожидаемый Twitch user id, цена,
срок, канал, состояние квоты и отсутствие активного waypoint. Совпало —
`FULFILLED` + waypoint. Не совпало — `CANCELED`, баллы возвращаются.

> **Twitch не умеет ходить на localhost.** Для локального теста с реальным
> Twitch нужен туннель:
>
> ```bash
> cloudflared tunnel --url http://localhost:4000
> # или: ngrok http 4000
> ```
>
> Полученный HTTPS-адрес положи в `PUBLIC_API_URL`, перезапусти `api`
> и нажми «СИНХР. EVENTSUB» в админке — старые подписки со мёртвым
> callback'ом будут удалены и созданы заново.

Проверить подписки:

```bash
curl -H "Client-Id: $TWITCH_CLIENT_ID" -H "Authorization: Bearer $APP_TOKEN" \
  https://api.twitch.tv/helix/eventsub/subscriptions
```

---

## OBS Browser Source

`Sources → + → Browser`:

URL берётся из админки (поле **OBS Browser Source**) или из лога `api` при
старте — он содержит токен:

```
https://localhost:8080/obs.html?token=<32 hex>
```

Токен выводит мини-карту на **точные** координаты. Без него страница всё равно
работает, но получает те же округлённые/задержанные данные, что и зрители — так
что утёкший URL ничего лишнего не показывает.

| Поле | Значение |
| --- | --- |
| URL | `https://localhost:8080/obs.html?token=…` |
| Width | `1920` |
| Height | `1080` |
| Custom CSS | оставить пустым |
| Shutdown source when not visible | выкл. |
| Refresh browser when scene becomes active | выкл. |

Фон прозрачный, мини-карта в левом нижнем углу. Растяни источник на весь
холст — HUD сам масштабируется.

Для выравнивания есть отладочный режим: `https://localhost:8080/obs.html?debug=1`
— он рисует границы safe zone и прямоугольник мини-карты.

**Геометрия мини-карты — это контракт.** Она занимает
`left 1.5% / bottom 4% / width 19.5% / height 30%` от кадра, и ровно на это
место Twitch Extension кладёт свою прозрачную кликабельную зону. Значения
лежат в CSS-переменных `--mm-*` (`web/src/obs/obs.css`) и `--hit-*`
(`web/src/viewer/viewer.css`) — **менять их нужно в обоих файлах сразу.**

---

## Телефон стримера

1. Открой на телефоне `https://ВАШ_WEB/streamer.html`
   (для geolocation нужен HTTPS либо localhost).
2. Введи код из `STREAMER_DEVICE_SECRET` → страница получит device-токен и
   сохранит его.
3. Нажми **ВКЛЮЧИТЬ GPS** — браузер спросит разрешение только по нажатию.
4. Добавь на домашний экран: это PWA, работает в standalone-режиме.

Координаты уходят по WebSocket каждые ~3 секунды или при смещении > 8 м.
Сервер — единственный источник истины о местоположении; зритель не может
подменить origin маршрута.

Если фикс старше `gpsTimeoutSeconds` (по умолчанию 15 с), покупка точек
блокируется и зрителям показывается «GPS временно недоступен».

---

## Админка

`https://localhost:8080/admin.html`, пароль — `ADMIN_SESSION_SECRET`.

Показывает: статус и точность GPS, активный waypoint (кто заплатил, сколько,
сколько осталось идти), состояние всех слотов наград, последние расчёты,
состояние OAuth и EventSub.

Кнопки: открыть/закрыть приём точек, завершить, отменить (с возвратом баллов,
если redemption ещё не подтверждён), сбросить маршрут, пересинхронизировать
слоты и EventSub.

Настройки меняются на лету: цена, лимиты, TTL расчёта, размер пула, таймаут
GPS, задержка и точность координат для зрителей, запретные зоны, рейт-лимиты.

---

## Локальный тест без стрима и без баллов

При `DEV_MODE=true` и `NODE_ENV != production` включается `/api/dev/*`.
Если при этом не заданы `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET`, Helix
подменяется локальной заглушкой — **никаких реальных наград и никаких реальных
баллов.** Маршруты и карта при этом настоящие, Mapbox-токен нужен всегда.

Открой **https://localhost:8080/dev.html** — это симулятор Twitch-плеера:
поддельное «видео», поверх него настоящий `obs.html` в iframe (как вшитая в
видео мини-карта), а сверху настоящий `video_overlay.html` (как расширение).

Полный сценарий:

1. `docker compose up -d`
2. На `/dev.html` нажми **Patong** → **СТАРТ ДВИЖЕНИЯ**
3. В мини-карте слева снизу появится маркер игрока
4. Кликни по мини-карте внутри «плеера» — карта развернётся
5. Найди или ткни в Jungceylon
6. Сервер построит пеший маршрут и покажет расстояние, время и цену
7. Нажми **ОТПРАВИТЬ СТРИМЕРА СЮДА** — зарезервируется слот награды
8. Нажми **SIMULATE TWITCH REDEMPTION** в панели справа
9. Waypoint станет ACTIVE, маршрут появится в OBS-слое
10. Открой `/streamer.html` — там будет стрелка и оставшееся расстояние
11. Симулятор идёт по настоящему маршруту, расстояние уменьшается
12. В `/admin.html` нажми **ЗАВЕРШИТЬ** — можно заказывать следующую точку

**«Simulate Redemption» — не срезка.** Кнопка собирает настоящий EventSub
payload, подписывает его секретом и отправляет в тот же самый webhook, что и
Twitch. Проверка подписи, дедупликация, сверка пользователя и транзакция
активации выполняются полностью.

Скриптом:

```bash
node scripts/acceptance.mjs
```

В production `/api/dev/*` не регистрируются вообще, а `devModeEnabled`
принудительно `false` при `NODE_ENV=production`.

---

## Hosted Test на Twitch

1. Собери и загрузи бандл (см. [Настройка Extension](#настройка-extension)).
2. `Console → Extensions → Status → Move to Hosted Test`.
3. `PUBLIC_API_URL` должен быть публичным HTTPS.
4. Установи расширение себе на канал и активируй как **Video Overlay**.
5. Пройди broadcaster OAuth.
6. Нажми «СИНХР. EVENTSUB» в админке.
7. Запусти стрим с OBS-источником.
8. Со второго аккаунта: открой карту, выбери точку, подтверди, открой баллы
   канала, активируй `WAYPOINT • XXXX`.
9. В логах `api` появится `redemption handled` с `result: activated`.

Что проверить: расширение поверх плеера, клик по зоне мини-карты открывает
карту, Identity Link срабатывает, цена награды совпадает с расчётом, EventSub
доходит, user id совпадает, waypoint активируется, OBS получает маршрут.

---

## Production deploy

```bash
docker compose -f docker-compose.yml up -d --build
```

Обязательно поменяй в `.env`:

```
NODE_ENV=production
DEV_MODE=false
PUBLIC_API_URL=https://api.example.com     # HTTPS, доступен Twitch
PUBLIC_WEB_URL=https://example.com
ADMIN_SESSION_SECRET=<длинная случайная строка>
STREAMER_DEVICE_SECRET=<длинная случайная строка>
TWITCH_EVENTSUB_SECRET=<длинная случайная строка, 10-100 символов>
TRUST_PROXY=<ip или CIDR твоего reverse-proxy>
```

С `NODE_ENV=production` сервер **откажется стартовать**, если любой из трёх
секретов остался значением из `.env.example` или короче 16 символов — это вся
защита админки, привязки телефона и вебхука.

`TRUST_PROXY` по умолчанию `false`: тогда `req.ip` — реальный адрес сокета.
Ставь `true` только если между интернетом и приложением ничего нет, иначе
любой сможет подделать себе IP заголовком `X-Forwarded-For` и обойти лимит
попыток входа. За nginx укажи его адрес или подсеть.

Чеклист:

* `api` за reverse-proxy с валидным TLS (Twitch не примет самоподписанный).
* `web` в проде стоит собирать (`npm run build -w web`) и отдавать статику
  nginx/Caddy, а не Vite dev-сервером; dev-сервер в compose нужен для локальной
  разработки.
* Postgres с бэкапами; Redis может быть без персистентности — он хранит только
  кэш, локи и живое состояние, всё важное лежит в Postgres.
* `GPS_RETENTION_HOURS` — по умолчанию история GPS чистится через 24 часа.
* Mapbox-токены ограничены по URL.
* `NODE_ENV=production` выключает pretty-логи и dev-эндпоинты.

---

## Тесты

```bash
# всё, что можно проверить без сервисов
npm test

# полный набор, включая интеграционные
docker compose up -d postgres redis
npm test

# или целиком в докере
docker compose --profile test run --rm test
```

95 тестов. Интеграционные сами создают базу `gta_phuket_test`, а если Postgres
или Redis недоступны — помечаются как skipped с объяснением, а не падают.

Покрыто: расчёт цены, истечение расчёта, устаревший GPS, максимальная
дистанция, некорректная точка (море/вне Пхукета/запретная зона), подпись
EventSub, повторная доставка EventSub, чужой зритель активировал награду →
возврат, правильный зритель → активация waypoint, двойной redemption,
конкуренция за слоты наград, блокировка второго активного waypoint,
проверка Twitch JWT, фильтр приватности маршрута, токен OBS, отказ старта с
дефолтными секретами, попытка чужого зрителя «сжечь» чужую награду, один живой
расчёт на зрителя под конкуренцией, повторная обработка EventSub после сбоя.

Из внешних сервисов замокан только Mapbox (маршруты стоят денег, и проверяются
здесь наши правила, а не точность Mapbox). Postgres и Redis — настоящие,
потому что проверяемые свойства (`FOR UPDATE SKIP LOCKED`, partial unique
index, `SET NX`) — это свойства именно этих движков.

---

## Формула цены

```
raw  = baseCost + ceil(distanceMeters / 100) * pointsPer100Meters
cost = clamp(roundUpTo(raw, roundTo), minimumCost, maximumCost)
```

Значения по умолчанию (меняются в админке, это только seed):

| Параметр | По умолчанию |
| --- | --- |
| `baseCost` | 100 |
| `pointsPer100Meters` | 100 |
| `roundTo` | 50 |
| `minimumCost` | 100 |
| `maximumCost` | 100 000 |
| `maxWalkingDistanceMeters` | 5000 |
| `quoteTtlSeconds` | 60 |
| `rewardSlotPoolSize` | 10 |
| `gpsTimeoutSeconds` | 15 |

Цена считается **только на сервере**, из дистанции, которую вернул Directions
API. Клиент не присылает ни цену, ни расстояние. После создания расчёта цена
неизменна — даже если GPS успел сдвинуться. Расчёт живёт `quoteTtlSeconds`,
после чего нужен новый.

Taxi Mode пока не реализован — это отдельный режим на будущее.

---

## Приватность и безопасность

* `viewerLocationDelaySeconds` — зрителям отдаётся позиция не новее заданной
  задержки (бэкенд при этом маршрутизирует по реальной). Пока нет достаточно
  старой точки, координаты зрителю вообще не отдаются.
* `viewerLocationPrecision` — округление координат для зрителей
  (5 знаков ≈ 1 м, 3 ≈ 110 м).
* `restrictedZones` — полигоны, внутри которых точку поставить нельзя.
* Разрешённая область ограничена bbox Пхукета — и для назначения, и для GPS.
* Extension JWT проверяется на сервере, `userId`/`channelId` берутся из токена.
* EventSub подпись проверяется по сырым байтам, constant-time.
* OAuth state одноразовый, живёт 10 минут.
* Рейт-лимиты на расчёты, поиск и подтверждения — чтобы нельзя было
  расстрелять платный Directions бесплатными кликами. Маршрут считается только
  по явному клику, одинаковые и близкие маршруты кэшируются на 5 минут.
* Один живой расчёт на зрителя — гарантируется partial unique index в базе, а
  не только проверкой в коде, чтобы параллельными запросами нельзя было занять
  весь пул наград.
* Геометрия маршрута, уходящая зрителям, проходит тот же фильтр приватности,
  что и GPS: иначе первая точка полилинии выдавала бы точное положение
  стримера в обход задержки и округления.
* Секреты не попадают в бандл: в браузер уходит только public-токен Mapbox.
* Активация waypoint — транзакция Postgres + распределённый лок в Redis;
  «одно задание за раз» дополнительно гарантируется partial unique index.

---

## Архитектура

```
server/src/
  domain/      types, geo, pricing, settings, gps, quotes, slots,
               waypoints, waypointFlow   ← вся бизнес-логика
  twitch/      extJwt, tokens, helix, devHelix, rewards, oauth, eventsub
  maps/        mapbox (Directions + Geocoding, только сервер)
  http/        auth, rateLimit, routes/*
  realtime/    bus, io, gpsBroadcast     ← socket.io + Redis pub/sub
  jobs/        maintenance, gpsSimulator
  db/          pool, migrate, migrations/*.sql
web/src/
  viewer/  obs/  streamer/  admin/  dev/  shared/
docs/API.md    контракт HTTP и WebSocket
```

Состояние waypoint:

```
IDLE → QUOTING → AWAITING_REDEMPTION → ACTIVE → COMPLETED
                          ↓                ↓
                      CANCELED         CANCELED
```

Таблицы: `channels`, `broadcaster_oauth`, `channel_settings`,
`streamer_devices`, `gps_samples`, `waypoint_quotes`, `waypoints`,
`twitch_reward_slots`, `twitch_redemptions`, `eventsub_events`, `oauth_states`.

Redis: живой GPS и буфер задержки, кэш настроек и маршрутов, локи
(активация, лизинг слотов, обновление токена), идемпотентность EventSub,
рейт-лимиты, pub/sub между инстансами API.

---

## Диагностика

| Симптом | Причина |
| --- | --- |
| `mapbox: missing` в `/api/health` | не задан `MAPBOX_SERVER_TOKEN` |
| Карта серая | не задан `VITE_MAPBOX_PUBLIC_TOKEN` на сборке, или токен ограничен по URL |
| `needs_id_share` | не включён Request Identity Link в Extension |
| `gps_unavailable` | телефон не шлёт GPS, фикс старше `gpsTimeoutSeconds`, или точность хуже `maxGpsAccuracyMeters` |
| `no_free_slots` | все слоты заняты; увеличь `rewardSlotPoolSize` или нажми «СИНХР. СЛОТЫ» |
| `no_walking_route` / `too_far_from_walkable` | точка в море или вне пешеходной сети — это ожидаемое поведение |
| EventSub не приходит | `PUBLIC_API_URL` не публичный HTTPS, либо подписка на старом callback — нажми «СИНХР. EVENTSUB» |
| Награда не появилась у зрителя | не пройден broadcaster OAuth, или награды создало другое приложение |
| Цена в награде не совпала | расчёт устарел, зритель активировал старую награду — такой redemption отменяется с возвратом |
| Двойная карта в OBS | Extension в collapsed-состоянии должен быть прозрачным; проверь `--hit-*` и `--mm-*` |
| OBS показывает округлённые координаты | В URL браузер-сорса нет `?token=` — возьми полный адрес в админке |
| Сервер не стартует в production | Секреты остались дефолтными из `.env.example` — сообщение в логе называет какие |
| `quote_conflict` «у тебя уже есть активный расчёт» | Зритель дважды нажал очень быстро; старый расчёт заменяется автоматически, надо повторить |

Логи:

```bash
docker compose logs -f api
docker compose logs -f web
```
