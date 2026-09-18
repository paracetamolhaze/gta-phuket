# Twitch extension diagnostics — contract

Goal: the owner never opens DevTools. Every Twitch iframe load reports what
happened to the backend by itself, and `/admin` shows it together with a
one-line verdict. Viewers see nothing of this.

Three independent sources, so a failure in one never hides the others:

| Source | Runs where | Depends on | Proves |
|---|---|---|---|
| Request log | ingress Caddy (and the Vite dev server) | nothing in the page | Twitch actually asked for the page, with which Referer / Sec-Fetch-Dest |
| Boot script `gtamap-boot.js` | classic `<script>`, second in `<head>`, right after the Twitch helper | the HTML only | the HTML parsed, the helper exists, onAuthorized, errors, CSP, iframe size |
| App diagnostics `web/src/viewer/diag.ts` | the React bundle | boot script (falls back to its own sender) | bundle ran, trigger rendered and visible, map opened |

Nothing here may send a JWT, OAuth token, helix token, secret, cookie, query
token or the viewer's user id. The viewer is reduced to a kind:
`anonymous` (opaque id starting with `A`), `logged_in` (opaque id starting with
`U`, identity not shared) or `identified` (numeric user id present).

---

## 1. Page structure (Twitch entries: video_overlay.html, mobile.html, config.html)

The HTML sources keep only the helper tag and `#root`. The Vite plugin in
`web/vite.config.ts` (transformIndexHtml, `order: 'post'`) produces, for the
three Twitch entries, in the dev server and in the build alike:

```html
<head>
  <script src="https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js"></script>
  <meta name="gtamap-boot" data-surface="video_overlay" data-api-base="" data-smoke="true" data-dev="true">
  <script src="./gtamap-boot.js?v=BUILD_ID"></script>          <!-- dev server: /gtamap-boot.js?v=dev -->
  <link rel="stylesheet" href="./gtamap-raw.css?v=BUILD_ID">   <!-- video_overlay + SMOKE_TEST only -->
  ...everything else Vite emitted (charset, viewport, title, module script, modulepreload, css)
</head>
<body class="page-viewer">
  <button type="button" id="gtamap-raw-trigger" class="gtamap-raw-trigger" data-state="html">EXTENSION LOADED</button>
                                                               <!-- video_overlay + SMOKE_TEST only -->
  <div id="root"></div>
```

* The helper stays the very first script. The boot script is the second
  script and is a plain classic script from our own origin (allowed by the
  Twitch extension CSP as `'self'`): no inline script, no eval, no module.
* `data-surface`: `video_overlay` | `mobile` | `config`.
* `data-api-base`: `VITE_API_BASE` (empty = same origin).
* `data-smoke` / `data-dev`: `"true"` or `"false"` from `VITE_SMOKE_TEST` /
  `VITE_DEV_MODE`, read from Vite's resolved env.
* `BUILD_ID`: a per-build token (e.g. base36 timestamp) so the non-hashed
  public files are never served stale after a rebuild. `v=dev` in the dev server.
* Files live in `web/public/` (`gtamap-boot.js`, `gtamap-raw.css`) and are
  copied to `dist/` root by Vite. `web/scripts/build-extension.mjs` must copy
  them into the extension zip (strip the `?v=` query when resolving).
* The raw button depends on nothing but the HTML and one same-origin
  stylesheet. When the stylesheet did not apply (failed or refused fetch —
  the bundle's own CSS would otherwise strip it to click-through text), the
  boot script sets the same essentials inline through CSSOM at
  DOMContentLoaded and reports `html_loaded.data.rawCss = false`.

`gtamap-raw.css`: `position: fixed; left: 10%; top: 25%`, large (≥ 220×64),
high-contrast (yellow on black border), `z-index: 2147483000`,
`pointer-events: auto`, visible without any other CSS. `[hidden]` hides it.
`[data-state="react"]` restyles it as the map button.

When React is up (SMOKE_TEST only) it adopts the raw button: text becomes
`🗺 КАРТА`, `data-state="react"`, `pointer-events: auto` (CSSOM), click opens
the map, `hidden` while the map is open. If the raw button is visible and the
React button is not, the app is at fault — the raw button is measured apart
from the map button and never stands in for it (§3, §5). If neither is visible while the request log shows a GET from
`supervisor.ext-twitch.tv`, the iframe itself is hidden/sized by Twitch — the
boot script's viewport / visibility fields say which.

---

## 2. Boot script `web/public/gtamap-boot.js`

ES2017, IIFE, no dependencies, never throws out (every hook wrapped in
try/catch). Exposes `window.__GTAMAP_BOOT__`:

```ts
interface GtamapBoot {
  version: 1;
  session: string;              // random, /^[A-Za-z0-9_-]{16,32}$/, per page load
  surface: 'video_overlay' | 'mobile' | 'config' | 'unknown';
  apiBase: string;              // '' = same origin
  smoke: boolean;
  dev: boolean;
  send(event: DiagEventName, data?: Record<string, unknown>): void;
  setSnap(partial: Partial<DiagSnapshot>): void;
  snapshot(): DiagSnapshot;
  markAppLoaded(): void;        // called by the React bundle
  measureTrigger(el: Element | null, which: 'react' | 'raw'): TriggerInfo;
  /** True when the boot script registered the Twitch helper callbacks. */
  wired: boolean;
  /**
   * Fan-out of the helper callbacks. The helper keeps ONE listener per
   * callback (removeAllListeners before addListener), so only the boot script
   * may register onAuthorized / onContext / onVisibilityChanged /
   * onHighlightChanged / onError. Late subscribers get the latest value
   * replayed immediately.
   */
  twitch: {
    on(kind: 'authorized', cb: (auth: ExtAuth) => void): () => void;
    on(kind: 'context', cb: (ctx: object, changed: string[]) => void): () => void;
    on(kind: 'visibility', cb: (visible: boolean, ctx: object | null) => void): () => void;
    on(kind: 'highlight', cb: (highlighted: boolean) => void): () => void;
    on(kind: 'error', cb: (err: unknown) => void): () => void;
  };
}
```

Boot sequence:

1. Read `meta[name=gtamap-boot]`, create the session, build the static part
   of the snapshot (framed, pageOrigin, referrerOrigin, ancestorOrigins,
   params, surface, smoke, dev).
2. Install immediately: `securitypolicyviolation` (→ `csp_violation`),
   `error` on window in the capture phase (script/link/img load failures →
   `resource_error`; others → `runtime_error`), `unhandledrejection`
   (→ `unhandled_rejection`), `visibilitychange` (→ `document_visibility`),
   `resize` (→ `viewport_resize`, only when either side changed by ≥ 20 px),
   `pagehide` (→ `page_hide`, flushed with `sendBeacon`).
3. Send `twitch_helper_present` `{present, version}`.
4. If `window.Twitch.ext` exists: register the five helper callbacks once,
   set `wired = true`, keep the latest values for replay, and send
   `onAuthorized_fired` `{channelId, clientId, viewerKind}`,
   `onContext_first` (first context only: `{mode, isFullScreen, isPaused,
   isTheatreMode, playbackMode, arePlayerControlsVisible, theme}`),
   `onVisibilityChanged` `{visible}`, `onHighlightChanged` `{highlighted}`,
   `twitch_ext_error` `{error}`.
5. On DOMContentLoaded (or at once if already parsed): `html_loaded` with
   `{trigger: measureTrigger(#gtamap-raw-trigger, 'raw'), rawCss}` when the
   raw button exists. It does not touch `snapshot.triggerVisible`: the raw
   button proves the iframe is on screen, not that the map button is.
6. 10 s after DOMContentLoaded, if `markAppLoaded()` was never called:
   `app_bundle_missing` `{moduleScripts: [origin+path of each module script]}`.

Transport: queue, flush 250 ms after the first queued event, ≤ 25 events per
request, ≤ 400 events per session (then stop). Noisy events
(`onHighlightChanged`, `viewport_resize`, `document_visibility`,
`trigger_check`, `onVisibilityChanged`) are throttled per name to one per
1.5 s, keeping the latest (trailing) value.

```js
fetch(apiBase + '/api/diag/ext', {
  method: 'POST', mode: 'no-cors', credentials: 'omit', keepalive: true,
  headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body,
});
```
`text/plain` + `no-cors` = a CORS "simple request": no preflight, works from
any origin including a sandboxed `null` origin. `navigator.sendBeacon` on
`pagehide` and when `fetch` is missing. Strings are cut without splitting a
surrogate pair (a lone half would be refused by the server's jsonb).

---

## 3. Wire format — `POST /api/diag/ext`

Body is JSON sent as `text/plain` (also accept `application/json`):

```ts
interface DiagBatch {
  v: 1;
  session: string;                    // /^[A-Za-z0-9_-]{8,40}$/
  surface: 'video_overlay' | 'mobile' | 'config' | 'unknown';
  events: DiagEvent[];                // 1..25
}

interface DiagEvent {
  event: DiagEventName;
  t?: number;                         // client epoch ms
  seq?: number;                       // per-session counter
  snap?: Partial<DiagSnapshot>;
  data?: Record<string, unknown>;     // small, event-specific (see below)
}

type DiagEventName =
  | 'html_loaded' | 'app_bundle_loaded' | 'app_bundle_missing'
  | 'twitch_helper_present' | 'onAuthorized_fired' | 'onContext_first'
  | 'onVisibilityChanged' | 'onHighlightChanged' | 'document_visibility'
  | 'viewport_resize' | 'trigger_rendered' | 'trigger_check'
  | 'raw_button_upgraded' | 'map_opened' | 'runtime_error'
  | 'unhandled_rejection' | 'resource_error' | 'csp_violation'
  | 'twitch_ext_error' | 'page_hide';

interface DiagSnapshot {
  stage: 'boot' | 'app';
  viewport: { w: number; h: number; dpr: number };   // innerWidth / innerHeight
  docVisibility: 'visible' | 'hidden' | 'prerender' | 'unloaded';
  twitchVisible: boolean | null;       // last onVisibilityChanged
  highlighted: boolean | null;         // last onHighlightChanged
  helperPresent: boolean;
  helperVersion: string | null;        // Twitch.ext.version
  authorized: boolean;
  channelId: string | null;            // digits only
  viewerKind: 'anonymous' | 'logged_in' | 'identified' | 'unknown';
  framed: boolean;
  pageOrigin: string | null;           // location.origin; "null" = opaque sandbox
  referrerOrigin: string | null;       // origin of document.referrer
  ancestorOrigins: string[];           // location.ancestorOrigins (≤ 5)
  params: {                            // only these Twitch query params
    anchor?: string; platform?: string; mode?: string; state?: string;
    language?: string; locale?: string; popout?: string;
  };
  smoke: boolean;
  dev: boolean;
  triggerVisible: boolean | null;      // last measured React trigger (never the raw one);
                                       // informational: the server derives it from trigger events
}

interface TriggerInfo {
  which: 'react' | 'raw';
  rendered: boolean;                   // element exists and is connected
  rect: { x: number; y: number; w: number; h: number };   // rounded
  display: string; visibility: string; opacity: number;
  pointerEvents: string; zIndex: string;
  inViewport: boolean;                 // intersects 0..innerWidth × 0..innerHeight
  hitTest: 'self' | 'covered' | 'outside' | 'n/a';        // elementFromPoint(center)
  visible: boolean;                    // rendered && w>0 && h>0 && display!='none'
                                       // && visibility!='hidden' && opacity>0.05 && inViewport
}
```

Event data:

| event | data |
|---|---|
| `html_loaded` | `{trigger?: TriggerInfo, rawCss?: boolean}` (raw button, SMOKE_TEST; `rawCss` false = stylesheet did not apply, CSSOM fallback used) |
| `app_bundle_loaded` | `{helperPresent, helperVersion, devFallback, bridged}` |
| `app_bundle_missing` | `{moduleScripts: string[]}` |
| `twitch_helper_present` | `{present, version}` |
| `onAuthorized_fired` | `{channelId, clientId, viewerKind, dev?: true}` |
| `onContext_first` | see §2 |
| `onVisibilityChanged` | `{visible}` |
| `onHighlightChanged` | `{highlighted}` |
| `document_visibility` | `{state}` |
| `viewport_resize` | `{w, h}` |
| `trigger_rendered` / `trigger_check` / `raw_button_upgraded` | `{trigger: TriggerInfo}` |
| `map_opened` | `{via: 'react' \| 'raw'}` |
| `runtime_error` / `unhandled_rejection` / `twitch_ext_error` | `{error: {message, source?, line?, col?}}` |
| `resource_error` | `{error: {message: 'failed to load <tag>', source}}` |
| `csp_violation` | `{csp: {directive, blockedURI, sourceFile, line?, disposition}}` |
| `page_hide` | `{}` |

`trigger_rendered` is sent once after mount; `trigger_check` when the button
appears, disappears, or moves/resizes by ≥ 4 px — and once more, changed or
not, the first time the page is on screen (document `visible`, Twitch not
hiding it, ≥ 50×50) if the first measurement was not, because the server only
trusts an on-screen measurement (§5). The app re-measures 1/3/10/30 s after
mount, on resize, on onVisibilityChanged and on `visibilitychange`, never
while the map is open.

URLs anywhere in the payload are reduced to origin + path (no query, no
fragment) on the client, and again on the server.

Server rules:

* Unauthenticated on purpose (it must work before and without onAuthorized).
* zod-validate, unknown keys stripped; ≤ 32 KB body; strings ≤ 300 chars;
  `data` depth ≤ 4, ≤ 40 keys per object, arrays ≤ 10.
* Deep redaction before storage: drop any key matching
  `/token|jwt|secret|password|cookie|authorization|helix/i`; replace any string
  containing a JWT (`eyJ…\.…\.…`), `Bearer …`, or a URL query string with the
  redacted form; `channelId` must match `/^\d{1,20}$/` or becomes `null`.
* Strings (and keys) are cut without splitting a surrogate pair, and lone
  surrogates become U+FFFD: Postgres refuses a lone `\udXXX` escape in jsonb,
  which would fail the whole batch INSERT.
* `pageOrigin`, `referrerOrigin`, `ancestorOrigins` are stored as bare
  origins (`https://host[:port]`, or the literal `null`); anything that is not
  an origin is dropped.
* Rate limit per client IP: 120 requests / minute (`consumeRateLimit`), over
  the limit → 429 and nothing stored. `req.ip` is the viewer's own address
  only because the ingress trusts the outer proxy's `X-Forwarded-For` (§4).
* Response: `204` when stored, `400` for an unparseable/invalid batch.
* Storage: table `ext_diag_events` (migration `004_ext_diagnostics.sql`).
  Pruned by the maintenance job: older than 7 days, and above 5000 rows.

---

## 4. Request log — Caddy → API over TCP

The ingress Caddy has two named loggers: `access` (stdout, as before) and
`apiingest` (`output net api:5140 { dial_timeout 2s; soft_start }`, same
redaction filters, `wrap json`), and `log_name access apiingest` routes every
request to both. `soft_start` keeps Caddy — and therefore the extension —
serving even when the API is down; undeliverable lines then go to Caddy's own
stderr (already redacted) and are not stored.

Both loggers delete `Authorization` and `Cookie`, replace the `token` and
`code` query values, and replace the whole `Referer` query with `?REDACTED`
(the OBS page's same-origin requests carry `obs.html?token=…` there).

The ingress runs `caddy run … --watch` (compose), so a Caddyfile edit applies
by itself; `caddy reload` cannot, because the Caddyfile has `admin off`. Its
global `servers { trusted_proxies static private_ranges }` makes it append to
the outer Caddy's `X-Forwarded-For` (the real client IP) instead of replacing
it with the Docker gateway's, so the API's per-IP limits see each viewer.

The API listens on `EXT_LOG_INGEST_PORT` (default `5140`, `0` = off) on the
private Docker network only (never published in compose). It reads
newline-delimited Caddy access-log JSON:

```json
{"ts": 1789719918.69, "request": {"method": "GET", "uri": "/video_overlay.html?anchor=video_overlay&platform=web",
 "headers": {"Referer": ["https://supervisor.ext-twitch.tv/"], "Sec-Fetch-Dest": ["iframe"],
             "Sec-Fetch-Site": ["cross-site"], "User-Agent": ["Mozilla/5.0 …"]}},
 "status": 200, "duration": 0.0012}
```

An optional top-level `"source": "devserver"` marks lines from the Vite dev
server (which sends the same shape to `EXT_LOG_INGEST=api:5140`); everything
else is `ingress`.

Kept (everything else is ignored):
* `/video_overlay.html`, `/video_overlay`, `/mobile.html`, `/mobile`,
  `/config.html`, `/config`, `/gtamap-boot.js`, `/gtamap-raw.css`;
* `/assets/*` whose Referer path is one of the Twitch pages above (proves the
  bundle itself was fetched, and with which status).

Stored in `ext_request_log`: ts, source, method, path (pathname plus only the
whitelisted Twitch params `anchor platform mode state language locale popout`),
status, referer (origin + path), sec_fetch_dest, sec_fetch_site, user_agent
(≤ 300 chars). No IP, no other headers, no other query parameters. Each kept
line is also logged by pino at info: `twitch extension request`.
Lines > 64 KB are dropped; a connection buffering > 1 MB without a newline is
closed. Kept rows are rate-capped per listener (token bucket, 20/s sustained,
burst 200; the excess is dropped with one warning per minute), because the
pages are public and their headers forgeable. Pruned like `ext_diag_events`.

---

## 5. Admin — `GET /api/admin/ext-diagnostics` (requireAdmin)

Query: `limit` (1..200, default 50).

```ts
interface ExtDiagnosticsResponse {
  serverTime: number;
  events: Array<{
    id: number;
    receivedAt: string;               // ISO
    clientTs: string | null;
    session: string;
    surface: string;
    event: string;
    channelId: string | null;
    viewerKind: string;               // anonymous | logged_in | identified | unknown
    viewport: string | null;          // "1280×720"
    docVisibility: string | null;
    twitchVisible: boolean | null;
    helper: string;                   // "1.28.0" | "есть" | "нет"
    authorized: boolean | null;
    trigger: string | null;           // "видна 120×48 @ 38,396 (react)" | "скрыта: display none (raw)" | null
    error: string | null;
    data: Record<string, unknown>;
  }>;                                 // newest first
  requests: Array<{
    id: number; ts: string; source: 'ingress' | 'devserver'; method: string;
    path: string; status: number | null; referer: string | null;
    secFetchDest: string | null; secFetchSite: string | null; userAgent: string | null;
  }>;                                 // newest first
  summary: {
    lastIframeRequest: { ts: string; path: string; status: number | null; referer: string | null } | null;
    lastSession: {
      session: string; surface: string; firstAt: string; lastAt: string;
      events: string[];               // distinct names, first-seen order
      htmlLoaded: boolean; appBundleLoaded: boolean; appBundleMissing: boolean;
      helperPresent: boolean | null; helperVersion: string | null;
      authorized: boolean; channelId: string | null; viewerKind: string;
      viewport: string | null; twitchVisible: boolean | null; docVisibility: string | null;
      triggerVisible: boolean | null; triggerWhich: string | null; trigger: string | null;
      onScreenTriggerVisible: boolean | null; onScreenTrigger: string | null;  // latest React measurement taken on screen
      rawVisible: boolean | null; rawTrigger: string | null;                   // raw SMOKE_TEST button
      mapOpened: boolean; errorCount: number; cspCount: number;
      lastError: string | null;       // newest error / CSP line of the session
      pageOrigin: string | null; referrerOrigin: string | null;
      twitchState: string | null; anchor: string | null;
    } | null;
    verdict: { code: VerdictCode; ok: boolean; text: string };
  };
}
```

The verdict's subject is one surface, and both facts come from it, so a page
is only ever compared with its own requests: `video_overlay` when it has any
session or iframe request, else `mobile`. `config.html` has no map button and
is never the subject (its rows are still in the tables).
`lastSession`: the subject surface's session with the newest event.
`lastIframeRequest`: the newest request row for a page of the subject surface
(`/video_overlay(.html)` or `/mobile(.html)`) with `secFetchDest = 'iframe'`.

How the server reads the trigger:

* `triggerVisible` / `trigger` come only from `which: 'react'` measurements
  (`trigger_rendered`, `trigger_check`), never from the page's snapshot. The
  raw button (`html_loaded`, `raw_button_upgraded`) goes to `rawVisible` /
  `rawTrigger`: it proves the iframe is on screen, not that the map button is.
* `onScreenTrigger` is the latest React measurement whose event snapshot had
  the page on screen: `docVisibility` `visible` (or unknown), `twitchVisible`
  not `false`, viewport ≥ 50×50. A viewer switching tabs, closing the stream
  or pausing it afterwards does not undo it — that is the viewer leaving, not
  Twitch hiding the extension.

Verdict (pure function, first match wins; `now` = server time):

| code | condition | ok | text |
|---|---|---|---|
| `no_data` | no requests and no sessions | false | Twitch ещё не загружал расширение. Запустите стрим и откройте канал. |
| `request_only` | an iframe request newer than the last session's `lastAt` + 20 s (or no session at all), and ≥ 20 s old | false | Twitch запросил страницу, но она не отчиталась: скрипты в iframe не выполнились. |
| `pending` | the last session is < 10 s old and has neither a React trigger measurement nor `app_bundle_missing` | false | Расширение загружается… |
| `helper_missing` | `helperPresent === false` | false | Twitch Helper не загрузился в iframe. |
| `bundle_missing` | `htmlLoaded` and (`appBundleMissing` or no `app_bundle_loaded` ≥ 10 s after the first event) | false | HTML загрузился, но приложение не запустилось. |
| `trigger_missing` | surface is not `config`, `appBundleLoaded`, no React trigger measurement, ≥ 10 s after the first event (React failed to render it) | false | Приложение запустилось, но кнопка карты не появилась: <lastError, or "ошибок страница не прислала">. |
| `ok_unauthorized` / `ok` | `onScreenTriggerVisible === true` (and `authorized` for `ok`) | true | as the two rows below; plus " Сейчас страница не на экране: вкладка в фоне или закрыта, либо видео на паузе." when it no longer is |
| `trigger_hidden` | `onScreenTriggerVisible === false` | false | Кнопка карты есть, но не видна: <onScreenTrigger>. (+ " Кнопка EXTENSION LOADED при этом видна: iframe показан, кнопку прячет приложение." when `rawVisible`) |
| `iframe_hidden` | never measured on screen, and now `twitchVisible === false`, or viewport width or height < 50, or `docVisibility` not `visible` | false | by cause: Twitch загрузил iframe, но скрыл его (видео на паузе, стрим офлайн или плеер свёрнут). / Twitch загрузил iframe, но дал ему почти нулевой размер (W×H). / Страница расширения открыта в фоновой вкладке и ещё ни разу не была на экране. |
| `trigger_hidden` | `triggerVisible === false` | false | Кнопка карты есть, но не видна: <trigger>. (+ raw note as above) |
| `ok_unauthorized` | `triggerVisible === true` and not `authorized` | true | Кнопка карты видна. onAuthorized ещё не пришёл — покупка точек пока недоступна. |
| `ok` | `triggerVisible === true` and `authorized` | true | Кнопка карты видна зрителю. |
| `pending` | otherwise | false | Расширение загружается… |

`/admin` shows this as the `TWITCH EXTENSION DIAGNOSTICS` panel: the verdict
banner, the facts of the last session, the last 50 events (timestamp, event,
channelId, anonymous/identified, viewport, visibility, helper status, trigger
status, error) and the last 50 extension requests (time, path, status,
Referer, Sec-Fetch-Dest, User-Agent). It polls every 5 s.
