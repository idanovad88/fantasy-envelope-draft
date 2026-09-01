-- Follow-up to migration_open_auction_draft.sql — undo a CLOSED open auction.
--
-- Touches ONLY the open-outcry path: it adds one function, `open_undo_auction`,
-- and revokes EXECUTE on it. It creates no table, alters no column, and does
-- not touch `auctions`, `bids`, `resolve_auction` or anything snake-related.
--
-- WHY
-- ---
-- `open_cancel_auction()` pulls a player back off the board, but refuses
-- anything that is not still `open` — so a mistaken close (admin hit "סגור
-- עכשיו" too early, the deadline ran out on a bid that should not have counted,
-- a wrong player was nominated) was permanent: the player stayed drafted and
-- the winner stayed charged, with no way back short of resetting the draft.
--
-- This reverses a completed auction: the player returns to the pool, the money
-- returns to the winner, and the auction row is kept as `cancelled` so history
-- still shows the player was up and the result was withdrawn. The admin can
-- then re-nominate.
--
-- The refund is not arithmetic on `budget_remaining` — it is
-- `refresh_team_stats()`, which recomputes budget and player_count from the
-- team's drafted players. Clearing the player's `drafted_by_team_id` and
-- `draft_price` first is therefore the whole refund, and it cannot drift out of
-- sync with a hand-written `+ price`.
--
-- Idempotent (CREATE OR REPLACE); safe to re-run.

CREATE OR REPLACE FUNCTION open_undo_auction(p_auction_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_league_id UUID; v_player_id UUID; v_winner UUID; v_status TEXT;
  v_holder UUID;
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
  -- a row that drifted (a manual fix, a future transfer path) still has both
  -- teams' budgets recomputed rather than only the one on the auction row.
  SELECT drafted_by_team_id INTO v_holder FROM players WHERE id = v_player_id;

  UPDATE players SET
    status = 'available',
    drafted_by_team_id = NULL,
    draft_price = NULL,
    roster_slot = NULL
  WHERE id = v_player_id;

  -- The bids and passes belonged to a result that no longer stands. Dropping
  -- them matches open_cancel_auction() and leaves no ledger pointing at an
  -- auction with no leader; the auction row itself is kept for history.
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

  -- The nomination turn is NOT given back. demote_nomination_rank() runs at
  -- nomination time in this format, not at close, so by now every other team
  -- has moved up around it; re-inserting the nominator at its old rank would
  -- collide with whoever holds that rank today. Same as open_cancel_auction().

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

-- SECURITY DEFINER, so EXECUTE must be revoked from anon/authenticated BY NAME —
-- Supabase grants both a direct EXECUTE on every new function in the public
-- schema, which a REVOKE FROM PUBLIC does not remove. Without this, anyone with
-- the anon key could refund and un-draft any player in any league.
REVOKE ALL ON FUNCTION open_undo_auction(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION open_undo_auction(UUID) TO service_role;

-- Verify (changes nothing) — this row should show only postgres/service_role:
--   SELECT p.proname, array_to_string(p.proacl, ', ') AS grants
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.proname = 'open_undo_auction';
