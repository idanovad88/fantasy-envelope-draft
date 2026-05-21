-- Add tiebreak_rank column (set by lottery, never changes)
ALTER TABLE teams ADD COLUMN IF NOT EXISTS tiebreak_rank INTEGER;

-- Update resolve_auction to use tiebreak_rank for tiebreaking instead of priority_rank
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
    SELECT b.team_id, COALESCE(t.tiebreak_rank, t.priority_rank) INTO v_winning_team_id, v_best_priority
    FROM bids b JOIN teams t ON t.id = b.team_id
    WHERE b.auction_id = p_auction_id AND b.amount = v_max_bid
      AND t.is_complete = FALSE
    ORDER BY COALESCE(t.tiebreak_rank, t.priority_rank) ASC
    LIMIT 1;

    -- Demote winner to bottom of nomination queue
    PERFORM demote_priority(v_winning_team_id, v_league_id);

    -- Demote winner to bottom of tiebreak order too
    SELECT MAX(tiebreak_rank) INTO v_best_priority
    FROM teams WHERE league_id = v_league_id;

    UPDATE teams SET tiebreak_rank = v_best_priority + 1 WHERE id = v_winning_team_id;

    -- Compact tiebreak ranks (fill gaps)
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY tiebreak_rank ASC NULLS LAST) AS new_rank
      FROM teams WHERE league_id = v_league_id
    )
    UPDATE teams t SET tiebreak_rank = r.new_rank
    FROM ranked r WHERE t.id = r.id AND t.league_id = v_league_id;
  END IF;

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
