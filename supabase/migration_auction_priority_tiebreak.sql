-- Migration: Use priority_rank for auction tie-breaking
-- Previously tiebreak_rank was a separate lottery rank; now priority_rank (nomination order)
-- is used for both nomination turns and tie-breaking.
-- Winning team via priority tie-break is demoted to bottom of priority_rank.

-- demote_priority now moves the team to the bottom of priority_rank
CREATE OR REPLACE FUNCTION demote_priority(p_team_id UUID, p_league_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_max_rank INTEGER;
BEGIN
  SELECT MAX(priority_rank) INTO v_max_rank
  FROM teams WHERE league_id = p_league_id AND is_complete = FALSE AND priority_rank IS NOT NULL;

  INSERT INTO priority_log(league_id, team_id, old_rank, new_rank, reason)
  SELECT p_league_id, p_team_id, priority_rank, v_max_rank + 1, 'demotion'
  FROM teams WHERE id = p_team_id;

  UPDATE teams SET priority_rank = v_max_rank + 1, updated_at = NOW() WHERE id = p_team_id;
END;
$$;

-- resolve_auction: tie-breaking uses priority_rank; priority tie-break winner is demoted
CREATE OR REPLACE FUNCTION resolve_auction(p_auction_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_league_id          UUID;
  v_player_id          UUID;
  v_nominating_team_id UUID;
  v_max_bid            INTEGER;
  v_winning_team_id    UUID;
  v_tie_count          INTEGER;
  v_tie_broken         BOOLEAN := FALSE;
BEGIN
  SELECT league_id, player_id, nominating_team_id
  INTO   v_league_id, v_player_id, v_nominating_team_id
  FROM   auctions WHERE id = p_auction_id;

  -- Find max bid >= 1 (nominating team always has an auto-bid of 1)
  SELECT MAX(amount) INTO v_max_bid
  FROM   bids WHERE auction_id = p_auction_id AND amount >= 1;

  IF v_max_bid IS NULL THEN
    -- No valid bids — player returns to pool, turn still rotates
    UPDATE auctions SET status = 'completed', updated_at = NOW() WHERE id = p_auction_id;
    UPDATE players  SET status = 'available'                         WHERE id = v_player_id;
    IF v_nominating_team_id IS NOT NULL THEN
      PERFORM demote_priority(v_nominating_team_id, v_league_id);
    END IF;
    RETURN;
  END IF;

  -- Count teams tied at max bid
  SELECT COUNT(*) INTO v_tie_count
  FROM bids b JOIN teams t ON t.id = b.team_id
  WHERE b.auction_id = p_auction_id AND b.amount = v_max_bid AND t.is_complete = FALSE;

  IF v_tie_count = 1 THEN
    SELECT b.team_id INTO v_winning_team_id
    FROM bids b JOIN teams t ON t.id = b.team_id
    WHERE b.auction_id = p_auction_id AND b.amount = v_max_bid AND t.is_complete = FALSE;
  ELSE
    -- Tie: team with lowest priority_rank (= highest priority) wins
    v_tie_broken := TRUE;
    SELECT b.team_id INTO v_winning_team_id
    FROM bids b JOIN teams t ON t.id = b.team_id
    WHERE b.auction_id = p_auction_id AND b.amount = v_max_bid
      AND t.is_complete = FALSE
    ORDER BY t.priority_rank ASC NULLS LAST
    LIMIT 1;
  END IF;

  -- Assign player to winning team
  UPDATE players SET
    status             = 'drafted',
    drafted_by_team_id = v_winning_team_id,
    draft_price        = v_max_bid
  WHERE id = v_player_id;

  -- Mark auction complete
  UPDATE auctions SET
    status                 = 'completed',
    winning_team_id        = v_winning_team_id,
    winning_bid            = v_max_bid,
    tie_broken_by_priority = v_tie_broken,
    updated_at             = NOW()
  WHERE id = p_auction_id;

  -- Refresh stats (may mark winning team as complete)
  PERFORM refresh_team_stats(v_winning_team_id);

  -- Remove winning team from priority queue if now complete
  PERFORM remove_complete_team_from_priority(v_winning_team_id, v_league_id);

  -- Always rotate nomination turn: demote nominating team to bottom of priority_rank
  IF v_nominating_team_id IS NOT NULL THEN
    PERFORM demote_priority(v_nominating_team_id, v_league_id);
    PERFORM remove_complete_team_from_priority(v_nominating_team_id, v_league_id);
  END IF;

  -- Priority tie-break penalty: also demote winning team if different from nominator
  -- (nominator was already demoted above for nomination rotation)
  IF v_tie_broken AND v_winning_team_id IS DISTINCT FROM v_nominating_team_id THEN
    IF EXISTS (
      SELECT 1 FROM teams
      WHERE id = v_winning_team_id AND priority_rank IS NOT NULL AND is_complete = FALSE
    ) THEN
      PERFORM demote_priority(v_winning_team_id, v_league_id);
    END IF;
  END IF;

END;
$$;
