# IRL Waypoint — notes for Twitch review

| | |
| --- | --- |
| Extension | **IRL Waypoint** |
| Version | 0.0.1 (first submission) |
| Client ID | `wjbmbxr2p39zcwwyybk3lt40zsks5x` |
| Author | Paracetamol |
| Review channel | https://www.twitch.tv/tiktokevelone888 (channel id 119989080). Usually **offline**: please review in the **Panel** (section 2, part A) |
| Types | Panel (`panel.html`, height 496), Video - Fullscreen (`video_overlay.html`), Mobile (`mobile.html`), Config (`config.html`) |
| Backend | https://gudinigta6.duckdns.org |
| Contact | twitchacc11112@outlook.com |
| Source | https://github.com/paracetamolhaze/gta-phuket |

The interface is in Russian, because the channel's audience speaks Russian.
Section 3 translates every string you will see.

---

## 1. What the extension does

IRL Waypoint is for an IRL ("in real life") stream: the streamer walks around
Phuket, Thailand, with a phone.

1. A viewer opens a map of Phuket over the video.
2. The viewer picks a place: searches for it or clicks it on the map.
3. The extension shows the walking route from the streamer's position, the
   distance, the walking time and a price in **GTA$**.
4. The viewer buys the waypoint with GTA$. The streamer gets the destination
   on their phone and walks there. Everyone watching sees the route on the map.

**GTA$** (full name "GTA DOLLAR") are points inside this extension. They are
not money: they cannot be bought with money, withdrawn or sold. The only way to
get them is to redeem one of the channel's own Channel Points rewards,
**«Обмен ETH на GTA DOLLAR»** ("Exchange ETH for GTA DOLLAR"). "ETH" is simply
what this channel calls its Channel Points. The reward costs 500 channel points
and gives GTA$ 5 000 (1 channel point = 10 GTA$). The redemption happens in
Twitch's own Rewards menu; the extension never reads or spends Channel Points.
There are no Bits.

The streamer always decides. If a waypoint is impossible or unsafe, the
streamer cancels it with **НЕ МОГУ** ("CAN'T") or **НЕБЕЗОПАСНО** ("UNSAFE")
and the viewer gets all the GTA$ back automatically.

---

## 2. Walkthrough

**How this review works.** The review channel,
https://www.twitch.tv/tiktokevelone888, is usually **offline**: the developer
is not a streamer. Twitch draws Video - Fullscreen extensions only over a live
stream, but it shows a **Panel** on the channel page all the time. So the
whole interface can be tested in the Panel while the channel is offline:
identity link, GTA$ balance, top-up instructions, map, search, walking route,
price, and the last waypoint. The backend runs with `REVIEW_DEMO_MODE=true` for
the whole review window, so the streamer's position is fixed at Patong Beach
and prices work at any time of day (section 4). The Panel never sells. Buying
happens on the video overlay, which shows the same map, but only while the
channel is live (part B).

### A. Panel, channel offline (the main path)

1. **Open the Panel.** Go to https://www.twitch.tv/tiktokevelone888 and scroll
   below the video to the **IRL WAYPOINT** panel. Its header reads
   **СТРИМЕР ОФЛАЙН** ("STREAMER OFFLINE"). The status comes from Twitch's Get
   Streams, called with the extension's helixToken. For a moment it may read
   **ПРОВЕРЯЕМ ЭФИР…** ("CHECKING THE STREAM…").

2. **Share your Twitch identity.** Under the header the panel says
   «Подключите Twitch, чтобы использовать GTA$» ("Connect Twitch to use GTA$"),
   with a **ПОДКЛЮЧИТЬ** ("CONNECT") button. The button calls
   `Twitch.ext.actions.requestIdShare()`, and Twitch shows its own permission
   prompt. After you accept, the button turns into your balance.
   Logged-out viewers see «Войдите в Twitch, чтобы использовать GTA$»
   ("Log in to Twitch to use GTA$") and can still look at the map.

3. **See the GTA$ balance and the top-up instructions.** The panel shows
   `GTA$ 0` and **+ ПОПОЛНИТЬ** ("+ TOP UP"). TOP UP opens a small window,
   «ПОПОЛНЕНИЕ GTA$» ("TOP UP GTA$"), which explains the exchange: the Channel
   Points reward «Обмен ETH на GTA DOLLAR», `500 ETH → GTA$ 5 000`,
   `1 ETH = 10 GTA$`, and where Twitch keeps channel rewards. The window does
   not open anything itself: an extension cannot open Twitch's Rewards menu.
   How the reward credits GTA$ is described in B.3.

4. **Pick a destination in Phuket.** Before you pick one, the panel reads
   «Выберите точку на карте или найдите её поиском.» ("Pick a point on the map
   or find it with search."). Type in the search box
   «Куда отправить стримера?» ("Where should the streamer go?"), for example
   `Jungceylon`, `Bangla Road` or `Patong Beach`, and choose a result. Or
   click anywhere on the map. Places outside Phuket are refused with
   «Эта точка вне Пхукета.» ("This place is outside Phuket.").

5. **See the route and the price.** First the panel reads
   «Считаем маршрут до «…»…» ("Calculating the route to …"). Then a card shows
   the place name, the walking distance and time (for example
   `0.8 км · ~9 мин` = 0.8 km, about 9 min), the price (for example
   `GTA$ 900`) and «Ваш баланс: GTA$ …» ("Your balance"). The walking route
   from the demo position is drawn on the map. Nothing is charged.

6. **The disabled button.** Under the price is **СТРИМЕР СЕЙЧАС ОФЛАЙН**
   ("STREAMER IS OFFLINE NOW"), greyed out and disabled. Nothing can be bought
   in the Panel. While the channel is live the button reads
   **ОТКРЫТЬ КАРТУ НА СТРИМЕ** ("OPEN THE MAP ON THE STREAM"). It still does
   not sell anything. It only shows a hint that points to the map button on
   the video.

7. **The last waypoint.** The bottom of the panel reads «Последняя точка»
   ("Last waypoint"). It shows the place, the distance, the status and when it
   happened. The status is **выполняется** (in progress), **стример дошёл**
   (the streamer arrived) or **отменена** (cancelled). The time reads, for
   example, `только что` (just now) or `5 мин назад` (5 min ago). Before the
   first waypoint it reads «Точек ещё не было.» ("No waypoints yet.").

### B. Video overlay (only while the channel is live)

Twitch draws the overlay only over a live stream. When the channel is offline
you will see Twitch's offline page and no map button. To test the overlay or a
purchase, write to twitchacc11112@outlook.com and we will go live for you. The
demo GPS stays on.

1. **Click "🗺 КАРТА" (MAP).** The stream shows a small map of the streamer's
   position in the lower-left corner of the video. The button is a dark bar
   directly above that map, exactly as wide as it. It sits well above Twitch's
   player controls. While the map is closed, the extension draws nothing else.
   The one exception is a small label while a waypoint is running:
   «Задание · <place> · <distance left>» ("Task"), just above the button. The
   map opens over the video. The **×** at the top left closes it, and so does
   Esc.
   *On the Twitch mobile app* the same button sits in a bar at the bottom of
   the extension: "IRL Waypoint · Отправьте стримера в точку на карте" and
   "🗺 КАРТА".

2. **The same steps as the Panel.** The strip along the top of the map holds
   the close button, the search box and the balance, with **ПОДКЛЮЧИТЬ** or
   **+ ПОПОЛНИТЬ**. Identity, balance, top-up, search, route and price work
   exactly as in A.2 to A.5. The card opens in the lower left of the map. The
   price is held for about a minute: «Цена действует ещё 59 с» ("Price valid
   for another 59 s"). After that, one click refreshes it.

3. **Get GTA$ with Channel Points.** In Twitch's chat, open the Channel Points
   menu (the button next to the chat input) and redeem
   **«Обмен ETH на GTA DOLLAR»** (500 channel points). Twitch sends the
   redemption to our backend through EventSub
   (`channel.channel_points_custom_reward_redemption.add`, HMAC-verified). The
   backend adds GTA$ 5 000 to the wallet of the Twitch user who redeemed and
   marks the redemption FULFILLED. Within a second or two the overlay (and
   the Panel) shows `+ GTA$ 5 000` and the new balance.
   A test account usually has fewer than 500 channel points on this channel.
   See section 5 to get GTA$ without them.

4. **Buy the waypoint.** Press **ОТПРАВИТЬ СТРИМЕРА** ("SEND THE STREAMER").
   The price is taken from the balance in one step and the card turns into
   **ТОЧКА ПРИНЯТА** ("WAYPOINT ACCEPTED") with «Остаток: GTA$ …»
   ("Remaining"). The route stays on the map for everyone, and the collapsed
   overlay shows «Задание · <place> · <distance left>» ("Task").
   Without enough GTA$ the card says «Недостаточно GTA$.» ("Not enough GTA$.")
   with a **+ ПОПОЛНИТЬ** button instead.
   What happens next is up to the streamer, on their phone:
   * arrives → **ТОЧКА ДОСТИГНУТА** ("WAYPOINT REACHED") for the buyer;
   * **НЕ МОГУ** ("CAN'T") or **НЕБЕЗОПАСНО** ("UNSAFE") → the waypoint is
     cancelled and the full price goes back to the buyer, shown as
     «Возврат за задание» ("Refund for the task") `+ GTA$ 900`.

   One waypoint runs at a time. While one is active, others see
   «Сейчас выполняется задание.» ("A task is in progress.").

### C. Config page

`config.html` is for the broadcaster only. It is a read-only status page:
backend, Twitch connection, EventSub, GPS, exchange reward, exchange rate,
payment mode, and a link to the owner's admin panel. Viewers never see it.

This version serves one channel only (id 119989080). On another channel the
backend rejects the extension token, so the map opens but nothing can be
priced or bought.

---

## 3. Glossary (Russian → English)

Everything a viewer can meet, in the order of the walkthrough.

| On screen | English |
| --- | --- |
| 🗺 КАРТА | 🗺 MAP |
| Открыть карту Пхукета | Open the map of Phuket (button tooltip) |
| Закрыть карту | Close the map |
| IRL Waypoint · Отправьте стримера в точку на карте | IRL Waypoint · Send the streamer to a point on the map (mobile bar) |
| Подключите Twitch, чтобы использовать GTA$ | Connect Twitch to use GTA$ |
| ПОДКЛЮЧИТЬ | CONNECT (asks Twitch to share your identity) |
| Войдите в Twitch, чтобы использовать GTA$ | Log in to Twitch to use GTA$ |
| Войдите в Twitch, чтобы выбрать точку. | Log in to Twitch to choose a point. |
| Нужно поделиться Twitch-аккаунтом, чтобы засчитать оплату. | You need to share your Twitch account for the payment to count. |
| Подключите Twitch для покупки. | Connect Twitch to buy. |
| Ваш баланс GTA$ / Ваш баланс: | Your GTA$ balance / Your balance: |
| + ПОПОЛНИТЬ | + TOP UP |
| ПОПОЛНЕНИЕ GTA$ | TOP UP GTA$ |
| Используйте награду Twitch: | Use the Twitch reward: |
| «Обмен ETH на GTA DOLLAR» | "Exchange ETH for GTA DOLLAR" (the Channel Points reward) |
| 500 ETH → GTA$ 5 000 · 1 ETH = 10 GTA$ | 500 channel points → GTA$ 5,000 · 1 channel point = 10 GTA$ |
| Награды канала открываются кнопкой баллов рядом с полем ввода чата. GTA$ придут сюда сами. | Channel rewards open from the points button next to the chat input. GTA$ will arrive here by themselves. |
| Обмен сейчас недоступен. Попробуйте позже. | The exchange is unavailable right now. Try later. |
| GTA$ зачислены | GTA$ credited |
| Баланс: | Balance: |
| Куда отправить стримера? | Where should the streamer go? (search box) |
| Очистить | Clear (search box) |
| Ищем… / Ничего не нашли | Searching… / Nothing found |
| Нажмите на место на карте или найдите его поиском | Click a place on the map or find it with search |
| Точка на карте | Point on the map |
| Считаем маршрут… | Calculating the route… |
| км · м · ~мин · ч | km · m · ~min · h |
| Цена действует ещё 59 с | Price valid for another 59 s |
| Цена устарела. / Обновить цену | The price has expired. / Refresh the price |
| ОТПРАВИТЬ СТРИМЕРА | SEND THE STREAMER |
| Недостаточно GTA$. | Not enough GTA$. |
| Повторное нажатие не спишет GTA$ дважды. | Pressing again will not charge GTA$ twice. |
| Нет связи с сервером. Попробуйте ещё раз. | No connection to the server. Try again. |
| ТОЧКА ПРИНЯТА | WAYPOINT ACCEPTED |
| Остаток: | Remaining: |
| Стример уже в пути. Маршрут — на карте. | The streamer is on the way. The route is on the map. |
| Идёт задание: … / Задание | Task in progress: … / Task |
| ТОЧКА ДОСТИГНУТА | WAYPOINT REACHED |
| Задание выполнено. Можно выбирать следующую точку. | Task done. You can choose the next point. |
| Возврат за задание | Refund for the task |
| Задание отменено. / Точка отменена. | The task was cancelled. / The point was cancelled. |
| Не получилось | That did not work |
| Пересчитать цену | Recalculate the price |
| Цена изменилась. Выберите точку заново. | The price changed. Choose the point again. |
| Расчёт устарел. / Расчёт не найден. / Этот расчёт уже использован. Выберите точку заново. | The quote expired. / Quote not found. / This quote was already used. Choose the point again. |
| Кто-то оплатил раньше. GTA$ не списаны. | Someone paid first. No GTA$ were taken. |
| Сейчас выполняется задание. (Следующую точку можно будет выбрать после завершения.) | A task is in progress. (You can choose the next point after it ends.) |
| Приём точек сейчас закрыт. | Waypoints are closed right now. |
| GPS стримера временно недоступен. | The streamer's GPS is temporarily unavailable. |
| Эта точка вне Пхукета. | This place is outside Phuket. |
| Эта зона закрыта стримером. | The streamer has closed this area. |
| Точка слишком далеко. | The point is too far. |
| Сюда нельзя построить пеший маршрут. | No walking route can be built to here. |
| Картографический сервис не ответил. Попробуйте ещё раз. | The map service did not answer. Try again. |
| Слишком часто. Подождите пару секунд. | Too often. Wait a couple of seconds. |
| Twitch ещё подключается. Попробуйте через пару секунд. | Twitch is still connecting. Try in a couple of seconds. |
| Twitch не подтвердил сессию. Обновите страницу. | Twitch did not confirm the session. Reload the page. |
| Что-то пошло не так. Попробуйте ещё раз. | Something went wrong. Try again. |
| Ресторан, Кафе, Бар, Пляж, Отель, Парк, Магазин, Торговый центр, Музей, Достопримечательность, Место, Адрес | Restaurant, Cafe, Bar, Beach, Hotel, Park, Shop, Shopping mall, Museum, Sight, Place, Address (place categories) |

Panel only (`panel.html`):

| On screen | English |
| --- | --- |
| IRL WAYPOINT | the extension's name (panel header) |
| СТРИМЕР ОФЛАЙН / В ЭФИРЕ / ПРОВЕРЯЕМ ЭФИР… | STREAMER OFFLINE / LIVE / CHECKING THE STREAM… |
| Выберите точку на карте или найдите её поиском. | Pick a point on the map or find it with search. |
| Считаем маршрут до «…»… | Calculating the route to "…"… |
| СТРИМЕР СЕЙЧАС ОФЛАЙН | STREAMER IS OFFLINE NOW (the disabled main button) |
| ОТКРЫТЬ КАРТУ НА СТРИМЕ | OPEN THE MAP ON THE STREAM (the main button while live) |
| Точка отправляется на видео: нажмите «🗺 КАРТА» у левого края плеера и выберите это место там. | Waypoints are sent from the video: press «🗺 MAP» at the left edge of the player and choose this place there. |
| Последняя точка / Точек ещё не было. | Last waypoint / No waypoints yet. |
| выполняется / стример дошёл / отменена | in progress / the streamer arrived / cancelled |
| только что / 5 мин назад / 2 ч назад | just now / 5 min ago / 2 h ago |

Streamer phone page (not part of the extension, for context):
**ЗАВЕРШИТЬ** = COMPLETE, **НЕ МОГУ** = CAN'T, **НЕБЕЗОПАСНО** = UNSAFE.

Config page headings: «Статус расширения» = extension status,
«Только для владельца канала» = channel owner only,
«ОТКРЫТЬ АДМИН-ПАНЕЛЬ» = OPEN THE ADMIN PANEL,
«Включён демонстрационный GPS для проверки Twitch» = demo GPS for the Twitch
review is on.

---

## 4. Demo GPS during review

A real walk cannot be scheduled around a review, so the backend runs with
`REVIEW_DEMO_MODE=true` for the review window. The streamer's position is then
fixed at **Patong Beach** (7.8961 N, 98.2958 E) and is always fresh, so routes
and prices work at any time of day and do not depend on the streamer walking.
The demo position is the same for every viewer of the channel; the config page
says the demo is on. The demo is on for the whole review window, whether the
channel is live or offline, so the Panel can price places on an offline
channel too. It is switched off when the review is over.

---

## 5. Test accounts and GTA$

* No special account is needed: any Twitch account can open the Panel (or,
  while the channel is live, the overlay), share its identity, search, and see
  routes and prices.
* To test a purchase you need GTA$ and a live channel, because purchases
  happen only on the video overlay. The normal way to get GTA$ is step B.3
  (500 channel points), but a new account rarely has 500 points on this
  channel. Write to **twitchacc11112@outlook.com** with the Twitch login of
  your test account and the owner will credit it with GTA$ through the admin
  ledger adjustment (it is recorded in the wallet ledger like any other
  change). The new balance shows in the Panel too. Say so if you also want
  the channel live for a purchase test.

---

## 6. Backend availability

* All API and realtime traffic goes to **https://gudinigta6.duckdns.org**
  (REST under `/api/`, Socket.IO under `/socket.io/`, WebSocket with an HTTPS
  long-polling fallback). Health check: https://gudinigta6.duckdns.org/api/health.
* It runs on the author's own server with a Let's Encrypt certificate. It is
  kept online for the whole review window. If it does not answer, write to
  twitchacc11112@outlook.com.
* Map tiles, styles and fonts come straight from Mapbox (`api.mapbox.com`,
  plus Mapbox GL's own telemetry to `events.mapbox.com`). Place search and
  walking routes are asked by our server, not by the browser.

---

## 7. Data we store

* Nothing until a viewer shares their identity. The map works without it.
* After identity share: the numeric Twitch user ID, its GTA$ balance and
  ledger, and the waypoints it priced or bought (place, route, price).
* From Twitch EventSub for the exchange reward: redemption ID, reward ID, cost,
  user ID, login and display name.
* The streamer's phone GPS (raw history deleted after 24 hours).
* Extension diagnostics and page request log: no tokens, no user IDs, no IP
  addresses; 7 days.
* No email, passwords, payment data, viewer location, ads or analytics.
  Viewer tokens are verified and never stored or logged.

Privacy policy: https://gudinigta6.duckdns.org/privacy
Terms of service: https://gudinigta6.duckdns.org/terms
Data requests: twitchacc11112@outlook.com

---

## 8. Human-readable code

* Our code is TypeScript + React 18, built with Vite 5 (Rollup). The review
  zip is built **without minification**: variable names and structure are
  kept, one statement per line. Comments are removed by the TypeScript
  compile step; the commented source is public:
  **https://github.com/paracetamolhaze/gta-phuket** (folder `web/`).
* Third-party libraries are the production builds their authors publish, each
  in its own `vendor-*` file, so it is clear where the minified parts come
  from. Nothing in them is changed by hand; the bundler only wraps them as
  modules and re-prints them with line breaks (short names such as `t` may
  become `t2` where two scopes meet). License headers are kept.

  | File in the zip | Library | Version | Published file it comes from | Source |
  | --- | --- | --- | --- | --- |
  | `assets/vendor-mapbox-gl-*.js` | Mapbox GL JS, CSP build | 3.31.0 | `mapbox-gl/dist/mapbox-gl-csp.js` (minified by Mapbox) | https://github.com/mapbox/mapbox-gl-js |
  | `assets/vendor-mapbox-gl-*.css` | Mapbox GL JS styles | 3.31.0 | `mapbox-gl/dist/mapbox-gl.css` | same |
  | `assets/mapbox-gl-csp-worker-*.js` | Mapbox GL JS, CSP worker | 3.31.0 | `mapbox-gl/dist/mapbox-gl-csp-worker.js`, byte for byte except its last line, a `sourceMappingURL` comment (no `.map` is shipped) | same |
  | `assets/vendor-react-*.js` | React, React DOM, scheduler | 18.3.1, 18.3.1, 0.23.2 | `react/cjs/react.production.min.js`, `react/cjs/react-jsx-runtime.production.min.js`, `react-dom/cjs/react-dom.production.min.js`, `scheduler/cjs/scheduler.production.min.js` (minified by the React team) | https://github.com/facebook/react |
  | `assets/vendor-socket.io-*.js` | Socket.IO client | socket.io-client 4.8.3, engine.io-client 6.6.6, socket.io-parser 4.2.7, engine.io-parser 5.2.3, @socket.io/component-emitter 3.1.2 | the packages' ESM builds (not minified) | https://github.com/socketio/socket.io |

  Every other file under `assets/` is our own code.

  We use the Mapbox **CSP** build on purpose: the default build starts its
  worker from a `blob:` URL, which the extension CSP forbids.
* `gtamap-boot.js` is our own readable diagnostics script (it tells our backend
  whether the page, the helper and the app loaded; no tokens or user IDs).
* There is no `eval`, no `new Function`, no `blob:` worker, no inline script
  and no remote script except Twitch's helper
  (`https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js`, first on
  every page).

**Build the zip yourself** (Node.js 20 or newer; we use Node 24 and npm 11):

```bash
git clone https://github.com/paracetamolhaze/gta-phuket.git
cd gta-phuket
npm ci
npm run ext:build -w web
# → web/twitch-extension.zip
```

`ext:build` builds with fixed settings (production, DEV_MODE off, SMOKE_TEST
off, API base https://gudinigta6.duckdns.org, unminified), packs the three
pages and exactly the files they load, and refuses to finish unless the zip
passes its own checks: files at the zip root with `/` paths and matching the
build, no source maps, no localhost URLs, no developer endpoints, no admin or
streamer pages, no `eval`, the Twitch helper first on every page. The Mapbox
public token is optional (`MAPBOX_PUBLIC_TOKEN` in the environment); the
extension also gets it from the backend. Two builds differ only in the
`?v=` cache-busting value in the three HTML files.

---

## 9. Twitch capabilities

| Setting | Value | Why |
| --- | --- | --- |
| Request Identity Link | **Yes** | The GTA$ wallet belongs to the numeric Twitch user ID, the same ID Twitch puts in the Channel Points redemption. |
| Bits | No | |
| Chat capabilities | No | The extension never writes to chat. |
| Subscriptions | No | |
| Configuration service | Our own backend | No Twitch Configuration Service is used. |
| Allowlist for URL Fetching Domains | `https://gudinigta6.duckdns.org`, `wss://gudinigta6.duckdns.org`, `https://api.mapbox.com`, `https://events.mapbox.com` | Our API and its WebSocket; Mapbox map data and Mapbox GL telemetry. |
| Allowlist for Image / Media Domains | empty | Mapbox images are fetched, not loaded as `<img>`; no audio or video. |

Twitch helper calls used: `onAuthorized`, `onContext`, `onVisibilityChanged`,
`onHighlightChanged`, `onError`, `actions.requestIdShare`.

---

## 10. No affiliation

IRL Waypoint is an independent project. It is not affiliated with, endorsed or
sponsored by Rockstar Games or Take-Two Interactive. "GTA DOLLAR" / "GTA$" is
only the name of the points inside this extension; the extension uses no
Rockstar or Grand Theft Auto logos, artwork or fonts.

---

## Change log

0.0.1 — first submission.
