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
--
-- ⚠️ Step 3 has been missed before, and it fails silently: pg_cron happily
-- stores the literal placeholders, cron.job_run_details still reports
-- 'succeeded' (the SELECT ran; only the HTTP call inside it failed), and the
-- only symptom is that no push notification ever arrives. ALWAYS run the
-- verification at the bottom of this file after applying.

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
    -- 2. An overdue pending auction to activate. This clause cannot be dropped:
    --    the auto-resolve-expired-auctions job filters status = 'active', so it
    --    closes auctions but never opens one — waking this route is the only
    --    thing that flips pending -> active on a timer. The NOT EXISTS mirrors
    --    the "one active auction at a time" guard in
    --    activateOverduePendingAuctions: without it the route would be woken
    --    every minute to do nothing while an auction is live.
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
--            return_message '0 rows' = the guard held and no HTTP call was
--            made; '1 row' = the route was actually invoked. The string is the
--            row count of the guarded SELECT, so some pg_cron versions word it
--            'SELECT 0' / 'SELECT 1' instead; production reports '0 rows'.
-- Reschedule: re-run cron.schedule with the same name ('notify-auctions') to replace it.
-- Remove:    SELECT cron.unschedule('notify-auctions');

-- ── Verify after applying ────────────────────────────────────────────────────
-- 1. Both must come back false. If either is true, step 3 above was missed.
--    Written as LIKE tests rather than SELECT command so the secret is not
--    printed to the screen.
--
--   SELECT command LIKE '%<production-domain>%' AS domain_placeholder_left,
--          command LIKE '%<CRON_SECRET>%'       AS secret_placeholder_left
--   FROM cron.job WHERE jobname = 'notify-auctions';
--
-- 2. What actually left the database. Empty is expected while the guard holds;
--    once a real auction nears its reveal window, a row should appear with
--    status_code 200. A 401 means CRON_SECRET does not match Vercel's env var;
--    a populated error_msg means the URL never resolved.
--
--   SELECT status_code, error_msg, count(*), max(created)
--   FROM net._http_response
--   WHERE created > now() - interval '2 hours'
--   GROUP BY status_code, error_msg;
