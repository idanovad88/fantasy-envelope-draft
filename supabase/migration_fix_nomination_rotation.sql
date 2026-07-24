-- Migration: fix nomination rotation, and ignore bids from completed teams
--
-- Self-contained and idempotent: every function/trigger it needs is created
-- here with CREATE OR REPLACE, so it does not matter which of the earlier
-- migration files were actually applied to this database.
--
-- WHAT WAS WRONG
-- --------------
-- 1. Nomination order never rotated. resolve_auction() called demote_priority()
--    to "rotate the nomination turn", but demote_priority() demotes
--    tiebreak_rank, not priority_rank. So the nomination order stayed frozen,
--    and every auction instead pushed the *nominating* team down the tiebreak
--    order — the opposite of the intended design, where the two orders are
--    independent. Confirmed empirically: priority_log contains only
--    'tie_break_demotion' rows and never 'nomination_rotation'.
--
-- 2. Completed teams' bids still counted. The winning amount came from
--
--      SELECT MAX(amount) FROM bids WHERE auction_id = ... AND amount >= 1;
--
--    with no is_complete filter, while the winner selection below it filtered
--    with t.is_complete = FALSE. When the top bid belonged to a team that had
--    already filled its roster the two disagreed: v_tie_count came out 0, the
--    tie branch found no eligible row, v_winning_team_id stayed NULL — and the
--    player was still marked
--
--      status = 'drafted', drafted_by_team_id = NULL, draft_price = <that bid>
--
--    so the player left the pool with no owner and the highest eligible bidder
--    never got them.
--
-- 3. The $1 auto-bid trigger may be missing. /api/admin/queue-auction relies on
--    trg_auto_bid_nominating_team to give the nominating team its automatic $1
--    bid (only /api/nominate inserts one in code). Without it, a nominated
--    player nobody bid on goes unsold instead of to the nominator at $1.
--
-- PRESERVED: the assign_roster_slot() call, which the live function already has.
-- NOT CHANGED: how the lottery sets ranks, or anything in the snake draft.

-- ── 1. Nomination turn rotation — moves a team to the bottom of priority_rank ──
CREATE OR REPLACE FUNCTION demote_nomination_rank(p_team_id UUID, p_league_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_max_rank INTEGER;
BEGIN
  SELECT MAX(priority_rank) INTO v_max_rank
  FROM teams WHERE league_id = p_league_id AND is_complete = FALSE AND priority_rank IS NOT NULL;

  INSERT INTO priority_log(league_id, team_id, old_rank, new_rank, reason)
  SELECT p_league_id, p_team_id, priority_rank, v_max_rank + 1, 'nomination_rotation'
  FROM teams WHERE id = p_team_id;

  UPDATE teams SET priority_rank = v_max_rank + 1, updated_at = NOW() WHERE id = p_team_id;
END;
$$;

-- ── 2. Tiebreak demotion — moves a team to the bottom of tiebreak_rank ────────
CREATE OR REPLACE FUNCTION demote_tiebreak_rank(p_team_id UUID, p_league_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_max_rank INTEGER;
BEGIN
  SELECT MAX(tiebreak_rank) INTO v_max_rank
  FROM teams WHERE league_id = p_league_id AND is_complete = FALSE AND tiebreak_rank IS NOT NULL;

  INSERT INTO priority_log(league_id, team_id, old_rank, new_rank, reason)
  SELECT p_league_id, p_team_id, tiebreak_rank, v_max_rank + 1, 'tiebreak_demotion'
  FROM teams WHERE id = p_team_id;

  UPDATE teams SET tiebreak_rank = v_max_rank + 1, updated_at = NOW() WHERE id = p_team_id;
END;
$$;

-- ── 3. demote_priority — kept as an alias so any stale caller rotates the
--       nomination turn instead of silently corrupting the tiebreak order ─────
CREATE OR REPLACE FUNCTION demote_priority(p_team_id UUID, p_league_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM demote_nomination_rank(p_team_id, p_league_id);
END;
$$;

-- ── 4. resolve_auction ───────────────────────────────────────────────────────
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

  -- Highest bid among teams still eligible to draft. Completed teams are
  -- excluded here exactly as in the winner selection below — the two filters
  -- must agree or the winner comes out NULL.
  SELECT MAX(b.amount) INTO v_max_bid
  FROM   bids b JOIN teams t ON t.id = b.team_id
  WHERE  b.auction_id = p_auction_id AND b.amount >= 1 AND t.is_complete = FALSE;

  IF v_max_bid IS NULL THEN
    -- No valid bids — player returns to the pool, nomination turn still rotates
    UPDATE auctions SET status = 'completed', updated_at = NOW() WHERE id = p_auction_id;
    UPDATE players  SET status = 'available'                         WHERE id = v_player_id;
    IF v_nominating_team_id IS NOT NULL THEN
      PERFORM demote_nomination_rank(v_nominating_team_id, v_league_id);
    END IF;
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_tie_count
  FROM bids b JOIN teams t ON t.id = b.team_id
  WHERE b.auction_id = p_auction_id AND b.amount = v_max_bid AND t.is_complete = FALSE;

  IF v_tie_count = 1 THEN
    SELECT b.team_id INTO v_winning_team_id
    FROM bids b JOIN teams t ON t.id = b.team_id
    WHERE b.auction_id = p_auction_id AND b.amount = v_max_bid AND t.is_complete = FALSE;
  ELSE
    -- Tie: team with the lowest tiebreak_rank (= highest priority) wins.
    -- tiebreak_rank ONLY — never fall back to priority_rank. The old version
    -- ordered by COALESCE(tiebreak_rank, priority_rank), which let a team's
    -- nomination position decide a tie whenever its tiebreak_rank was unset.
    -- The two orders must stay completely independent.
    v_tie_broken := TRUE;
    SELECT b.team_id INTO v_winning_team_id
    FROM bids b JOIN teams t ON t.id = b.team_id
    WHERE b.auction_id = p_auction_id AND b.amount = v_max_bid
      AND t.is_complete = FALSE
    ORDER BY t.tiebreak_rank ASC NULLS LAST
    LIMIT 1;
  END IF;

  -- Guard: never mark a player drafted without an owner. Unreachable now that
  -- v_max_bid only considers eligible teams, but this function has corrupted
  -- player rows once already.
  IF v_winning_team_id IS NULL THEN
    UPDATE auctions SET status = 'completed', updated_at = NOW() WHERE id = p_auction_id;
    UPDATE players  SET status = 'available'                         WHERE id = v_player_id;
    IF v_nominating_team_id IS NOT NULL THEN
      PERFORM demote_nomination_rank(v_nominating_team_id, v_league_id);
    END IF;
    RETURN;
  END IF;

  UPDATE players SET
    status             = 'drafted',
    drafted_by_team_id = v_winning_team_id,
    draft_price        = v_max_bid
  WHERE id = v_player_id;

  -- No-op for leagues with no roster_slots configured
  PERFORM assign_roster_slot(v_player_id, v_winning_team_id, v_league_id);

  UPDATE auctions SET
    status                 = 'completed',
    winning_team_id        = v_winning_team_id,
    winning_bid            = v_max_bid,
    tie_broken_by_priority = v_tie_broken,
    updated_at             = NOW()
  WHERE id = p_auction_id;

  PERFORM refresh_team_stats(v_winning_team_id);
  PERFORM remove_complete_team_from_priority(v_winning_team_id, v_league_id);

  -- Nomination rotation: the nominating team goes to the bottom of
  -- priority_rank, win or lose. This is the line that was demoting the wrong
  -- column. Tiebreak order is untouched here.
  IF v_nominating_team_id IS NOT NULL THEN
    PERFORM demote_nomination_rank(v_nominating_team_id, v_league_id);
    PERFORM remove_complete_team_from_priority(v_nominating_team_id, v_league_id);
  END IF;

  -- Tiebreak penalty: only a team that actually won on the tiebreak is demoted
  -- in tiebreak_rank. Nomination order is untouched here.
  IF v_tie_broken THEN
    IF EXISTS (
      SELECT 1 FROM teams
      WHERE id = v_winning_team_id AND tiebreak_rank IS NOT NULL AND is_complete = FALSE
    ) THEN
      PERFORM demote_tiebreak_rank(v_winning_team_id, v_league_id);
    END IF;
  END IF;
END;
$$;

-- ── 5. $1 auto-bid for the nominating team on auction insert ─────────────────
CREATE OR REPLACE FUNCTION auto_bid_nominating_team()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.nominating_team_id IS NOT NULL THEN
    INSERT INTO bids (auction_id, team_id, amount)
    VALUES (NEW.id, NEW.nominating_team_id, 1)
    ON CONFLICT (auction_id, team_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_bid_nominating_team ON auctions;
CREATE TRIGGER trg_auto_bid_nominating_team
  AFTER INSERT ON auctions
  FOR EACH ROW EXECUTE FUNCTION auto_bid_nominating_team();

-- ── Afterwards: check whether the old bug already orphaned any player ────────
-- Run this to look; it changes nothing.
--
--   SELECT p.id, p.name, p.draft_price, l.name AS league
--   FROM players p JOIN leagues l ON l.id = p.league_id
--   WHERE p.status = 'drafted' AND p.drafted_by_team_id IS NULL;
--
-- To return such a player to the pool so the admin can re-run the auction:
--
--   UPDATE players SET status = 'available', draft_price = NULL, roster_slot = NULL
--   WHERE status = 'drafted' AND drafted_by_team_id IS NULL;
