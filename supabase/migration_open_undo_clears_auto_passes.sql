-- Follow-up to migration_open_auction_undo.sql — undo must also put the team
-- back into the auctions it was automatically passed out of.
--
-- Touches ONLY open_undo_auction(). Nothing else, envelope or snake.
--
-- THE BUG
-- -------
-- open_settle_auction() writes a pass row for any non-leader that is
-- `is_complete` (reason 'complete') or whose open_team_hard_max_bid() cannot
-- reach the price (reason 'no_budget'). Both are *derived* from the team's
-- roster and budget at that instant.
--
-- Undoing a closed auction reverses exactly those two inputs: the winner gets a
-- roster slot and its money back. But the pass rows written while it was full
-- or broke stayed, and PASS is final — open_place_bid() refuses with
-- "הקבוצה כבר סימנה PASS במכרז הזה — אין חזרה". So a team whose last win the
-- admin undid was refunded, un-completed, and still permanently locked out of
-- every other auction on the board. Nothing surfaced it, and the only remedy
-- was to cancel those auctions too and re-nominate.
--
-- THE FIX
-- -------
-- After the refund, drop that team's 'complete' / 'no_budget' rows in auctions
-- that are still open and re-settle each. Deleting a pass can only ADD a team
-- to an auction, so nothing can close that would not have closed already — and
-- if the team still cannot reach the price, open_settle_auction() writes the
-- row straight back. It is a re-derivation, not a blanket amnesty.
--
-- 'manual', 'admin' and 'timeout' are deliberately NOT cleared: a manager who
-- chose to walk away, an admin who passed for them, and a clock that ran out
-- are decisions, not derivations. PASS stays final for those.
--
-- Idempotent; safe to re-run.

CREATE OR REPLACE FUNCTION open_undo_auction(p_auction_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_league_id UUID; v_player_id UUID; v_winner UUID; v_status TEXT;
  v_holder UUID; r RECORD;
  v_approved INTEGER; v_complete INTEGER;
BEGIN
  SELECT league_id, player_id, winning_team_id, status
  INTO v_league_id, v_player_id, v_winner, v_status
  FROM open_auctions WHERE id = p_auction_id FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'המכרז לא נמצא'; END IF;
  IF v_status = 'cancelled' THEN RAISE EXCEPTION 'המכרז כבר בוטל'; END IF;
  IF v_status <> 'completed' THEN
    RAISE EXCEPTION 'המכרז עדיין פתוח — השתמש בביטול מכרז פתוח';
  END IF;

  -- Who actually holds the player now. Normally the winner; read separately so
  -- a row that drifted still has both teams' budgets recomputed.
  SELECT drafted_by_team_id INTO v_holder FROM players WHERE id = v_player_id;

  UPDATE players SET
    status = 'available',
    drafted_by_team_id = NULL,
    draft_price = NULL,
    roster_slot = NULL
  WHERE id = v_player_id;

  DELETE FROM open_bids   WHERE open_auction_id = p_auction_id;
  DELETE FROM open_passes WHERE open_auction_id = p_auction_id;

  UPDATE open_auctions SET
    status = 'cancelled',
    closed_reason = 'cancelled',
    leader_team_id = NULL,
    winning_team_id = NULL,
    winning_bid = NULL,
    updated_at = NOW()
  WHERE id = p_auction_id;

  IF v_winner IS NOT NULL THEN PERFORM refresh_team_stats(v_winner); END IF;
  IF v_holder IS NOT NULL AND v_holder IS DISTINCT FROM v_winner THEN
    PERFORM refresh_team_stats(v_holder);
  END IF;

  -- Put the refunded team back into the auctions it was passed out of only
  -- because of the roster slot and the money this undo just returned. Must run
  -- AFTER refresh_team_stats, which is what makes the re-derivation below read
  -- the restored state. IN (a, b) with a NULL b simply matches nothing extra.
  FOR r IN
    SELECT DISTINCT p.open_auction_id AS id
    FROM open_passes p
    JOIN open_auctions a ON a.id = p.open_auction_id
    WHERE p.team_id IN (v_winner, v_holder)
      AND p.reason IN ('complete', 'no_budget')
      AND a.status = 'open'
      AND a.league_id = v_league_id
  LOOP
    DELETE FROM open_passes
    WHERE open_auction_id = r.id
      AND team_id IN (v_winner, v_holder)
      AND reason IN ('complete', 'no_budget');

    -- Bump for realtime, then let settle write the row back if the team still
    -- cannot reach the price.
    UPDATE open_auctions SET updated_at = NOW() WHERE id = r.id;
    PERFORM open_settle_auction(r.id);
  END LOOP;

  -- The nomination turn is NOT given back: demote_nomination_rank() runs at
  -- nomination time in this format, so every other team has since moved up
  -- around the nominator and its old rank now belongs to someone else.

  -- open_close_auction() may have marked the league finished on this very
  -- auction. A roster just got a slot back, so undo that too.
  SELECT COUNT(*) FILTER (WHERE approved),
         COUNT(*) FILTER (WHERE approved AND is_complete)
  INTO v_approved, v_complete
  FROM teams WHERE league_id = v_league_id;

  IF v_complete < v_approved THEN
    UPDATE leagues SET status = 'active', updated_at = NOW()
    WHERE id = v_league_id AND status = 'completed';
  END IF;
END;
$$;

-- Signature is unchanged, so the existing grant still stands; re-stated because
-- CREATE OR REPLACE keeps privileges and a fresh install runs this file alone.
REVOKE ALL ON FUNCTION open_undo_auction(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION open_undo_auction(UUID) TO service_role;
