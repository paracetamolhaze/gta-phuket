# GTA DOLLAR economy — contract

Twitch does not let an extension spend a viewer's Channel Points (see the
feasibility research: redemptions happen only in Twitch's own Rewards UI). So
the extension runs on an internal currency instead:

* **ETH** — what this channel calls its real Twitch Channel Points.
* **GTA DOLLAR**, shown as **`GTA$`** — an integer balance per viewer, stored in
  PostgreSQL. `1 ETH = gtaDollarsPerChannelPoint GTA$` (default 10).
* Viewers buy GTA$ by redeeming one real Custom Reward, **«Обмен ETH на GTA
  DOLLAR»** (default cost 500 ETH → 5 000 GTA$), in Twitch's Rewards UI.
* Waypoints are bought with GTA$ inside the map, with one click, atomically.

Source of truth is PostgreSQL. The frontend never stores or computes a balance
it trusts; realtime events are only a signal to re-read `GET /api/ext/wallet`.

---

## 1. Configuration

### Environment

`WAYPOINT_PAYMENT_MODE` — `gta_dollar` (new, default) | `channel_points_reward`
(legacy per-quote slot rewards, kept for rollback). Read once at boot, exposed
as `env.waypointPaymentMode`.

In `gta_dollar` mode:
* `POST /api/ext/quote/:id/confirm` (legacy slot reservation) answers
  `409 payment_mode` and leases nothing; the slot pool is left as is (its
  rewards stay disabled on Twitch).
* EventSub redemptions of any reward other than the exchange reward are
  ignored (never refunded, never fulfilled — they are not ours to touch).

In `channel_points_reward` mode everything behaves exactly as before this
change, and the exchange reward still credits GTA$ (it is harmless there).

### Channel settings (`ChannelSettings`, JSONB in `channel_settings`)

| key | type | default | rules |
|---|---|---|---|
| `gtaDollarsPerChannelPoint` | int | 10 | 1..1000 |
| `exchangeRewardCost` | int | 500 | 1..1 000 000 (Twitch limits) |

Both are in `settingsPatchSchema` (admin-editable). Pricing keys (`baseCost`,
`pointsPer100Meters`, `minimumCost`, `maximumCost`, `roundTo`) keep their
names; in `gta_dollar` mode their unit is GTA$. `calculatePrice` is unchanged:
1.4 km → 100 + 14 × 100 = GTA$ 1 500.

The frontend never hardcodes the rate or the reward cost: it reads them from
`GET /api/ext/state` → `economy`.

---

## 2. Database — migration `005_gta_dollar.sql`

```sql
CREATE TABLE gta_wallets (
  channel_id      TEXT   NOT NULL,
  twitch_user_id  TEXT   NOT NULL,              -- numeric Twitch user id, as text
  balance         BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, twitch_user_id),
  CHECK (twitch_user_id ~ '^[0-9]{1,20}$')
);

CREATE TABLE gta_wallet_transactions (
  id                    TEXT PRIMARY KEY,            -- uuid
  channel_id            TEXT   NOT NULL,
  twitch_user_id        TEXT   NOT NULL,
  type                  TEXT   NOT NULL CHECK (type IN
                          ('EXCHANGE_CREDIT','WAYPOINT_DEBIT','MISSION_REFUND','ADMIN_ADJUSTMENT')),
  amount                BIGINT NOT NULL CHECK (amount <> 0),   -- signed: credit > 0, debit < 0
  balance_after         BIGINT NOT NULL CHECK (balance_after >= 0),
  twitch_redemption_id  TEXT UNIQUE,                 -- EXCHANGE_CREDIT only
  twitch_reward_id      TEXT,
  channel_points_cost   INTEGER,
  quote_id              TEXT,                        -- WAYPOINT_DEBIT
  waypoint_id           TEXT,                        -- WAYPOINT_DEBIT, MISSION_REFUND
  fulfillment_status    TEXT,                        -- EXCHANGE_CREDIT: PENDING|FULFILLED|FAILED|CANCELED_EXTERNALLY
  fulfillment_attempts  INTEGER NOT NULL DEFAULT 0,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (channel_id, twitch_user_id) REFERENCES gta_wallets(channel_id, twitch_user_id)
);
CREATE UNIQUE INDEX gta_tx_one_debit_per_quote    ON gta_wallet_transactions(quote_id)    WHERE type = 'WAYPOINT_DEBIT';
CREATE UNIQUE INDEX gta_tx_one_refund_per_waypoint ON gta_wallet_transactions(waypoint_id) WHERE type = 'MISSION_REFUND';
CREATE INDEX gta_tx_wallet_idx ON gta_wallet_transactions(channel_id, twitch_user_id, created_at DESC);
CREATE INDEX gta_tx_fulfillment_idx ON gta_wallet_transactions(fulfillment_status) WHERE fulfillment_status = 'PENDING';

CREATE TABLE gta_exchange_rewards (
  channel_id        TEXT PRIMARY KEY,
  twitch_reward_id  TEXT NOT NULL UNIQUE,            -- gtaDollarExchangeRewardId
  title             TEXT NOT NULL,
  cost              INTEGER NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE waypoint_quotes ADD COLUMN currency TEXT NOT NULL DEFAULT 'CHANNEL_POINTS'; -- | 'GTA_DOLLAR'
ALTER TABLE waypoints       ADD COLUMN currency TEXT NOT NULL DEFAULT 'CHANNEL_POINTS';
```

Invariants:
* `sum(amount)` over a wallet's transactions == `gta_wallets.balance`
  (rebuildable from the ledger; an admin endpoint reports any mismatch).
* One exchange redemption → at most one credit (`twitch_redemption_id UNIQUE`).
* One quote → at most one debit; one waypoint → at most one refund.
* `balance >= 0` is enforced by the database, not only by code.

---

## 3. Exchange reward

`server/src/twitch/exchangeReward.ts`, broadcaster token of **our** Twitch
application (`TWITCH_CLIENT_ID`), so our backend can fulfil its redemptions.

`ensureExchangeReward(channelId)`:
1. If `gta_exchange_rewards` has a row, `GET custom_rewards?id=<id>&only_manageable_rewards=true`.
   Found → reconcile `cost`/`is_enabled`/`title` with settings (PATCH if they differ). Done.
2. Otherwise `POST custom_rewards` with:
   `title: "Обмен ETH на GTA DOLLAR"`, `cost: settings.exchangeRewardCost`,
   `prompt: "Обменять ETH на GTA$ по курсу 1 ETH = <rate> GTA$. GTA$ зачисляются на ваш кошелёк в карте GTA Phuket."`,
   `is_enabled: true`, `should_redemptions_skip_request_queue: false`,
   `background_color: "#1FA35C"`. Store the returned id.
3. Twitch rejects a duplicate title (400). Then, and only then, list
   `only_manageable_rewards=true` (rewards created by our client id) and adopt
   the one with that exact title. Rewards are otherwise never identified by title.

Called at API boot (when REAL_TWITCH and the broadcaster is connected; failures
logged, boot continues), after the broadcaster OAuth callback, and from
`POST /api/admin/economy/exchange-reward/sync`. The OAuth callback creates it
only when the connected account is `TWITCH_CHANNEL_ID`: any other account gets
a warning instead, because the webhook ignores that channel's redemptions and
an enabled exchange there would take ETH for nothing. Changing
`exchangeRewardCost` through the admin PATCHes the reward's `cost` on Twitch;
if Twitch refuses, the setting is rolled back and the error returned. A save
that touches the exchange terms (`exchangeRewardCost`,
`gtaDollarsPerChannelPoint`, through either `PUT /api/admin/economy` or
`PUT /api/admin/settings`) runs the Twitch PATCH and the settings save under the
same Redis lock as `ensureExchangeReward`, so a sync running at that moment can
neither store its stale copy of the cost nor PATCH Twitch back to it.

With the dev stub (not REAL_TWITCH) the same functions work against the local
Helix stub so the full flow is testable offline.

---

## 4. EventSub → credit

In `handleRedemption` routing (before the slot-pool logic):

```
channel.channel_points_custom_reward_redemption.add
  1. HMAC verified by the webhook route (unchanged); invalid → 403, nothing stored.
  2. event.broadcaster_user_id === TWITCH_CHANNEL_ID, else ignore.
  3. event.reward.id === gta_exchange_rewards.twitch_reward_id → creditExchange(); else legacy routing.
creditExchange(event):
  4. user_id must be numeric; reward.cost must be a positive integer.
  5. gtaAmount = event.reward.cost × settings.gtaDollarsPerChannelPoint
     (reward.cost is what Twitch actually charged; the rate is read at processing time).
  6. ONE transaction:
       INSERT wallet (channel, user) ON CONFLICT DO NOTHING;
       SELECT … FOR UPDATE;
       INSERT gta_wallet_transactions (EXCHANGE_CREDIT, +gtaAmount,
              twitch_redemption_id = event.id, fulfillment_status = 'PENDING')
              ON CONFLICT (twitch_redemption_id) DO NOTHING RETURNING id;
       no row returned → duplicate → COMMIT nothing else, outcome 'duplicate';
       else UPDATE wallet balance += gtaAmount, set balance_after.
  7. After COMMIT: emitToViewer(channel, user, 'wallet:updated', …);
     updateRedemptionStatus(…, 'FULFILLED') → mark FULFILLED.
     If Twitch fails, leave PENDING; the maintenance job retries every 60 s
     (max 10 attempts, then FAILED + admin-visible). A 400/404 from Twitch
     triggers a GET of the redemption: FULFILLED → mark FULFILLED;
     CANCELED → CANCELED_EXTERNALLY (GTA$ are NOT clawed back automatically;
     shown in /admin as an alert).
  8. If the transaction throws, nothing is fulfilled; the event stays
     unprocessed in eventsub_events and the existing retry machinery re-runs it.
```

Duplicate deliveries: EventSub message-id dedupe (existing) + the UNIQUE
redemption id make a second credit impossible even across Redis flushes.
`.update` events for the exchange reward are recorded in logs only.

---

## 5. Identity

* Extension JWT (`Authorization: Bearer <token>` from `Twitch.ext.onAuthorized`)
  verified with `TWITCH_EXT_SECRET` (existing `requireExtIdentity`), including
  `channel_id === TWITCH_CHANNEL_ID`.
* Wallet identity = `identity.userId` (numeric `user_id` claim, present only
  after identity share). Never from body, query, headers or storage.
* No `userId` → `403 needs_id_share` (logged-in opaque `U…`) or
  `403 needs_login` (anonymous `A…`). Anonymous viewers never get a wallet row.
* The same numeric id is what EventSub puts in `event.user_id`, so credits and
  the viewer's wallet meet on `(channel_id, twitch_user_id)`.

---

## 6. HTTP API

### `GET /api/ext/wallet` (extension JWT, linked)
```json
{ "currency": "GTA_DOLLAR", "symbol": "GTA$", "balance": 5000, "exchangeRate": 10,
  "exchange": { "rewardTitle": "Обмен ETH на GTA DOLLAR", "rewardCost": 500, "gtaPerRedemption": 5000, "available": true },
  "recent": [ { "id": "…", "type": "EXCHANGE_CREDIT", "amount": 5000, "balanceAfter": 5000, "createdAt": "…" } ] }
```
`balance` is 0 (no row created) for a linked viewer who never received GTA$.
`recent`: the viewer's own last 10 transactions. Any `userId` in the query or
body is ignored. Rate limit: 60/min per viewer (`429 rate_limited`; the overlay
keeps showing its last confirmed balance).

### `GET /api/ext/state` additions
```json
"paymentMode": "gta_dollar",
"economy": { "symbol": "GTA$", "exchangeRate": 10, "rewardTitle": "Обмен ETH на GTA DOLLAR",
             "rewardCost": 500, "gtaPerRedemption": 5000, "available": true }
```
`available` is false while no exchange reward exists on Twitch.

### Quotes
`POST /api/ext/quote` unchanged in shape; in `gta_dollar` mode the quote is
stored with `currency = 'GTA_DOLLAR'` and `QuoteView` gains
`"currency": "GTA_DOLLAR" | "CHANNEL_POINTS"` (`rewardTitle` null). Linked
identity is required (unchanged).

### `POST /api/ext/waypoints/purchase` (extension JWT, linked)
Body: `{ "quoteId": "<id>" }` only. Everything else comes from the server.
Under the per-channel activation lock, in ONE transaction:
1. `SELECT … FROM waypoint_quotes WHERE id = $1 FOR UPDATE`;
   not found / other channel → 404 `quote_not_found`; other user → 403 `forbidden`.
2. status `PAID` and this user's `WAYPOINT_DEBIT` exists → idempotent success
   (same waypoint, no second charge; `charged: false`).
3. status ≠ `QUOTED` → 409 `quote_conflict`; expired → 409 `quote_expired`
   (and marked EXPIRED); currency ≠ GTA_DOLLAR → 409 `payment_mode`.
4. Recompute `calculatePrice(quote.distanceMeters, currentSettings)`; ≠ stored
   cost → 409 `price_changed` (quote canceled; viewer re-quotes).
5. waypoints closed → 409 `waypoints_closed`; active waypoint → 409 `waypoint_active`.
6. `INSERT wallet ON CONFLICT DO NOTHING; SELECT … FOR UPDATE`;
   balance < cost → 402 `insufficient_funds` `{ balance, cost }`.
7. `UPDATE waypoint_quotes SET status = 'PAID' WHERE status = 'QUOTED'`,
   `insertActiveWaypoint` (currency GTA_DOLLAR, points_paid = cost),
   `UPDATE wallet balance -= cost`, `INSERT WAYPOINT_DEBIT (-cost, quote_id, waypoint_id)`.
   A unique-index violation (second active waypoint, second debit) rolls the
   whole transaction back and maps to 409 `waypoint_active` / idempotent success.
8. After COMMIT: `primeLiveNav`, `waypoint:activated` (trusted exact +
   viewers sanitized, exactly as the redemption path does), `wallet:updated`
   to the buyer, `waypoint:purchased` to trusted.

Response `200`:
`{ "ok": true, "charged": true, "waypoint": ActiveWaypointView, "waypointStatus": "ACTIVE", "balance": 3500, "cost": 1500 }`.
`waypointStatus` is `ACTIVE` on a charge. An idempotent repeat (step 2) reports
where that waypoint stands now — `ACTIVE`, `COMPLETED` or `CANCELED` — so a
retry after a lost response never shows a finished job as running.
Rate limit: 10/min per user.

### Streamer phone
`POST /api/streamer/waypoint/cancel` (device token) body
`{ "reason": "cannot" | "unsafe" }` → cancel + refund (§7). Response
`{ ok, refunded, amount }`. The PWA gets two buttons next to the complete
button, each arm-then-confirm like «ДОШЁЛ»: **НЕ МОГУ** and **НЕБЕЗОПАСНО**.

### Admin (admin token)
* `GET /api/admin/economy` →
  `{ paymentMode, exchangeRate, reward: { id, title, cost, enabledOnTwitch: boolean | null } | null, gtaPerRedemption,
     totals: { issued, spent, refunded, adjusted, circulating, wallets }, ledgerConsistent: boolean,
     pendingFulfillments: number, failedFulfillments: number, canceledExternally: number,
     recent: [ { createdAt, type, amount, twitchUserId, balanceAfter } ] (last 20),
     settings: { gtaDollarsPerChannelPoint, exchangeRewardCost }, rewardCheckError: string | null }`
  — `issued` = Σ EXCHANGE_CREDIT, `spent` = −Σ WAYPOINT_DEBIT, `refunded` = Σ MISSION_REFUND,
  `adjusted` = Σ ADMIN_ADJUSTMENT. `enabledOnTwitch` is read live from Twitch;
  when Twitch cannot be asked it is `null` and `rewardCheckError` says why
  (never reported as "disabled"). `settings` are the saved targets; `reward.cost`
  is what Twitch charges.
* `PUT /api/admin/economy` `{ gtaDollarsPerChannelPoint?, exchangeRewardCost? }`
  → save settings; cost change PATCHes Twitch first (rollback on failure), under
  the exchange reward lock (§3). Answers the same body as `GET`.
* `POST /api/admin/economy/exchange-reward/sync` → `ensureExchangeReward` →
  `{ action: 'created' | 'adopted' | 'updated' | 'unchanged', reward: { id, title, cost, isEnabled } }`.
* `POST /api/admin/waypoint/cancel` with `refund: true` on a GTA$ waypoint →
  GTA$ refund (§7) instead of a Twitch refund. Response `{ ok, refunded, refundError, amount }`.
* `POST /api/admin/waypoint/clear` (the «СБРОСИТЬ МАРШРУТ» emergency reset) on a
  GTA$ waypoint → always a GTA$ refund (§7): a reset must not leave a viewer
  without the job and without the money. Response `{ ok, refunded, amount }`.
  A Channel Points waypoint is still cleared without touching Twitch; a GTA$ job
  is cancelled without a refund only through the cancel with `refund: false`.
* `POST /api/admin/economy/adjust` `{ twitchUserId, amount, reason }` — a manual
  ledger correction (`ADMIN_ADJUSTMENT`, signed, never below zero, then
  `wallet:updated` to that viewer) → `{ ok, transactionId, balance }`. It is how
  GTA$ credited for a redemption later rejected on Twitch (`CANCELED_EXTERNALLY`)
  are taken back; there is no button for it.
* `GET /api/admin/state` also carries `paymentMode`, and each recent quote its
  `currency`, so the console labels prices in the right unit.

New error codes (server `AppError` and web `ApiErrorCode`): `insufficient_funds`,
`price_changed`, `payment_mode`, `needs_login`.

---

## 7. Refunds

`cancelWaypoint` gains a `refundGta: boolean` option. In ONE transaction:
`UPDATE waypoints SET status='CANCELED' … WHERE status='ACTIVE' RETURNING *`;
if it was a GTA$ waypoint and `refundGta`:
`INSERT MISSION_REFUND (+cost, waypoint_id) ON CONFLICT DO NOTHING RETURNING`;
only when inserted → `balance += cost`. After COMMIT → `wallet:updated` to the
buyer. Twitch Channel Points are never touched for GTA$ waypoints.
Callers with `refundGta: true`: the streamer's cancel, the admin cancel with
`refund: true`, and the admin reset (`/api/admin/waypoint/clear`).
Completion (`ДОШЁЛ`, labelled ЗАВЕРШИТЬ on the phone) never refunds.

---

## 8. Realtime

Viewer sockets pass the extension JWT as `auth.token` (socket.io `auth` as a
function, so reconnects send the current token). The server verifies it; a
verified linked viewer additionally joins room `wallet:<channelId>:<userId>`.
A bad or missing token still connects as an anonymous viewer (no wallet room).

`emitToViewer(channelId, userId, event, payload)` is added to the realtime
transport (and to its test double).

| event | audience | payload |
|---|---|---|
| `wallet:updated` | that viewer only | `{ type, amount, balance, transactionId }` |
| `waypoint:purchased` | trusted | `{ waypointId, quoteId, userId, cost, currency: 'GTA_DOLLAR' }` |
| `waypoint:completed` (existing) | all | gains `quoteId`: `{ id, quoteId, destinationName }` |

`waypoint:completed` carries the quote id so an overlay whose purchase got no
answer can tell that the job that just ended was its own.

`wallet:updated` is a signal: the client re-reads `GET /api/ext/wallet`.
When identity changes (after `requestIdShare`), the client reconnects the socket
with the new token.

---

## 9. Viewer UI (overlay)

Formatting: `GTA$ ` + integer grouped by three with a non-breaking space:
`GTA$ 850`, `GTA$ 1 250`, `GTA$ 5 000`, `GTA$ 25 000`. Never `$5,000`.
One shared helper `formatGta(n)` in `web/src/shared/format.ts`.

* Wallet chip, top-right of the open map: `GTA$ 5 000` and `[+ ПОПОЛНИТЬ]`.
  The collapsed `🗺 КАРТА` trigger and its position stay untouched.
* Not linked (logged in): «Чтобы использовать GTA$, подключите Twitch» +
  `[ПОДКЛЮЧИТЬ]` → `Twitch.ext.actions.requestIdShare()`.
  Anonymous: «Войдите в Twitch, чтобы использовать GTA$».
* `+ ПОПОЛНИТЬ` opens a small dialog:
  ```
  ПОПОЛНЕНИЕ GTA$
  Используйте награду Twitch:
  «Обмен ETH на GTA DOLLAR»
  500 ETH → 5 000 GTA$
  Откройте награды Twitch и используйте «Обмен ETH на GTA DOLLAR».
  ```
  (numbers from `economy`, never hardcoded). It never claims the extension can
  open the Rewards tray. When `wallet:updated` with `EXCHANGE_CREDIT` arrives
  while it is open, it switches to `+5 000 GTA$` / `Баланс: GTA$ 5 850`.
  When it is closed, a short toast shows the same.
* Destination card (`gta_dollar` mode), quoted state:
  ```
  Patong Beach
  1.4 km · 19 min
  Цена: GTA$ 1 500
  Ваш баланс: GTA$ 5 000
  [ОТПРАВИТЬ СТРИМЕРА — GTA$ 1 500]
  ```
  Insufficient: button disabled, «Не хватает GTA$ 650» + `[+ ПОПОЛНИТЬ]`.
  The button is disabled while the request is in flight (one click = one
  request; the server is idempotent anyway). Success → active state and the
  balance re-read. Errors mapped to Russian copy for the new codes.
  No answer (network error, 5xx) → back to the quote with «Нет ответа от
  сервера. Нажмите ещё раз — GTA$ спишутся только один раз» and the button
  kept enabled; a repeat answered with `waypointStatus` `COMPLETED` /
  `CANCELED` shows that outcome, not an active job.
* Not linked, on the destination card (`needs_id_share` in `gta_dollar` mode):
  the chip's wording «Чтобы использовать GTA$, подключите Twitch» + `[ПОДКЛЮЧИТЬ]`.
* Layering: the wallet chip sits under the destination card, so on a short
  phone panel a tall card covers the chip rather than the chip covering the
  card's title and close button; the top-up dialog and the toast sit above
  the card.
* Legacy mode keeps the current card and flow.

## 10. Admin UI

Panel **GTA DOLLAR ECONOMY** in `/admin`: exchange rate (`1 ETH = 10 GTA$`),
exchange reward title / cost / Twitch status, GTA$ per redemption, totals
issued / spent / refunded / circulating, wallets, ledger consistency, pending /
failed fulfilments, recent ledger rows; inputs for `gtaDollarsPerChannelPoint`
and `exchangeRewardCost` (save → `PUT /api/admin/economy`), and a
«СИНХР. НАГРАДУ ОБМЕНА» button.

The channel settings form names the unit of the pricing fields for the current
mode («База, GTA$» / «База, баллы», preview column «GTA$» / «Баллов»), and the
recent quotes list shows GTA$ quotes as `GTA$ N`. The cancel dialog offers
«Вернуть GTA$ зрителю» for a GTA$ job; the «СБРОСИТЬ МАРШРУТ» dialog says the
GTA$ will be returned.

## 11. Tests (server, vitest, `server/test/gta-dollar.test.ts`)

1. 500 ETH → 5 000 GTA$.  2. EventSub user 123 → wallet 123.
3. user 123 does not touch wallet 456.  4. duplicate redemption → one +5 000.
5. wrong reward id → no credit.  6. invalid HMAC (through the webhook route) → no credit.
7. JWT user 123 → `GET /api/ext/wallet` returns wallet 123.
8. `?userId=456` / body `userId: 456` with JWT 123 → still wallet 123.
9. 5 000 − 1 500 → 3 500.  10. 1 000 − 1 500 → 402, balance unchanged, no waypoint.
11. concurrent purchases (parallel) cannot overspend or create two waypoints.
12. canceled mission → refund once (second cancel/refund attempt → no change).
13. balance persists across reads and a Redis flush.
14. EventSub credit → `wallet:updated` emitted to that viewer only.
Plus: anonymous / unlinked → 403; channel isolation; price change → 409
`price_changed`; double purchase of one quote → one debit; FULFILLED is
called only after a committed credit; fulfilment retry. And: the admin reset
refunds a GTA$ job once; a repeat purchase after the job ended reports
`COMPLETED` / `CANCELED`; wallet reads are capped per viewer; an exchange-terms
save waits for a running reward sync; an unanswered Twitch check is `null`,
not "disabled"; the OAuth callback creates the exchange reward only on
`TWITCH_CHANNEL_ID`.
