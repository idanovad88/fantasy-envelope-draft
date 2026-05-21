-- Migration: Fix nomination turn rotation
-- resolve_auction now always demotes the nominating team after each auction,
-- so the turn advances regardless of who wins.

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
  v_best_priority      INTEGER;
BEGIN
  SELECT league_id, player_id, nominating_team_id
  INTO   v_league_id, v_player_id, v_nominating_team_id
  FROM   auctions WHERE id = p_auction_id;

  -- Find max bid >= min_bid (1)
  SELECT MAX(amount) INTO v_max_bid
  FROM   bids WHERE auction_id = p_auction_id AND amount >= 1;

  IF v_max_bid IS NULL THEN
    -- No valid bids — player returns to pool, but turn still rotates
    UPDATE auctions SET status = 'completed', updated_at = NOW() WHERE id = p_auction_id;
    UPDATE players  SET status = 'available'                         WHERE id = v_player_id;
    IF v_nominating_team_id IS NOT NULL THEN
      PERFORM demote_priority(v_nominating_team_id, v_league_id);
    END IF;
    RETURN;
  END IF;

  -- Check for ties
  SELECT COUNT(*) INTO v_tie_count
  FROM bids b JOIN teams t ON t.id = b.team_id
  WHERE b.auction_id = p_auction_id AND b.amount = v_max_bid AND t.is_complete = FALSE;

  IF v_tie_count = 1 THEN
    SELECT b.team_id INTO v_winning_team_id
    FROM bids b JOIN teams t ON t.id = b.team_id
    WHERE b.auction_id = p_auction_id AND b.amount = v_max_bid AND t.is_complete = FALSE;
  ELSE
    -- Tie: winner is team with best (lowest) tiebreak_rank
    v_tie_broken := TRUE;
    SELECT b.team_id, COALESCE(t.tiebreak_rank, t.priority_rank)
    INTO   v_winning_team_id, v_best_priority
    FROM bids b JOIN teams t ON t.id = b.team_id
    WHERE b.auction_id = p_auction_id AND b.amount = v_max_bid
      AND t.is_complete = FALSE
    ORDER BY COALESCE(t.tiebreak_rank, t.priority_rank) ASC
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
    status               = 'completed',
    winning_team_id      = v_winning_team_id,
    winning_bid          = v_max_bid,
    tie_broken_by_priority = v_tie_broken,
    updated_at           = NOW()
  WHERE id = p_auction_id;

  -- Refresh stats (may set winning team is_complete = TRUE)
  PERFORM refresh_team_stats(v_winning_team_id);

  -- Remove winning team from priority queue if now complete
  PERFORM remove_complete_team_from_priority(v_winning_team_id, v_league_id);

  -- Always rotate the nomination turn: demote the nominating team
  IF v_nominating_team_id IS NOT NULL THEN
    PERFORM demote_priority(v_nominating_team_id, v_league_id);
    -- Safety: if nominating team just completed (won and filled roster), remove from queue
    PERFORM remove_complete_team_from_priority(v_nominating_team_id, v_league_id);
  END IF;

  -- Tie-break penalty: additionally demote the WINNING team
  IF v_tie_broken THEN
    -- Tiebreak rank demotion (always, regardless of nominating vs winning)
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

    -- Priority rank demotion for winning team — only if different from nominating team
    -- (nominating team was already demoted above)
    IF v_winning_team_id IS DISTINCT FROM v_nominating_team_id THEN
      IF EXISTS (SELECT 1 FROM teams WHERE id = v_winning_team_id AND priority_rank IS NOT NULL) THEN
        PERFORM demote_priority(v_winning_team_id, v_league_id);
      END IF;
    END IF;
  END IF;

END;
$$;
