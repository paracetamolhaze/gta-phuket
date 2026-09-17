-- EventSub is acknowledged before the business logic runs.
--
-- Twitch expects a 2xx quickly and retries when it does not get one. Our
-- handler makes several Twitch API calls (fulfil or refund, rewrite rewards,
-- release the other slots), which can take seconds. Holding the webhook open
-- for that risks a timeout, and a timeout means Twitch redelivers an event we
-- are in the middle of processing.
--
-- So the row is written and acknowledged first, and processed after. These
-- columns are what makes that safe: an event that fails is still on record and
-- gets retried by the maintenance sweep instead of vanishing with the response.
ALTER TABLE eventsub_events
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attempts     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error   TEXT;

-- Everything already in the table predates async processing and was handled
-- inline, so it is done by definition.
UPDATE eventsub_events SET processed_at = received_at WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS eventsub_events_pending_idx
  ON eventsub_events(received_at)
  WHERE processed_at IS NULL;
