-- Team assistant manager (עוזר מנהל קבוצה)
-- Adds a single optional assistant per team who can place/view the team's bids,
-- plus an invite-link mechanism for the owner to attach an assistant.
-- Run in the Supabase SQL Editor.

-- ============================================================
-- 1. Assistant slot on teams
-- ============================================================
ALTER TABLE teams ADD COLUMN IF NOT EXISTS assistant_user_id UUID REFERENCES auth.users(id);

-- ============================================================
-- 2. Invite tokens (locked down: service-role only — no policies)
--    Tokens must NOT live on `teams` because teams_read is public (USING true),
--    which would leak the token to every authenticated user.
-- ============================================================
CREATE TABLE IF NOT EXISTS team_invites (
  token UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  league_id UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  created_by UUID REFERENCES auth.users(id),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  used_at TIMESTAMPTZ,
  used_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_team_invites_team ON team_invites(team_id);

ALTER TABLE team_invites ENABLE ROW LEVEL SECURITY;
-- No policies → only the service-role key (createAdminClient) can read/write.

-- ============================================================
-- 3. Extend bid RLS to include the assistant
--    (owner OR assistant of the team can insert/update/see the team's sealed bid)
-- ============================================================
DROP POLICY IF EXISTS "bids_own_or_revealed" ON bids;
CREATE POLICY "bids_own_or_revealed" ON bids FOR SELECT
  USING (
    team_id IN (SELECT id FROM teams WHERE user_id = auth.uid() OR assistant_user_id = auth.uid())
    OR (SELECT status FROM auctions WHERE id = auction_id) IN ('revealed', 'completed')
    OR auth.uid() IN (SELECT user_id FROM admin_users)
  );

DROP POLICY IF EXISTS "bids_team_insert" ON bids;
CREATE POLICY "bids_team_insert" ON bids FOR INSERT
  WITH CHECK (
    team_id IN (
      SELECT id FROM teams
      WHERE (user_id = auth.uid() OR assistant_user_id = auth.uid()) AND is_complete = FALSE
    )
    AND (SELECT status FROM auctions WHERE id = auction_id) = 'active'
  );

DROP POLICY IF EXISTS "bids_team_update" ON bids;
CREATE POLICY "bids_team_update" ON bids FOR UPDATE
  USING (
    team_id IN (SELECT id FROM teams WHERE user_id = auth.uid() OR assistant_user_id = auth.uid())
    AND (SELECT status FROM auctions WHERE id = auction_id) = 'active'
  );
