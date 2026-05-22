-- Add tiebreak_rank column — independent from nomination order (priority_rank)
ALTER TABLE teams ADD COLUMN IF NOT EXISTS tiebreak_rank INTEGER;

-- Fix demote_priority: only affects tiebreak order, never nomination order
CREATE OR REPLACE FUNCTION demote_priority(p_team_id UUID, p_league_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_max_rank INTEGER;
BEGIN
  SELECT MAX(tiebreak_rank) INTO v_max_rank
  FROM teams WHERE league_id = p_league_id AND is_complete = FALSE AND tiebreak_rank IS NOT NULL;

  INSERT INTO priority_log(league_id, team_id, old_rank, new_rank, reason)
  SELECT p_league_id, p_team_id, tiebreak_rank, v_max_rank + 1, 'tie_break_demotion'
  FROM teams WHERE id = p_team_id;

  UPDATE teams SET tiebreak_rank = v_max_rank + 1, updated_at = NOW() WHERE id = p_team_id;
END;
$$;

-- Fix resolve_auction: tiebreak uses tiebreak_rank, nomination order (priority_rank) is never touched
CREATE OR REPLACE FUNCTION resolve_auction(p_auction_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_league_id UUID;
  v_player_id UUID;
  v_max_bid INTEGER;
  v_winning_team_id UUID;
  v_tie_count INTEGER;
  v_tie_broken BOOLEAN := FALSE;
  v_best_priority INTEGER;
BEGIN
  SELECT league_id, player_id INTO v_league_id, v_player_id
  FROM auctions WHERE id = p_auction_id;

  -- Find max bid >= min_bid(1)
  SELECT MAX(amount) INTO v_max_bid
  FROM bids WHERE auction_id = p_auction_id AND amount >= 1;

  IF v_max_bid IS NULL THEN
    -- No valid bids — auction goes unclaimed, return player to pool
    UPDATE auctions SET status = 'completed', updated_at = NOW() WHERE id = p_auction_id;
    UPDATE players SET status = 'available' WHERE id = v_player_id;
    RETURN;
  END IF;

  -- Check for ties
  SELECT COUNT(*) INTO v_tie_count
  FROM bids b
  JOIN teams t ON t.id = b.team_id
  WHERE b.auction_id = p_auction_id AND b.amount = v_max_bid AND t.is_complete = FALSE;

  IF v_tie_count = 1 THEN
    SELECT b.team_id INTO v_winning_team_id
    FROM bids b JOIN teams t ON t.id = b.team_id
    WHERE b.auction_id = p_auction_id AND b.amount = v_max_bid AND t.is_complete = FALSE;
  ELSE
    -- Tie: winner is team with best (lowest) tiebreak_rank
    v_tie_broken := TRUE;
    SELECT b.team_id, t.tiebreak_rank INTO v_winning_team_id, v_best_priority
    FROM bids b JOIN teams t ON t.id = b.team_id
    WHERE b.auction_id = p_auction_id AND b.amount = v_max_bid
      AND t.is_complete = FALSE AND t.tiebreak_rank IS NOT NULL
    ORDER BY t.tiebreak_rank ASC
    LIMIT 1;

    -- Push winner to bottom of tiebreak order (nomination order is unaffected)
    PERFORM demote_priority(v_winning_team_id, v_league_id);
  END IF;

  -- Check team can afford
  DECLARE v_budget INTEGER;
  BEGIN
    SELECT budget_remaining INTO v_budget FROM teams WHERE id = v_winning_team_id;
    IF v_budget < v_max_bid THEN
      -- Team can't afford — find next valid bidder (skip for now, admin handles edge case)
      NULL;
    END IF;
  END;

  -- Assign player to team
  UPDATE players SET
    status = 'drafted',
    drafted_by_team_id = v_winning_team_id,
    draft_price = v_max_bid
  WHERE id = v_player_id;

  -- Mark auction complete
  UPDATE auctions SET
    status = 'completed',
    winning_team_id = v_winning_team_id,
    winning_bid = v_max_bid,
    tie_broken_by_priority = v_tie_broken,
    updated_at = NOW()
  WHERE id = p_auction_id;

  -- Refresh team stats
  PERFORM refresh_team_stats(v_winning_team_id);

  -- Remove complete team from priority
  PERFORM remove_complete_team_from_priority(v_winning_team_id, v_league_id);
END;
$$;
