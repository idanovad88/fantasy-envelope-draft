-- Web Push notifications before auction reveal (envelope drafts)
-- Adds device subscriptions, a per-league lead time, and a send ledger that
-- makes the notify cron idempotent.
-- Run in the Supabase SQL Editor. Additive only — safe on a live DB.

-- ============================================================
-- 1. Device push subscriptions (locked down: service-role only — no policies)
--    An endpoint is a bearer capability to push to that device, so this table
--    must never be publicly selectable (cf. team_invites).
--    No league_id: a user may play in several leagues, the subscription is
--    per-device. Recipient scoping happens at send time.
-- ============================================================
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
-- No policies → only the service-role key (createAdminClient) can read/write.

-- ============================================================
-- 2. Send ledger
--    The UNIQUE key is the concurrency lock: the cron inserts the claim row
--    before sending, so two overlapping ticks can never both send.
--    reveal_time is part of the key on purpose — if an admin moves the
--    deadline, the new time is a new key and a fresh reminder goes out.
-- ============================================================
CREATE TABLE IF NOT EXISTS auction_notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'pre_reveal',
  reveal_time TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  recipients INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (auction_id, kind, reveal_time)
);
CREATE INDEX IF NOT EXISTS idx_auction_notifications_auction ON auction_notifications(auction_id);

ALTER TABLE auction_notifications ENABLE ROW LEVEL SECURITY;
-- No policies → service-role only. Nothing in the UI reads this.

-- ============================================================
-- 3. Per-league lead time
--    NOT reveal_before_minutes — that column is vestigial (default 30) and
--    predates auction_duration_hours. See migration_auction_duration.sql.
--    The upper bound is load-bearing: the cron prefetches a fixed 60-minute
--    window and filters in TS, which is only correct while N <= 60.
-- ============================================================
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS notify_before_minutes INTEGER NOT NULL DEFAULT 1;

DO $$
BEGIN
  ALTER TABLE leagues ADD CONSTRAINT leagues_notify_before_minutes_range
    CHECK (notify_before_minutes BETWEEN 1 AND 60);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- If this migration is re-run on a DB that already had the old default (5),
-- move those leagues to the new 1-minute default. WHERE = 5 avoids clobbering
-- any value an admin set on purpose.
UPDATE leagues SET notify_before_minutes = 1 WHERE notify_before_minutes = 5;

-- ============================================================
-- 4. Index for the cron's hot query
--    Predicate uses only immutable expressions → valid partial index.
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_auctions_reveal_notify ON auctions (reveal_time)
  WHERE status IN ('pending', 'active');

-- Neither new table joins supabase_realtime — the client never reads them.
