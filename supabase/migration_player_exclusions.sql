-- Remembers that a player was deliberately removed from a league.
--
-- ⚠️ Run this BEFORE scheduling `top-up-pools` (supabase/cron_top_up_pools.sql).
-- Without it the nightly job re-adds every player an admin has trimmed out of
-- the pool, the next morning, with no trace of why. That is not hypothetical:
-- the live league was trimmed from 474 players to 317 by hand on 2026-09-11,
-- and a dry run of the job showed it about to put all 157 back.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS league_player_exclusions (
  league_id   UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  -- normalizePlayerName() from lib/utils.ts, computed app-side. The key is
  -- written by the same code that matches against it, so the two cannot
  -- disagree the way a SQL-side copy of that function would drift.
  name_key    TEXT NOT NULL,
  name        TEXT NOT NULL,
  excluded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (league_id, name_key)
);

-- Service-role only, like `push_subscriptions` and `team_invites`: RLS on and
-- no policies at all, so PostgREST with the anon key sees nothing and can write
-- nothing. Every read and write goes through an API route that has already
-- resolved who is calling.
ALTER TABLE league_player_exclusions ENABLE ROW LEVEL SECURITY;

-- Reading is always "what has this league excluded", never "who excluded this
-- player", so one index on the leading key column is all it needs — and the
-- primary key already provides it.

-- ── Baseline ────────────────────────────────────────────────────────────────
-- Switching this on mid-season needs the same treatment as
-- migration_open_notifications.sql: claim what is already true, so the first
-- nightly run does not fire a backlog at a live league.
--
-- The baseline is "every pool player this league does not currently have",
-- recorded per league, and it cannot be written here because it needs the ESPN
-- pool. Run it from the repo instead, AFTER applying this file:
--
--   npm run baseline-pool
--
-- It is a dry run by default and prints what it would record; pass --write.
-- Re-running it is harmless (ON CONFLICT DO NOTHING), but it only ever *adds*
-- exclusions, so run it once the pool is trimmed the way you want it.

-- ── Inspect ─────────────────────────────────────────────────────────────────
--   SELECT l.name, count(*) AS excluded
--   FROM league_player_exclusions e JOIN leagues l ON l.id = e.league_id
--   GROUP BY l.name ORDER BY 2 DESC;
--
-- Undo one league's exclusions entirely (the nightly job will then top it back
-- up to the full pool on its next run):
--   DELETE FROM league_player_exclusions WHERE league_id = '<id>';
