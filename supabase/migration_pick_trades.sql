-- Trade system migration (snake draft)
-- Adds the ability for teams to trade future draft picks and already-drafted
-- players. Trades are proposed by a team, accepted by the target team, and
-- finally approved by the league admin before they execute.
--
-- Snake pick order is computed dynamically from teams.priority_rank +
-- snake_round_config (see lib/utils.ts getSnakeTeamForPick). There is no stored
-- pick slot, so traded picks are represented as an *override* layer that wins
-- over the computed default. priority_rank / snake_round_config are never
-- touched by trades.

-- 1. Ownership override for future picks after a trade.
CREATE TABLE IF NOT EXISTS pick_overrides (
  league_id UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  overall_pick_number INTEGER NOT NULL,
  owner_team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (league_id, overall_pick_number)
);

-- 2. Trade proposal + lifecycle.
CREATE TABLE IF NOT EXISTS trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  proposing_team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  target_team_id    UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending_target'
    CHECK (status IN ('pending_target','pending_admin','approved','rejected','cancelled')),
  note TEXT,
  rejection_reason TEXT,
  admin_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  target_responded_at TIMESTAMPTZ,
  admin_responded_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_trades_league_status ON trades(league_id, status);

-- 3. Assets that move in a trade. from_team_id is the current owner giving it up;
--    the receiving team is the *other* of {proposing, target}.
CREATE TABLE IF NOT EXISTS trade_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id UUID NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  from_team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('pick','player')),
  overall_pick_number INTEGER,            -- for asset_type = 'pick'
  player_id UUID REFERENCES players(id),  -- for asset_type = 'player'
  CHECK (
    (asset_type = 'pick'   AND overall_pick_number IS NOT NULL AND player_id IS NULL) OR
    (asset_type = 'player' AND player_id IS NOT NULL AND overall_pick_number IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_trade_assets_trade ON trade_assets(trade_id);

-- 4. RLS: public read (same posture as snake_picks); all writes go through the
--    admin (service-role) client which bypasses RLS.
ALTER TABLE pick_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE trade_assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pick_overrides_select" ON pick_overrides;
DROP POLICY IF EXISTS "trades_select" ON trades;
DROP POLICY IF EXISTS "trade_assets_select" ON trade_assets;
CREATE POLICY "pick_overrides_select" ON pick_overrides FOR SELECT USING (true);
CREATE POLICY "trades_select" ON trades FOR SELECT USING (true);
CREATE POLICY "trade_assets_select" ON trade_assets FOR SELECT USING (true);

-- 5. Atomic trade execution. Applies every asset, recomputes both teams' roster
--    counts, and flips the trade to 'approved'. Validation (ownership, future
--    picks, count-neutrality) is the API route's responsibility; this function
--    re-checks status only and trusts the validated payload.
CREATE OR REPLACE FUNCTION execute_trade(p_trade_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_league_id   UUID;
  v_proposing   UUID;
  v_target      UUID;
  v_status      TEXT;
  v_ppt         INTEGER;
  v_asset       RECORD;
  v_receiving   UUID;
  v_count       INTEGER;
BEGIN
  SELECT league_id, proposing_team_id, target_team_id, status
  INTO   v_league_id, v_proposing, v_target, v_status
  FROM   trades WHERE id = p_trade_id;

  IF v_league_id IS NULL THEN
    RAISE EXCEPTION 'Trade % not found', p_trade_id;
  END IF;
  IF v_status <> 'pending_admin' THEN
    RAISE EXCEPTION 'Trade % is not awaiting admin approval (status=%)', p_trade_id, v_status;
  END IF;

  SELECT players_per_team INTO v_ppt FROM leagues WHERE id = v_league_id;

  -- Phase 1: apply pick overrides and MOVE every traded player to its new team,
  -- clearing roster_slot — but do NOT assign slots yet. This frees the slots of
  -- departing players before any incoming player is placed, so a player↔player
  -- swap (e.g. PG↔PG) lands each player in the correct position.
  FOR v_asset IN
    SELECT * FROM trade_assets WHERE trade_id = p_trade_id
  LOOP
    v_receiving := CASE WHEN v_asset.from_team_id = v_proposing THEN v_target ELSE v_proposing END;

    IF v_asset.asset_type = 'pick' THEN
      INSERT INTO pick_overrides (league_id, overall_pick_number, owner_team_id, updated_at)
      VALUES (v_league_id, v_asset.overall_pick_number, v_receiving, NOW())
      ON CONFLICT (league_id, overall_pick_number)
      DO UPDATE SET owner_team_id = EXCLUDED.owner_team_id, updated_at = NOW();
    ELSE
      UPDATE players
      SET drafted_by_team_id = v_receiving, roster_slot = NULL
      WHERE id = v_asset.player_id;
    END IF;
  END LOOP;

  -- Phase 2: assign each moved player to the best available slot on its new team.
  -- Slot counts now reflect both departures and arrivals.
  FOR v_asset IN
    SELECT * FROM trade_assets WHERE trade_id = p_trade_id AND asset_type = 'player'
  LOOP
    v_receiving := CASE WHEN v_asset.from_team_id = v_proposing THEN v_target ELSE v_proposing END;
    PERFORM assign_roster_slot(v_asset.player_id, v_receiving, v_league_id);
  END LOOP;

  -- Recompute roster size + completion for both teams.
  FOR v_receiving IN SELECT unnest(ARRAY[v_proposing, v_target]) LOOP
    SELECT COUNT(*) INTO v_count
    FROM players WHERE drafted_by_team_id = v_receiving AND status = 'drafted';
    UPDATE teams
    SET player_count = v_count,
        is_complete  = (v_count >= v_ppt),
        updated_at   = NOW()
    WHERE id = v_receiving;
  END LOOP;

  UPDATE trades
  SET status = 'approved', admin_responded_at = NOW()
  WHERE id = p_trade_id;
END;
$$;

-- 6. Realtime: broadcast trade / override / pick changes to connected clients.
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE trades;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE pick_overrides;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE snake_picks;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
