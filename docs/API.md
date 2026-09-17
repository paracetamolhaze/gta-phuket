# HTTP + realtime contract

All types referenced here live in `server/src/domain/types.ts` and are re-exported
to the browser from `web/src/shared/types.ts`.

Base path: `/api`. In local Docker the Vite dev server proxies `/api` and
`/socket.io` to the API container, so every surface talks to its own origin.

Errors always look like `{ error: ApiErrorCode, message: string, details?: unknown }`
with an HTTP status matching the code (401/403/404/409/422/429/502/500).

---

## Viewer (Twitch extension) — `/api/ext/*`

Authentication: `Authorization: Bearer <twitch extension JWT>` on every call.
The server verifies HS256 against the base64-decoded extension secret and takes
`channel_id`, `user_id`, `opaque_user_id` and `role` from the token only.
Anything the client sends about identity is ignored.

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/ext/state` | – | `ViewerStatePayload` |
| `GET` | `/api/ext/config` | – | `{ mapboxToken, styleUrl, bounds, channelId }` |
| `GET` | `/api/ext/search?q=...` | – | `{ results: SearchResult[] }` |
| `POST` | `/api/ext/quote` | `{ lat, lng, name?, category? }` | `QuoteView` |
| `POST` | `/api/ext/quote/:id/confirm` | – | `QuoteView` (status `AWAITING_REDEMPTION`, `rewardTitle` set) |
| `POST` | `/api/ext/quote/:id/cancel` | – | `{ ok: true }` |
| `GET` | `/api/ext/quote/:id` | – | `QuoteView` |
| `GET` | `/api/ext/broadcaster/status` | – | broadcaster-only status (see below) |

`GET /api/ext/broadcaster/status` backs `config.html`, the Twitch Config
surface. It requires `role === 'broadcaster'` in the JWT and answers `403`
for anyone else. It returns booleans and counters only — backend reachability,
whether Twitch OAuth is connected, the channel id, GPS status and age, whether
Mapbox is configured, whether waypoints are open, free/total reward slots and
the admin URL. No token, no secret and no coordinates leave through it.

`POST /api/ext/quote` rejects with, in this order:

1. `unauthorized` — bad/expired JWT.
2. `needs_id_share` (403) — the token carries no real `user_id`; the client must
   call `Twitch.ext.actions.requestIdShare()`. Without it a redemption cannot be
   matched to the viewer.
3. `rate_limited` (429).
4. `waypoints_closed` (409) — the streamer closed waypoints.
5. `waypoint_active` (409) — a job is already running.
6. `gps_unavailable` (409) — no fix, too old, or accuracy worse than the limit.
7. `out_of_bounds` / `restricted_zone` (422) — destination outside Phuket or
   inside a zone the streamer blocked.
8. `no_walking_route` / `too_far_from_walkable` (422) — the router found nothing
   on foot, or had to snap the point further than `maxSnapDistanceMeters`
   (this is what rejects taps in the sea).
9. `too_far` (422) — walking distance over `maxWalkingDistanceMeters`.

`POST /api/ext/quote/:id/confirm` adds `no_free_slots` (503) when the whole
reward pool is busy, and `quote_expired` (409) after `expiresAt`. **Nothing is
charged at this point** — it only rewrites a Twitch Custom Reward and waits.

Price and distance are computed server-side and are never read from the request.

---

## Streamer PWA — `/api/streamer/*`

| Method | Path | Auth | Body | Returns |
| --- | --- | --- | --- | --- |
| `POST` | `/api/streamer/pair` | – | `{ code, label? }` | `{ deviceToken, channelId }` |
| `GET` | `/api/streamer/state` | device | – | `{ gps: GpsState, activeWaypoint, waypointsOpen }` |
| `POST` | `/api/streamer/waypoint/complete` | device | – | `{ ok: true }` |

GPS itself goes over the socket (below), not HTTP.

`code` is `STREAMER_DEVICE_SECRET`. The returned `deviceToken` is an HMAC-signed
token stored in the phone's `localStorage` and replayed on reconnect.

---

## Admin — `/api/admin/*`

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `POST` | `/api/admin/login` | `{ password }` | `{ token }` |
| `GET` | `/api/admin/state` | – | `{ gps: GpsState, activeWaypoint, settings, slots, quotes, oauth }` |
| `GET` | `/api/admin/settings` | – | `ChannelSettings` |
| `PUT` | `/api/admin/settings` | `Partial<ChannelSettings>` | `ChannelSettings` |
| `POST` | `/api/admin/waypoints/open` | – | `{ ok: true }` |
| `POST` | `/api/admin/waypoints/close` | – | `{ ok: true }` |
| `POST` | `/api/admin/waypoint/complete` | – | `{ ok: true }` |
| `POST` | `/api/admin/waypoint/cancel` | `{ reason?, refund? }` | `{ ok: true, refunded: boolean }` |
| `POST` | `/api/admin/waypoint/clear` | – | `{ ok: true }` |
| `POST` | `/api/admin/slots/sync` | – | `{ created, updated, total }` |
| `POST` | `/api/admin/eventsub/sync` | – | `{ subscriptions }` |

Auth: `Authorization: Bearer <admin token>`; the password is
`ADMIN_SESSION_SECRET`.

---

## OBS — `/api/obs/*`

`GET /api/obs/config?token=...` returns
`{ mapboxToken, styleUrl, channelId, bounds, trusted }` and
`GET /api/obs/state?token=...` returns the live state.

The token is derived from `ADMIN_SESSION_SECRET`, printed at startup and shown
in the admin console as the full Browser Source URL. **With** it the source gets
the exact `GpsState` and the unfiltered route -- which it needs, because what it
draws is burnt into the video and the broadcast delay is the real privacy
buffer. **Without** it the endpoints still answer, but with the same delayed and
rounded data viewers get, so a leaked URL discloses nothing new. The socket
handshake works the same way: `role: 'obs'` without a valid token is demoted to
`viewer`.

---

## Broadcaster OAuth — `/api/oauth/*`

- `GET /api/oauth/twitch/start` — redirects to Twitch with a CSRF `state` stored
  server-side. Scopes: `channel:manage:redemptions channel:read:redemptions`.
- `GET /api/oauth/twitch/callback` — validates `state`, exchanges the code,
  stores tokens, creates the reward pool, subscribes to EventSub, then redirects
  to `${PUBLIC_WEB_URL}/admin.html?connected=1`.

---

## EventSub — `/api/eventsub/twitch`

`POST`, raw body. Verifies `Twitch-Eventsub-Message-Signature` as
`sha256=HMAC(secret, messageId + timestamp + rawBody)` in constant time, rejects
timestamps older than 10 minutes, answers `webhook_callback_verification` with
the raw challenge as `text/plain`, and deduplicates on `Twitch-Eventsub-Message-Id`.

---

## Dev only — `/api/dev/*` (404 unless `DEV_MODE=true` and `NODE_ENV!=production`)

| Method | Path | Body | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/dev/ext-token` | `{ userId?, role?, linked? }` | Mint a fake extension JWT signed with the same secret |
| `POST` | `/api/dev/gps` | `GpsSample`-ish | Push one simulated fix |
| `POST` | `/api/dev/gps/sim/start` | `{ lat, lng, speedMps?, routeGeometry? }` | Start the walking simulator |
| `POST` | `/api/dev/gps/sim/stop` | – | Stop it |
| `POST` | `/api/dev/redeem` | `{ quoteId }` or `{ rewardId, userId }` | Build a signed EventSub redemption payload and post it through the real webhook handler |
| `POST` | `/api/dev/reset` | – | Clear waypoints, quotes and slots |

`/api/dev/redeem` deliberately goes through the **real** signature-verified
webhook path, so dev mode exercises production code rather than bypassing it.

---

## Socket.IO

One namespace, `/`. The client picks a room with the handshake:

```ts
io(base, { auth: { role: 'viewer' | 'obs' | 'streamer' | 'admin', token?, channelId } })
```

- `viewer` — no token; receives privacy-filtered GPS (`PublicGps`).
- `obs` — `token` is the OBS token; with it the exact `GpsState`, without it the same privacy-filtered feed viewers get.
- `streamer` — `token` is the device token; may **emit** `gps:push`.
- `admin` — `token` is the admin token; receives exact GPS and settings.

Server to client events are exactly the keys of `RealtimeEvents`. On connect the
server always sends `state:snapshot` first.

`waypoint:canceled` and `quote:canceled` are deliberately different events.
The first means the running job is over and every surface should clear it. The
second means somebody's unpaid quote died -- expired, superseded, or beaten to
the payment -- and must **not** clear the running job, or a losing quote would
blank the OBS minimap mid-stream.

Everything sent to `viewer` clients is privacy-filtered: `PublicGps` for
positions, and route polylines trimmed by `viewerLocationDelaySeconds` and
rounded to `viewerLocationPrecision`, because a route starts at the streamer's
exact position.

Client to server:

| Event | From | Payload |
| --- | --- | --- |
| `gps:push` | streamer | `{ lat, lng, accuracy, heading, speed, timestamp }` |
| `ping:rtt` | any | `(cb) => cb(serverTime)` |
