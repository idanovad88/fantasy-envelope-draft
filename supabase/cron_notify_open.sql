-- Schedules the open-outcry notification cron.
--
-- ⚠️ This is NOT applied by any build or deploy. It is run ONCE by hand in the
-- Supabase SQL Editor, and the schedule then lives in the database — there is
-- nothing in the repo that will tell you it is running. See CLAUDE.md
-- ("Scheduled jobs") before assuming the feature is unscheduled.
--
-- Prerequisites:
--   1. supabase/migration_open_notifications.sql has been applied.
--   2. Supabase Dashboard → Database → Extensions → `pg_cron` and `pg_net`.
--   3. The app must already be deployed — the URL below has to be live.
--   4. Replace <production-domain> and <CRON_SECRET> with the real values.
--      CRON_SECRET must match the env var set in the Vercel dashboard.
--
-- ⚠️ Step 4 fails silently when missed: pg_cron happily stores the literal
-- placeholders, cron.job_run_details still reports 'succeeded' (the SELECT ran;
-- only the HTTP call inside it failed), and the only symptom is that no push
-- ever arrives. ALWAYS run the verification at the bottom after applying.

-- Every minute, but the HTTP call is guarded: the check is free inside Postgres
-- and every call out to Vercel costs Fluid Active CPU. Unlike notify-auctions,
-- the guard here cannot drift from what the route does — both sides call the
-- same two functions, and each of them already excludes anything claimed in
-- open_notifications and anything outside the league's draft hours.

SELECT cron.schedule(
  'notify-open-draft',
  '* * * * *',
  $$
    SELECT net.http_post(
      url := 'https://<production-domain>/api/cron/notify-open',
      headers := '{"Authorization": "Bearer <CRON_SECRET>"}'::jsonb
    )
    WHERE EXISTS (SELECT 1 FROM open_notify_turn_candidates())
       OR EXISTS (SELECT 1 FROM open_notify_bid_events());
  $$
);

-- Inspect:   SELECT * FROM cron.job;
-- Run log:   SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 10;
--            return_message '0 rows' = the guard held and no HTTP call was
--            made; '1 row' = the route was actually invoked.
-- Reschedule: re-run cron.schedule with the same name to replace it.
-- Remove:    SELECT cron.unschedule('notify-open-draft');

-- ── Verify after applying ────────────────────────────────────────────────────
-- 1. Both must come back false. If either is true, step 4 above was missed.
--
--   SELECT command LIKE '%<production-domain>%' AS domain_placeholder_left,
--          command LIKE '%<CRON_SECRET>%'       AS secret_placeholder_left
--   FROM cron.job WHERE jobname = 'notify-open-draft';
--
-- 2. What actually left the database. Empty is expected while the guard holds.
--    A 401 means CRON_SECRET does not match Vercel's env var; a populated
--    error_msg means the URL never resolved.
--
--   SELECT status_code, error_msg, count(*), max(created)
--   FROM net._http_response
--   WHERE created > now() - interval '2 hours'
--   GROUP BY status_code, error_msg;
--
-- 3. What the job has actually sent.
--
--   SELECT kind, count(*), max(sent_at) FROM open_notifications GROUP BY kind;
