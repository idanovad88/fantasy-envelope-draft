-- Schedules the auction auto-resolver.
--
-- ⚠️ Like cron_notify_auctions.sql, this is NOT applied by any build or deploy.
-- It was created by hand and the schedule lives in the database. This file is
-- documentation of what is running in production, reconstructed from
-- `SELECT prosrc FROM pg_proc WHERE proname = 'auto_resolve_expired_auctions'`
-- and `SELECT * FROM cron.job` — it was never in the repo before.
--
-- This is what closes an envelope auction. Nothing in the app does it on a
-- timer: without this job an auction whose reveal_time has passed would stay
-- `active` until an admin acted.

CREATE OR REPLACE FUNCTION auto_resolve_expired_auctions()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_auction_id UUID;
BEGIN
  FOR v_auction_id IN
    SELECT id
    FROM auctions
    WHERE status = 'active'
      AND reveal_time <= NOW()
  LOOP
    BEGIN
      PERFORM resolve_auction(v_auction_id);
    EXCEPTION WHEN OTHERS THEN
      -- Log error but continue processing remaining auctions
      RAISE WARNING 'auto_resolve_expired_auctions: failed for auction % — %', v_auction_id, SQLERRM;
    END;
  END LOOP;
END;
$$;

-- Runs entirely inside Postgres — no net.http_post, so unlike notify-auctions
-- this job costs nothing on Vercel and needs no guard on its schedule.
SELECT cron.schedule(
  'auto-resolve-expired-auctions',
  '* * * * *',
  $$ SELECT auto_resolve_expired_auctions() $$
);

-- ⚠️ Failures are invisible in the usual places. The EXCEPTION block above
-- swallows a failed resolve_auction() into a RAISE WARNING, which goes to the
-- Postgres log — NOT to cron.job_run_details, where this job reports
-- 'succeeded' either way. A stuck auction is retried every minute forever and
-- nothing surfaces it. This is the query that does:
--
--   SELECT id, league_id, reveal_time FROM auctions
--   WHERE status = 'active' AND reveal_time < now() - interval '5 minutes';
--
-- Any row is an auction the resolver has been failing on. Check the Postgres
-- logs (Supabase Dashboard → Logs → Postgres) for the warning text.

-- Inspect:   SELECT * FROM cron.job WHERE jobname = 'auto-resolve-expired-auctions';
-- Remove:    SELECT cron.unschedule('auto-resolve-expired-auctions');
