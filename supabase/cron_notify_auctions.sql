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

SELECT cron.schedule(
  'notify-auctions',
  '* * * * *',
  $$
    SELECT net.http_post(
      url := 'https://<production-domain>/api/cron/notify-auctions',
      headers := '{"Authorization": "Bearer <CRON_SECRET>"}'::jsonb
    );
  $$
);

-- Inspect:   SELECT * FROM cron.job;
-- Run log:   SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 10;
-- Reschedule: re-run cron.schedule with the same name ('notify-auctions') to replace it.
-- Remove:    SELECT cron.unschedule('notify-auctions');
