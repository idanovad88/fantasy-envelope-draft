-- Schedules the nightly player-pool top-up.
--
-- ⚠️ This is NOT applied by any build or deploy. It is run ONCE by hand in the
-- Supabase SQL Editor, and the schedule then lives in the database — there is
-- nothing in the repo that will tell you it is running. See CLAUDE.md
-- ("Scheduled jobs") before assuming the feature is unscheduled.
--
-- ⚠️ ORDER MATTERS. Scheduling this before the baseline exists will re-add
-- every player an admin has trimmed out of a league, overnight, silently:
--   1. supabase/migration_player_exclusions.sql
--   2. deploy
--   3. npm run baseline-pool -- --write
--   4. this file
--
-- Prerequisites:
--   1. Supabase Dashboard → Database → Extensions → `pg_cron` and `pg_net`.
--   2. The app must already be deployed — the URL below has to be live.
--   3. Replace <production-domain> and <CRON_SECRET> with the real values.
--      CRON_SECRET must match the env var set in the Vercel dashboard.
--
-- ⚠️ Step 3 fails silently when missed: pg_cron happily stores the literal
-- placeholders, cron.job_run_details still reports 'succeeded' (the SELECT ran;
-- only the HTTP call inside it failed), and the only symptom is that no league
-- is ever topped up. ALWAYS run the verification at the bottom after applying.

-- Once a day, not once a minute. ESPN's ranks move weekly at most and a player
-- appears on a roster once, so a daily sweep is as current as the data is; the
-- route is idempotent, so a quiet day writes nothing.
--
-- 04:00 UTC ≈ 06:00–07:00 Israel: after the night hold on the open draft has
-- lifted, before anyone is looking at the board.
--
-- The HTTP call is guarded the way notify-auctions is, because it costs Vercel
-- Fluid Active CPU and the check is free inside Postgres. The clause mirrors
-- the route's own filter exactly — OPEN_STATUSES in
-- app/api/cron/top-up-pools/route.ts. ⚠️ Widening what the route acts on means
-- widening this, or the new work silently never runs.

SELECT cron.schedule(
  'top-up-pools',
  '0 4 * * *',
  $$
    SELECT net.http_post(
      url := 'https://<production-domain>/api/cron/top-up-pools',
      headers := '{"Authorization": "Bearer <CRON_SECRET>"}'::jsonb
    )
    WHERE EXISTS (
      SELECT 1 FROM leagues
      WHERE status IN ('setup', 'lottery', 'active', 'paused')
    );
  $$
);

-- Inspect:    SELECT * FROM cron.job WHERE jobname = 'top-up-pools';
-- Run log:    SELECT * FROM cron.job_run_details WHERE jobid =
--               (SELECT jobid FROM cron.job WHERE jobname = 'top-up-pools')
--             ORDER BY start_time DESC LIMIT 10;
--             return_message '0 rows' = every league is completed and no HTTP
--             call was made; '1 row' = the route was actually invoked.
-- Reschedule: re-run cron.schedule with the same name to replace it.
-- Remove:     SELECT cron.unschedule('top-up-pools');

-- ── Verify after applying ────────────────────────────────────────────────────
-- 1. Both must come back false. If either is true, step 3 above was missed.
--
--   SELECT command LIKE '%<production-domain>%'                   AS domain_placeholder_left,
--          command LIKE '%<CRON_SECRET>%'                         AS secret_placeholder_left,
--          length(substring(command from 'Bearer ([^"]*)'))       AS token_length,
--          left(md5(substring(command from 'Bearer ([^"]*)')), 8) AS token_fingerprint
--   FROM cron.job WHERE jobname = 'top-up-pools';
--
-- ⚠️ The two placeholder flags are NOT enough, and this is not hypothetical.
-- `notify-auctions` shipped on 2026-07-27 carrying the literal string
-- CRON_SECRET — the variable *name*, pasted in place of its value. No angle
-- brackets, so both flags read false, and the job returned 401 for 46 days
-- without one push ever going out. It went unnoticed because every envelope
-- league was `completed`, so its guard held and it never called Vercel at all.
--
-- `token_length` is what catches that shape: the real secret is 48 characters
-- and anything much shorter is a word somebody typed. Compare
-- `token_fingerprint` across all three HTTP jobs — they must match each other,
-- since they share one secret:
--
--   SELECT jobname,
--          length(substring(command from 'Bearer ([^"]*)'))       AS token_length,
--          left(md5(substring(command from 'Bearer ([^"]*)')), 8) AS token_fingerprint
--   FROM cron.job WHERE command LIKE '%http_post%' ORDER BY jobid;
--
-- 2. What actually left the database. A 401 means CRON_SECRET does not match
--    Vercel's env var; a populated error_msg means the URL never resolved.
--
--   SELECT status_code, error_msg, count(*), max(created)
--   FROM net._http_response
--   WHERE created > now() - interval '2 days'
--   GROUP BY status_code, error_msg;
--
-- 3. What it actually did. The route logs every name it adds to the Vercel
--    runtime log ("[top-up-pools] <league>: added N — ..."), but the database
--    side is visible here: players inserted since the job started running, per
--    unfinished league.
--
--   SELECT l.name, l.status, count(*) FILTER (WHERE p.created_at > now() - interval '2 days') AS added_recently,
--          count(*) AS pool_size
--   FROM leagues l JOIN players p ON p.league_id = l.id
--   WHERE l.status <> 'completed'
--   GROUP BY l.name, l.status;

-- ── Running it once, now, without waiting for 04:00 ──────────────────────────
-- `?dry=1` reports what it *would* add and writes nothing — do this first.
--
--   SELECT net.http_post(
--     url := 'https://<production-domain>/api/cron/top-up-pools?dry=1',
--     headers := '{"Authorization": "Bearer <CRON_SECRET>"}'::jsonb
--   );
--
-- Then read the reply (net.http_post is async — the body lands here):
--
--   SELECT status_code, content FROM net._http_response
--   ORDER BY created DESC LIMIT 1;
--
-- Drop `?dry=1` to actually run it.
