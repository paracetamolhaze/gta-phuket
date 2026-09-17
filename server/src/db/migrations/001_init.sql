-- GTA Phuket: initial schema.
-- Applied by src/db/migrate.ts, which records each file in schema_migrations.

CREATE TABLE IF NOT EXISTS channels (
  id                TEXT PRIMARY KEY,            -- Twitch broadcaster user id
  login             TEXT,
  display_name      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Broadcaster OAuth credentials. One row per channel; tokens are rotated
-- in place by the refresh routine.
CREATE TABLE IF NOT EXISTS broadcaster_oauth (
  channel_id        TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  access_token      TEXT NOT NULL,
  refresh_token     TEXT NOT NULL,
  scopes            TEXT[] NOT NULL DEFAULT '{}',
  expires_at        TIMESTAMPTZ NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channel_settings (
  channel_id        TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  settings          JSONB NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Phones authorised to push GPS for a channel.
CREATE TABLE IF NOT EXISTS streamer_devices (
  id                TEXT PRIMARY KEY,
  channel_id        TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  label             TEXT NOT NULL DEFAULT 'phone',
  token_hash        TEXT NOT NULL,
  revoked           BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS streamer_devices_channel_idx ON streamer_devices(channel_id);

-- Raw GPS history. Subject to the retention job; the live position lives in Redis.
CREATE TABLE IF NOT EXISTS gps_samples (
  id                BIGSERIAL PRIMARY KEY,
  channel_id        TEXT NOT NULL,
  device_id         TEXT,
  lat               DOUBLE PRECISION NOT NULL,
  lng               DOUBLE PRECISION NOT NULL,
  accuracy          DOUBLE PRECISION NOT NULL,
  heading           DOUBLE PRECISION,
  speed             DOUBLE PRECISION,
  device_time       TIMESTAMPTZ NOT NULL,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gps_samples_channel_time_idx
  ON gps_samples(channel_id, received_at DESC);

-- The pool of Twitch Custom Rewards this application owns and rewrites.
CREATE TABLE IF NOT EXISTS twitch_reward_slots (
  id                TEXT PRIMARY KEY,
  channel_id        TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  slot_index        INTEGER NOT NULL,
  twitch_reward_id  TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'FREE',      -- FREE|RESERVED|CONSUMED|BROKEN
  quote_id          TEXT,
  reserved_for_user TEXT,
  current_title     TEXT NOT NULL DEFAULT '',
  current_cost      INTEGER NOT NULL DEFAULT 1,
  enabled           BOOLEAN NOT NULL DEFAULT FALSE,
  reserved_at       TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_id, slot_index),
  UNIQUE (twitch_reward_id)
);
CREATE INDEX IF NOT EXISTS reward_slots_status_idx ON twitch_reward_slots(channel_id, status);

CREATE TABLE IF NOT EXISTS waypoint_quotes (
  id                TEXT PRIMARY KEY,
  code              TEXT NOT NULL,
  channel_id        TEXT NOT NULL,
  twitch_user_id    TEXT NOT NULL,
  twitch_user_name  TEXT,
  origin_lat        DOUBLE PRECISION NOT NULL,
  origin_lng        DOUBLE PRECISION NOT NULL,
  dest_lat          DOUBLE PRECISION NOT NULL,
  dest_lng          DOUBLE PRECISION NOT NULL,
  dest_name         TEXT NOT NULL,
  dest_category     TEXT,
  distance_meters   DOUBLE PRECISION NOT NULL,
  duration_seconds  DOUBLE PRECISION NOT NULL,
  route_geometry    TEXT NOT NULL,
  cost              INTEGER NOT NULL,
  price_breakdown   JSONB,
  status            TEXT NOT NULL DEFAULT 'QUOTED',    -- QUOTED|AWAITING_REDEMPTION|PAID|EXPIRED|CANCELED
  slot_id           TEXT REFERENCES twitch_reward_slots(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS quotes_channel_status_idx ON waypoint_quotes(channel_id, status);
CREATE INDEX IF NOT EXISTS quotes_user_idx ON waypoint_quotes(twitch_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS quotes_code_active_idx
  ON waypoint_quotes(channel_id, code)
  WHERE status IN ('QUOTED', 'AWAITING_REDEMPTION');

CREATE TABLE IF NOT EXISTS waypoints (
  id                TEXT PRIMARY KEY,
  channel_id        TEXT NOT NULL,
  quote_id          TEXT NOT NULL REFERENCES waypoint_quotes(id) ON DELETE CASCADE,
  twitch_user_id    TEXT NOT NULL,
  twitch_user_name  TEXT,
  dest_lat          DOUBLE PRECISION NOT NULL,
  dest_lng          DOUBLE PRECISION NOT NULL,
  dest_name         TEXT NOT NULL,
  dest_category     TEXT,
  distance_meters   DOUBLE PRECISION NOT NULL,
  duration_seconds  DOUBLE PRECISION NOT NULL,
  route_geometry    TEXT NOT NULL,
  points_paid       INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'ACTIVE',    -- ACTIVE|COMPLETED|CANCELED
  cancel_reason     TEXT,
  activated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  canceled_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS waypoints_channel_status_idx ON waypoints(channel_id, status);
-- At most one ACTIVE waypoint per channel: the database, not the app, is the
-- final arbiter of the "one job at a time" rule.
CREATE UNIQUE INDEX IF NOT EXISTS waypoints_one_active_per_channel
  ON waypoints(channel_id)
  WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS waypoints_one_per_quote ON waypoints(quote_id);

CREATE TABLE IF NOT EXISTS twitch_redemptions (
  id                TEXT PRIMARY KEY,                  -- Twitch redemption id
  channel_id        TEXT NOT NULL,
  reward_id         TEXT NOT NULL,
  slot_id           TEXT,
  quote_id          TEXT,
  twitch_user_id    TEXT NOT NULL,
  twitch_user_name  TEXT,
  cost              INTEGER NOT NULL,
  resolution        TEXT NOT NULL,                     -- FULFILLED|CANCELED|PENDING|FAILED
  reason            TEXT,
  redeemed_at       TIMESTAMPTZ NOT NULL,
  processed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS redemptions_channel_idx ON twitch_redemptions(channel_id, redeemed_at DESC);

-- Durable idempotency for EventSub. Redis handles the hot path; this table is
-- the backstop that survives a Redis flush.
CREATE TABLE IF NOT EXISTS eventsub_events (
  message_id        TEXT PRIMARY KEY,
  subscription_type TEXT NOT NULL,
  channel_id        TEXT,
  payload           JSONB NOT NULL,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eventsub_events_received_idx ON eventsub_events(received_at);

-- OAuth CSRF state values, short lived.
CREATE TABLE IF NOT EXISTS oauth_states (
  state             TEXT PRIMARY KEY,
  redirect_to       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
