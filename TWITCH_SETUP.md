# TWITCH_SETUP

Точные значения из текущего состояния репозитория. Всё, что ниже, взято из кода
и из собранного бандла, а не из общих соображений. Там, где чего-то в проекте
**нет**, это написано прямым текстом, а не додумано.

Проверено на коммите, указанном в конце файла.

---

## 1. Что пакуется в Twitch Extension ZIP

| | |
| --- | --- |
| Источник | `web/dist/` (результат `vite build`) |
| Скрипт упаковки | `web/scripts/build-extension.mjs` |
| Промежуточная папка | `web/extension-build/` (пересоздаётся при каждом запуске) |
| Готовый архив | `web/twitch-extension.zip` |

В архив попадает **только то, что реально ссылается `viewer.html`**: тег
`<script>`, все `<link rel="modulepreload">` и все `<link rel="stylesheet">`,
которые сгенерировал Vite. Остальные поверхности (`admin`, `dev`, `obs`,
`streamer`, `index`) собираются в тот же `web/dist/`, но в ZIP **не входят**.

Текущее содержимое архива — 8 файлов, 2 363 825 байт до сжатия:

```
viewer.html
assets/viewer-C7YjLf6V.js
assets/viewer-CENqhidv.css
assets/theme--rnq9CYI.js
assets/theme-DdchbWf_.css
assets/format-DNmQ8WYL.js
assets/mapbox-gl-Q22Il8vp.js      1 883 446 B  ← 80% веса бандла
assets/mapbox-gl-CDjm9ImO.css
```

Хеши в именах меняются при каждой пересборке — сверяйся со свежим ZIP, а не с
этим списком.

`viewer.html` в архиве лежит **в корне**, и ссылки на ассеты переписаны из
абсолютных (`/assets/...`) в относительные (`assets/...`) — иначе Twitch их не
найдёт.

---

## 2. Пути в Developer Console → Extension → Asset Hosting

| Поле в консоли | Значение | Откуда |
| --- | --- | --- |
| **Video - Fullscreen Path** | `viewer.html` | `web/viewer.html`, вход в `web/vite.config.ts` |
| **Video - Component Path** | `viewer.html` | тот же файл, если включаешь Component |
| **Mobile Path** | `viewer.html` | отдельного мобильного входа нет — см. ниже |
| **Config Path** | **не используется** | в проекте нет `config.html` |
| **Live Config Path** | **не используется** | в проекте нет `live_config.html` |
| **Panel / Video - Overlay** | не используется | |

### Про Mobile Path

Отдельного мобильного бандла нет. Тот же `viewer.html` определяет платформу по
query-параметру, который добавляет сам Twitch:

`web/src/viewer/twitch.ts:87-93` читает `platform` и нормализует его в
`'web' | 'mobile' | 'other'`. На `mobile` (и на ширине < 640px) интерфейс
переключается с прозрачной кликабельной зоны на нижний лист с кнопкой.

### Про Config / Live Config

Настройки канала (цена, лимиты, приватность, запретные зоны) живут в собственной
админке `admin.html` на нашем сервере и правятся через `PUT /api/admin/settings`.
Страницы конфигурации внутри Twitch сейчас нет. Если ревьюер спросит «почему» —
это осознанный выбор, а не пропуск: админка нужна во время стрима и должна быть
доступна с телефона, а не только из дашборда Twitch.

---

## 3. Testing Base URI для Local Test

**Текущее состояние: готового значения проект не даёт, и это надо исправить
перед Local Test.**

Факты:

* dev-сервер Vite слушает `0.0.0.0:5173` по **HTTP** (`web/vite.config.ts:22-24`);
* HTTPS в конфиге не настроен вообще (`grep -c https web/vite.config.ts` → `0`);
* Twitch для Local Test требует **HTTPS**.

То есть подставить сейчас можно только:

```
https://localhost:5173/
```

…но работать оно начнёт лишь после того, как dev-сервер поднимут по HTTPS
(самоподписанный сертификат + `server.https` в `web/vite.config.ts`, либо
любой локальный TLS-прокси перед портом 5173). Пока этого нет — Local Test
через этот репозиторий не заработает; Hosted Test (загруженный ZIP) заработает.

---

## 4. Backend / EBS

| | Значение |
| --- | --- |
| Переменная | `PUBLIC_API_URL` |
| Текущее значение в `.env` | `http://localhost:4000` |
| Что нужно для Hosted Test | публичный **HTTPS**-origin, например `https://api.example.com` |
| Порт внутри контейнера | `4000` (`docker-compose.yml`, `PORT: 4000`) |

`PUBLIC_API_URL` — единственный источник и для EventSub-колбэка, и для OAuth
redirect URI, они строятся из него в коде:

* `server/src/twitch/eventsub.ts:436-438`
* `server/src/twitch/oauth.ts:19-21`

### EventSub callback path

```
/api/eventsub/twitch
```

Полный URL: `${PUBLIC_API_URL}/api/eventsub/twitch`
Сейчас это `http://localhost:4000/api/eventsub/twitch` — **Twitch на localhost не
ходит**, для реального EventSub нужен публичный HTTPS (ngrok / cloudflared /
сервер).

Подписки, которые создаёт приложение
(`server/src/twitch/eventsub.ts`, `ensureEventSubSubscriptions`):

* `channel.channel_points_custom_reward_redemption.add` (v1)
* `channel.channel_points_custom_reward_redemption.update` (v1)

Условие: `{ broadcaster_user_id: TWITCH_CHANNEL_ID }`, транспорт `webhook`,
секрет — `TWITCH_EVENTSUB_SECRET`.

### Broadcaster OAuth redirect URI

```
${PUBLIC_API_URL}/api/oauth/twitch/callback
```

Сейчас: `http://localhost:4000/api/oauth/twitch/callback`

Ровно эту строку надо вписать в **Developer Console → Applications → твоё
приложение → OAuth Redirect URLs**. Она должна совпадать символ в символ.

Запрашиваемые scopes (`server/src/twitch/tokens.ts:13`):

```
channel:manage:redemptions
channel:read:redemptions
```

---

## 5. Allowlists в Developer Console → Extension → Capabilities

Что реально грузит собранный `viewer.html` во время работы:

### Allowlist for URL Fetching Domains

| Домен | Зачем | Доказательство |
| --- | --- | --- |
| хост из `VITE_API_BASE` | весь наш REST + WebSocket (`/api/ext/*`, `/socket.io`) | `web/src/shared/api.ts`, `web/src/shared/socket.ts` |
| `api.mapbox.com` | стиль, векторные тайлы, спрайты, глифы | `API_URL:"https://api.mapbox.com"` в `node_modules/mapbox-gl/dist/mapbox-gl.js` |
| `events.mapbox.com` | телеметрия Mapbox GL, включена по умолчанию | `https://events.mapbox.com/events/v2` там же |

Телеметрию Mapbox проект не отключает (`grep setTelemetryEnabled web/src` — пусто),
поэтому `events.mapbox.com` надо либо разрешить, либо явно отключить в коде.

### Allowlist for Image Domains

| Домен | Зачем |
| --- | --- |
| `api.mapbox.com` | спрайты и растровые изображения стиля приходят с того же хоста |

### Allowlist for Media Domains

**Пусто.** Расширение не проигрывает ни аудио, ни видео.

### Шрифты

Внешних шрифтов нет. `web/src/shared/theme.css:33` объявляет
`'Inter', -apple-system, …`, но `Inter` нигде не подгружается — фактически
используется системный стек. Google Fonts подключать не нужно.

---

## 6. Обязательные переменные окружения для Twitch

Читаются сервером (проверено `grep -oE "env\.(TWITCH_|PUBLIC_)[A-Z_]+" -r server/src`):

| Переменная | Обязательна | Где используется |
| --- | --- | --- |
| `TWITCH_EXT_SECRET` | **да** | проверка JWT зрителя, `server/src/twitch/extJwt.ts`. base64 из Extension → Settings → Secret Keys |
| `TWITCH_CHANNEL_ID` | **да** | привязка канала, сверка `channel_id` в JWT, условие EventSub. Числовой id, не логин |
| `TWITCH_CLIENT_ID` | **да** | Helix: Custom Rewards + EventSub |
| `TWITCH_CLIENT_SECRET` | **да** | обмен кода OAuth, app access token |
| `TWITCH_EVENTSUB_SECRET` | **да** | HMAC-подпись вебхука, 10–100 символов |
| `PUBLIC_API_URL` | **да** | из него строятся EventSub callback и OAuth redirect |
| `PUBLIC_WEB_URL` | да | куда вернуть браузер после OAuth; allow-list для redirect |

Для браузерного бандла (подставляются на этапе `vite build`):

| Переменная | Обязательна | Примечание |
| --- | --- | --- |
| `VITE_API_BASE` | **да для Hosted Test** | сейчас в `.env` **пустая** — бандл будет стучаться в свой origin на CDN Twitch и упадёт |
| `VITE_MAPBOX_PUBLIC_TOKEN` | да | `pk.…`, запасной источник токена; основной приходит из `GET /api/ext/config` |
| `VITE_MAPBOX_STYLE_URL` | нет | по умолчанию `mapbox://styles/mapbox/dark-v11` |
| `VITE_DEV_MODE` | нет | в прод-сборке должна быть `false` |

### Объявлено, но не используется

Честно, чтобы ревьюер не искал:

* `TWITCH_EXT_CLIENT_ID` — есть в схеме `server/src/env.ts:29`, но нигде не
  читается. Extension client id сейчас не нужен: JWT проверяется секретом.
* `VITE_TWITCH_CHANNEL_ID` — передаётся в `docker-compose.yml`, но фронтенд его
  не читает (channelId приходит из JWT и из `/api/ext/config`).

---

## 7. Команды

### Локальный запуск (весь стек, включая раздачу extension-файлов)

```bash
docker compose up -d
```

Поднимает `web` (Vite, `:5173`), `api` (`:4000`), `postgres` (`:55432`),
`redis` (`:63790`). `viewer.html` становится доступен на
`http://localhost:5173/viewer.html`.

Только фронтенд, без Docker:

```bash
npm run dev -w web
```

Проверить всю цепочку одной командой:

```bash
node scripts/acceptance.mjs
```

### Production build расширения

```bash
VITE_API_BASE=https://api.example.com \
VITE_MAPBOX_PUBLIC_TOKEN=pk.xxxxx \
VITE_DEV_MODE=false \
npm run build -w web && npm run ext:zip -w web
```

`VITE_API_BASE` обязателен: без него скрипт упаковки печатает предупреждение, а
собранный бандл на CDN Twitch будет обращаться сам к себе.

### Где лежит готовый ZIP

```
D:\gta-phuket\web\twitch-extension.zip
```

Размер на текущей сборке — 665 675 байт (0.63 МБ). В git **не коммитится**
(`.gitignore`: `*.zip`, `extension-build/`), это артефакт сборки.

---

## 8. Проверка CSP: внешние скрипты и воркеры

Проверялся собранный бандл, а не исходники.

### Внешние `<script>` в `viewer.html`

Ровно один:

```html
<script src="https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js"></script>
```

Это **официальный Twitch Extension Helper**. Он не блокируется — это домен
самого Twitch, и это документированный способ его подключения. Никаких других
CDN нет:

```
grep -rnoE "https?://[a-zA-Z0-9.-]+" web/src web/*.html web/public
→ https://extension-files.twitch.tv   (helper, viewer.html)
→ https://www.google.com              (ссылка «OPEN NAVIGATION» в streamer PWA — в ZIP не входит)
→ http://www.w3.org                   (xmlns у SVG, не сетевой запрос)
```

`mapbox-gl` и `socket.io-client` собираются в бандл через npm, с CDN не тянутся.
Google Fonts и Google Analytics не используются.

### ⚠ Реальный риск: Mapbox GL создаёт Web Worker из `blob:`

Это **не** проблема CDN, но это то, что с большой вероятностью сломает
расширение именно под CSP Twitch, поэтому фиксирую отдельно.

В собранном чанке `assets/mapbox-gl-Q22Il8vp.js` (mapbox-gl **3.31.0**) есть:

```js
window.URL.createObjectURL(new Blob([so], { type: "text/javascript" }))
```

— воркер собирается из Blob и запускается по `blob:`-URL. CSP расширений Twitch
такие воркеры запрещает: на форуме разработчиков это описано как
`Failed to construct 'Worker': Access to the script at 'blob:…' is denied by the
document's Content Security Policy`, и ответ там — что blob подпадает под запрет
`eval` из раздела 2.6 политик расширений.

**Локально этого не видно** (обычная страница без CSP Twitch), поэтому карта в
`/dev.html` работает, а в Hosted Test может не подняться.

Штатное решение существует и лежит прямо в зависимостях — Mapbox отдаёт
CSP-совместимую сборку:

```
node_modules/mapbox-gl/dist/mapbox-gl-csp.js
node_modules/mapbox-gl/dist/mapbox-gl-csp-worker.js
```

Её нужно использовать вместо обычной и указать
`mapboxgl.workerUrl = 'assets/mapbox-gl-csp-worker.js'`, положив файл воркера в
ZIP. Сейчас это **не сделано** — намеренно, потому что менять сборку прямо перед
ревью не просили. Это первое, что нужно починить перед Hosted Test.

### Прочее, что проверено

* Инлайновых `<script>` в `viewer.html` нет — только внешние файлы.
* Инлайновых `on*`-атрибутов нет.
* `eval` / `new Function` в нашем коде нет.
* Динамических `import()` в чанке `viewer` нет (`grep -c "import(" → 0`), то есть
  во время работы бандл не подгружает с нашего origin ничего сверх того, что уже
  лежит в ZIP.

---

## 9. Чего не хватает до Hosted Test — короткий список

1. Заменить `mapbox-gl` на CSP-сборку + `workerUrl` (раздел 8).
2. Пересобрать с `VITE_API_BASE=https://…` (раздел 6).
3. Поднять `PUBLIC_API_URL` на публичном HTTPS, иначе EventSub не придёт.
4. Вписать redirect URI в Twitch Application (раздел 4).
5. Включить **Request Identity Link** в Capabilities — без реального `user_id`
   redemption невозможно сопоставить со зрителем, сервер отдаёт `needs_id_share`.
6. Заполнить allowlists (раздел 5).
7. Для Local Test — HTTPS на dev-сервере (раздел 3).

---

## 10. Координаты репозитория

```
Repository: https://github.com/paracetamolhaze/gta-phuket
Branch:     master
Commit:     8b1570b
```

`8b1570b` — состояние, которое описано в этом файле. Финальный коммит с этим
разделом идёт следом; на содержимое разделов 1–9 он не влияет.

### Что показывать на ревью

**Минимум — 8 файлов, покрывают весь денежный путь и CSP:**

| Файл | Что в нём смотреть |
| --- | --- |
| `TWITCH_SETUP.md` | этот файл — конфигурация и известные дыры |
| `server/src/twitch/eventsub.ts` | подпись вебхука, идемпотентность, транзакция активации, возвраты |
| `server/src/domain/waypointFlow.ts` | расчёт → подтверждение → резерв слота |
| `server/src/domain/slots.ts` | лизинг слотов, `FOR UPDATE SKIP LOCKED` |
| `server/src/db/migrations/001_init.sql` | инварианты, которые держит база, а не код |
| `server/src/twitch/extJwt.ts` | проверка JWT зрителя |
| `web/src/viewer/twitch.ts` | мост к Extension Helper, dev-фолбэк |
| `web/scripts/build-extension.mjs` | что именно уезжает в ZIP |

**Полный набор — добавь к минимуму:**

* контракт и документация: `docs/API.md`, `README.md`
* состояние и цена: `server/src/domain/waypoints.ts`, `server/src/domain/quotes.ts`,
  `server/src/domain/pricing.ts`, `server/src/domain/privacy.ts`
* Twitch API: `server/src/twitch/helix.ts`, `server/src/twitch/tokens.ts`,
  `server/src/twitch/oauth.ts`, `server/src/twitch/rewards.ts`
* безопасность и конфиг: `server/src/env.ts`, `server/src/app.ts`,
  `server/src/http/auth.ts`, `server/src/realtime/io.ts`
* сборка расширения: `web/viewer.html`, `web/vite.config.ts`
* миграция с ограничением «один живой расчёт на зрителя»:
  `server/src/db/migrations/002_quote_per_viewer.sql`
* тесты, если ревьюер захочет проверить утверждения:
  `server/test/redemption.test.ts`, `server/test/hardening.test.ts`

### Вопросы, которые стоит задать ревьюеру

1. Подтверждает ли он, что blob-воркер Mapbox (раздел 8) действительно упадёт
   под CSP расширений, и что переход на `mapbox-gl-csp` — правильное решение.
2. Достаточно ли пула из 10 наград, или стоит считать нагрузку иначе.
3. Не ломается ли схема возвратов, если Twitch отдаст `FULFILLED` раньше, чем
   наш вебхук успеет отработать.
