-- pg_cron job: drive the clock of every open-outcry draft, once a minute.
--
-- Run this ONCE, by hand, in the Supabase SQL Editor, AFTER
-- migration_open_auction_draft.sql. Requires the `pg_cron` extension
-- (Dashboard → Database → Extensions).
--
-- Two things happen on each tick, both inside open_draft_tick():
--   1. Freeze / thaw. When a league leaves its active hours (or an admin
--      pauses it) `open_frozen_since` is stamped; when it comes back every open
--      auction's deadline moves forward by the elapsed gap.
--   2. Any open auction whose deadline has passed gets a `timeout` pass row for
--      every team that never answered, and closes to its current leader.
--
-- Unlike `notify-auctions` this is pure SQL and never calls out to Vercel, so
-- it costs nothing per tick and needs no guard clause — same as
-- `auto-resolve-expired-auctions`.

SELECT cron.schedule(
  'open-draft-tick',
  '* * * * *',
  $$SELECT open_draft_tick_all()$$
);

-- ── Operating notes ─────────────────────────────────────────────────────────
--
-- Is it scheduled?
--   SELECT jobid, jobname, schedule, active, command FROM cron.job ORDER BY jobid;
--
-- Is it running?
--   SELECT * FROM cron.job_run_details
--   WHERE jobname = 'open-draft-tick' ORDER BY start_time DESC LIMIT 10;
--
-- Remove it:
--   SELECT cron.unschedule('open-draft-tick');
--
-- ⚠️ Failures are INVISIBLE in cron.job_run_details. open_draft_tick_all()
-- swallows a per-league error into a RAISE WARNING (so one broken league does
-- not stop the others), and that warning goes to the Postgres log while the job
-- still reports `succeeded`. This is the only query that will tell you an
-- auction is stuck — any row is one the tick has been failing to close, and the
-- warning text is in Dashboard → Logs → Postgres:
--
--   SELECT id, league_id, deadline_at FROM open_auctions
--   WHERE status = 'open' AND deadline_at < now() - interval '5 minutes';
--
-- A frozen league is NOT a stuck one: while `leagues.open_frozen_since` is set
-- the deadlines are deliberately left in the past and are shifted forward the
-- moment the draft resumes. Check that first:
--
--   SELECT id, name, status, open_frozen_since, draft_start_hour, draft_end_hour
--   FROM leagues WHERE draft_type = 'open';
