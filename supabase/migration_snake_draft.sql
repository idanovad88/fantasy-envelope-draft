-- Snake draft migration
-- Adds draft_type, pick_timeout_minutes, snake_round_config to leagues
-- Creates snake_picks table for tracking picks in snake drafts

ALTER TABLE leagues
  ADD COLUMN IF NOT EXISTS draft_type TEXT NOT NULL DEFAULT 'envelope'
    CHECK (draft_type IN ('envelope', 'snake')),
  ADD COLUMN IF NOT EXISTS pick_timeout_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS snake_round_config JSONB;
-- snake_round_config: boolean[] where index i = whether round i+1 is reversed
-- null = standard snake (even rounds reversed automatically)

CREATE TABLE IF NOT EXISTS snake_picks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id),
  overall_pick_number INTEGER NOT NULL,
  round INTEGER NOT NULL,
  pick_in_round INTEGER NOT NULL,
  picked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(league_id, overall_pick_number),
  UNIQUE(league_id, player_id)
);

ALTER TABLE snake_picks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "snake_picks_select" ON snake_picks
  FOR SELECT USING (true);
