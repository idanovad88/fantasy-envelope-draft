-- Schedules the auction-reveal notification cron.
--
-- ⚠️ This is NOT applied by any build or deploy. It is run ONCE by hand in the
-- Supabase SQL Editor, and the schedule then lives in the database — there is
-- nothing in the repo that will tell you it is running. See CLAUDE.md
-- ("Push notifications") before assuming the feature is unscheduled.
--
-- Prerequisites:
--   1. Supabase Dashboard → Database → Extensions → enable `pg_cron` and `pg_net`.
--   2. The app must already be deployed — the URL below has to be live.
--   3. Replace <production-domain> and <CRON_SECRET> with the real values.
--      CRON_SECRET must match the env var set in the Vercel dashboard.

-- The schedule ticks every minute, but the HTTP call is guarded: pg_cron runs
-- inside Postgres, where checking "is anything actually due?" is free, while
-- every call out to Vercel costs Fluid Active CPU. Unguarded, this billed
-- ~43,200 invocations a month to do nothing on almost all of them. The two
-- EXISTS clauses mirror exactly the two jobs the route performs.

SELECT cron.schedule(
  'notify-auctions',
  '* * * * *',
  $$
    SELECT net.http_post(
      url := 'https://<production-domain>/api/cron/notify-auctions',
      headers := '{"Authorization": "Bearer <CRON_SECRET>"}'::jsonb
    )
    -- 1. An active envelope auction inside its league's notify window that has
    --    not been claimed in auction_notifications for this exact reveal_time.
    --    Moving the deadline makes a new key, so a fresh reminder goes out.
    WHERE EXISTS (
      SELECT 1 FROM auctions a JOIN leagues l ON l.id = a.league_id
      WHERE a.status = 'active' AND l.draft_type = 'envelope'
        AND a.reveal_time > now()
        AND a.reveal_time <= now() + make_interval(mins => l.notify_before_minutes)
        AND NOT EXISTS (
          SELECT 1 FROM auction_notifications n
          WHERE n.auction_id = a.id AND n.kind = 'pre_reveal' AND n.reveal_time = a.reveal_time
        )
    )
    -- 2. An overdue pending auction to activate. The NOT EXISTS mirrors the
    --    "one active auction at a time" guard in activateOverduePendingAuctions:
    --    without it the route would be woken every minute to do nothing while
    --    an auction is live.
    OR EXISTS (
      SELECT 1 FROM auctions a JOIN leagues l ON l.id = a.league_id
      WHERE a.status = 'pending' AND l.draft_type = 'envelope'
        AND a.scheduled_start <= now()
        AND NOT EXISTS (
          SELECT 1 FROM auctions b WHERE b.league_id = a.league_id AND b.status = 'active'
        )
    );
  $$
);

-- Inspect:   SELECT * FROM cron.job;
-- Run log:   SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 10;
--            return_message 'SELECT 0' = the guard held and no HTTP call was
--            made; 'SELECT 1' = the route was actually invoked.
-- Reschedule: re-run cron.schedule with the same name ('notify-auctions') to replace it.
-- Remove:    SELECT cron.unschedule('notify-auctions');
