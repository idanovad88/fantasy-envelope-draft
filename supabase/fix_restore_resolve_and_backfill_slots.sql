-- ============================================================
-- FIX: Restore the canonical resolve_auction (with roster-slot assignment
-- and turn rotation) and backfill roster_slot for already-drafted players.
--
-- Run this once in the Supabase SQL Editor.
-- Safe to re-run (idempotent).
-- ============================================================

-- 1. assign_roster_slot — place a drafted player in the best available slot
CREATE OR REPLACE FUNCTION assign_roster_slot(
  p_player_id UUID,
  p_team_id   UUID,
  p_league_id UUID
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  v_position TEXT;
  v_slots    JSONB;
  v_priority TEXT[];
  v_slot     TEXT;
  v_capacity INTEGER;
  v_used     INTEGER;
BEGIN
  SELECT position INTO v_position FROM players WHERE id = p_player_id;
  SELECT roster_slots INTO v_slots FROM leagues WHERE id = p_league_id;

  -- If no roster slots configured for this league, skip assignment
  IF v_slots IS NULL THEN RETURN; END IF;

  -- Priority list: specific slot → combo slot → UTIL → BENCH
  v_priority := CASE upper(coalesce(v_position, ''))
    WHEN 'PG' THEN ARRAY['PG','G','UTIL','BENCH']
    WHEN 'SG' THEN ARRAY['SG','G','UTIL','BENCH']
    WHEN 'SF' THEN ARRAY['SF','F','UTIL','BENCH']
    WHEN 'PF' THEN ARRAY['PF','F','UTIL','BENCH']
    WHEN 'C'  THEN ARRAY['C','UTIL','BENCH']
    WHEN 'G'  THEN ARRAY['G','UTIL','BENCH']
    WHEN 'F'  THEN ARRAY['F','UTIL','BENCH']
    ELSE           ARRAY['UTIL','BENCH']
  END;

  FOREACH v_slot IN ARRAY v_priority LOOP
    v_capacity := COALESCE((v_slots ->> v_slot)::INTEGER, 0);
    IF v_capacity > 0 THEN
      SELECT COUNT(*) INTO v_used
      FROM players
      WHERE drafted_by_team_id = p_team_id AND roster_slot = v_slot;
      IF v_used < v_capacity THEN
        UPDATE players SET roster_slot = v_slot WHERE id = p_player_id;
        RETURN;
      END IF;
    END IF;
  END LOOP;

  -- Fallback: BENCH with no capacity limit
  UPDATE players SET roster_slot = 'BENCH' WHERE id = p_player_id;
END;
$$;

-- 2. resolve_auction — canonical version (roster slot + turn rotation + tiebreak)
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

  -- Max bid among non-complete teams only (complete teams can't receive players)
  SELECT MAX(b.amount) INTO v_max_bid
  FROM bids b JOIN teams t ON t.id = b.team_id
  WHERE b.auction_id = p_auction_id AND b.amount >= 1 AND t.is_complete = FALSE;

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

  -- Assign roster slot based on league's slot configuration
  PERFORM assign_roster_slot(v_player_id, v_winning_team_id, v_league_id);

  -- Mark auction complete
  UPDATE auctions SET
    status                 = 'completed',
    winning_team_id        = v_winning_team_id,
    winning_bid            = v_max_bid,
    tie_broken_by_priority = v_tie_broken,
    updated_at             = NOW()
  WHERE id = p_auction_id;

  -- Refresh stats (may set winning team is_complete = TRUE)
  PERFORM refresh_team_stats(v_winning_team_id);

  -- Remove winning team from priority queue if now complete
  PERFORM remove_complete_team_from_priority(v_winning_team_id, v_league_id);

  -- Always rotate the nomination turn: demote the nominating team
  IF v_nominating_team_id IS NOT NULL THEN
    PERFORM demote_priority(v_nominating_team_id, v_league_id);
    PERFORM remove_complete_team_from_priority(v_nominating_team_id, v_league_id);
  END IF;

  -- Tie-break penalty: additionally demote the WINNING team
  IF v_tie_broken THEN
    SELECT MAX(tiebreak_rank) INTO v_best_priority
    FROM teams WHERE league_id = v_league_id;

    UPDATE teams SET tiebreak_rank = v_best_priority + 1 WHERE id = v_winning_team_id;

    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY tiebreak_rank ASC NULLS LAST) AS new_rank
      FROM teams WHERE league_id = v_league_id
    )
    UPDATE teams t SET tiebreak_rank = r.new_rank
    FROM ranked r WHERE t.id = r.id AND t.league_id = v_league_id;

    IF v_winning_team_id IS DISTINCT FROM v_nominating_team_id THEN
      IF EXISTS (SELECT 1 FROM teams WHERE id = v_winning_team_id AND priority_rank IS NOT NULL) THEN
        PERFORM demote_priority(v_winning_team_id, v_league_id);
      END IF;
    END IF;
  END IF;
END;
$$;

-- 3. Backfill: assign a roster_slot to every already-drafted player that is
--    missing one, in leagues that have slots configured.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT p.id, p.drafted_by_team_id, p.league_id
    FROM players p
    JOIN leagues l ON l.id = p.league_id
    WHERE p.status = 'drafted'
      AND p.roster_slot IS NULL
      AND p.drafted_by_team_id IS NOT NULL
      AND l.roster_slots IS NOT NULL
    -- assign in draft order so slot capacities fill predictably
    ORDER BY p.draft_price DESC NULLS LAST, p.id
  LOOP
    PERFORM assign_roster_slot(r.id, r.drafted_by_team_id, r.league_id);
  END LOOP;
END $$;
