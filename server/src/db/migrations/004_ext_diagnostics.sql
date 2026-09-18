-- Twitch extension diagnostics (docs/EXTENSION_DIAGNOSTICS.md).
--
-- Two independent records of what happened when Twitch loaded the extension,
-- so the owner never has to open DevTools inside a Twitch iframe:
--
--   ext_diag_events  what the page itself reported (boot script + React app);
--   ext_request_log  what the ingress saw Twitch request, whether or not the
--                    page ever managed to report anything.
--
-- Both are unauthenticated, append-only and short-lived: the maintenance job
-- keeps 7 days and at most 5000 rows of each. Nothing here identifies a viewer
-- — no IP, no user id, no token — and the API redacts before it inserts.

CREATE TABLE IF NOT EXISTS ext_diag_events (
  id                BIGSERIAL PRIMARY KEY,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  client_ts         TIMESTAMPTZ,                 -- the page's clock, informative only
  session           TEXT NOT NULL,               -- random per page load, not per viewer
  surface           TEXT NOT NULL,               -- video_overlay | mobile | config | unknown
  seq               INTEGER,
  event             TEXT NOT NULL,
  channel_id        TEXT,                        -- digits only, or NULL
  viewer_kind       TEXT NOT NULL DEFAULT 'unknown',
  -- The session's state after this event: the client snapshot merged over the
  -- previous row's state, so every row can be read on its own.
  state             JSONB NOT NULL DEFAULT '{}',
  data              JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ext_diag_events_time_idx ON ext_diag_events(received_at DESC);
CREATE INDEX IF NOT EXISTS ext_diag_events_session_idx ON ext_diag_events(session, id);
CREATE INDEX IF NOT EXISTS ext_diag_events_surface_idx ON ext_diag_events(surface, id DESC);

CREATE TABLE IF NOT EXISTS ext_request_log (
  id                BIGSERIAL PRIMARY KEY,
  ts                TIMESTAMPTZ NOT NULL DEFAULT now(),
  source            TEXT NOT NULL DEFAULT 'ingress',   -- ingress | devserver
  method            TEXT NOT NULL,
  path              TEXT NOT NULL,               -- pathname + whitelisted Twitch params only
  status            INTEGER,
  referer           TEXT,                        -- origin + path
  sec_fetch_dest    TEXT,
  sec_fetch_site    TEXT,
  user_agent        TEXT
);
CREATE INDEX IF NOT EXISTS ext_request_log_time_idx ON ext_request_log(ts DESC);
