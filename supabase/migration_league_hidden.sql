-- Per-user league hiding
-- Lets any league member hide a league from their own "הליגות שלי" list without
-- affecting anyone else. Reversible; no data is deleted. Full league deletion
-- stays creator-only (app/api/admin/delete-league).
--
-- Run this in your Supabase SQL Editor. Idempotent.

CREATE TABLE IF NOT EXISTS league_hidden (
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  league_id  UUID NOT NULL REFERENCES leagues(id)    ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, league_id)
);

ALTER TABLE league_hidden ENABLE ROW LEVEL SECURITY;

-- Each user may read/insert/delete only their own hide rows.
DROP POLICY IF EXISTS "league_hidden_own" ON league_hidden;
CREATE POLICY "league_hidden_own" ON league_hidden
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
