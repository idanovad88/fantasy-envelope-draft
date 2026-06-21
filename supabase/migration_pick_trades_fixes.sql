-- Trade system fixes (run on a DB that already has migration_pick_trades.sql)
--
-- Replaces execute_trade with a two-phase version: move all traded players
-- first (clearing roster_slot), THEN assign slots. This ensures a player↔player
-- swap places each incoming player in the correct roster position instead of
-- being pushed to a fallback slot because the outgoing player hadn't left yet.
--
-- (The cross-proposal overlap guard — preventing the same pick/player from
-- appearing in two open trades — is enforced in application code in lib/trades.ts
-- and needs no DB change.)

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

  -- Phase 1: apply pick overrides and MOVE every traded player (clear slot),
  -- without assigning slots yet — so departing players free their slots first.
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
