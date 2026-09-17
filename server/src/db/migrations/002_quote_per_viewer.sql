-- One live quote per viewer.
--
-- The application serialises supersede-then-create with a Redis lock, but the
-- database is what actually guarantees it: without this index two parallel
-- requests from one viewer could each create a quote and each lease a reward
-- slot, letting a single person drain the pool.
CREATE UNIQUE INDEX IF NOT EXISTS quotes_one_live_per_viewer
  ON waypoint_quotes(channel_id, twitch_user_id)
  WHERE status IN ('QUOTED', 'AWAITING_REDEMPTION');
