-- GTA DOLLAR economy (docs/GTA_DOLLAR_ECONOMY.md).
--
-- An extension cannot spend a viewer's Channel Points, so waypoints are bought
-- with an internal currency instead. Viewers top it up by redeeming one real
-- Custom Reward; EventSub tells us, and we credit their wallet.
--
-- The ledger is append-only and every balance change is a ledger row plus a
-- balance update in one transaction, so sum(amount) per wallet always equals
-- the balance and the balance can be rebuilt from the ledger. The unique
-- indexes below are the final word on "at most once": a redemption credits at
-- most once, a quote is charged at most once, a waypoint is refunded at most
-- once — whatever the application or Redis get wrong.

CREATE TABLE IF NOT EXISTS gta_wallets (
  channel_id        TEXT   NOT NULL,
  twitch_user_id    TEXT   NOT NULL,              -- numeric Twitch user id, as text
  -- Enforced here, not only in code: no path can overdraw a wallet.
  balance           BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, twitch_user_id),
  CHECK (twitch_user_id ~ '^[0-9]{1,20}$')
);

CREATE TABLE IF NOT EXISTS gta_wallet_transactions (
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
CREATE UNIQUE INDEX IF NOT EXISTS gta_tx_one_debit_per_quote
  ON gta_wallet_transactions(quote_id) WHERE type = 'WAYPOINT_DEBIT';
CREATE UNIQUE INDEX IF NOT EXISTS gta_tx_one_refund_per_waypoint
  ON gta_wallet_transactions(waypoint_id) WHERE type = 'MISSION_REFUND';
CREATE INDEX IF NOT EXISTS gta_tx_wallet_idx
  ON gta_wallet_transactions(channel_id, twitch_user_id, created_at DESC);
-- The fulfilment retry sweep only ever looks for PENDING rows.
CREATE INDEX IF NOT EXISTS gta_tx_fulfillment_idx
  ON gta_wallet_transactions(fulfillment_status) WHERE fulfillment_status = 'PENDING';

-- The one exchange reward per channel. Its id is how a redemption is
-- recognised; rewards are never identified by title, except once, when Twitch
-- refuses a duplicate title and we adopt the reward our own client created.
CREATE TABLE IF NOT EXISTS gta_exchange_rewards (
  channel_id        TEXT PRIMARY KEY,
  twitch_reward_id  TEXT NOT NULL UNIQUE,            -- gtaDollarExchangeRewardId
  title             TEXT NOT NULL,
  cost              INTEGER NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Everything that exists today was priced and paid in Channel Points.
ALTER TABLE waypoint_quotes ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'CHANNEL_POINTS'; -- | 'GTA_DOLLAR'
ALTER TABLE waypoints       ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'CHANNEL_POINTS';
