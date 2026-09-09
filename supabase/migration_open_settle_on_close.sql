-- ============================================================================
-- Open outcry: a closing auction re-settles the rest of the board
-- ============================================================================
--
-- open_settle_auction() decides who is out for good from two properties of a
-- team: is_complete, and open_team_hard_max_bid() (budget_remaining minus the
-- $1 reserved per empty slot). Winning an auction changes BOTH — refresh_team_stats()
-- in open_close_auction() spends the money and can fill the last roster slot —
-- and it changes them for every other auction on the board at the same instant.
--
-- Nothing re-ran that test. open_settle_auction() was called only from
-- open_nominate(), open_place_bid() and open_pass(), and always on the auction
-- being acted upon, so a team that finished its roster kept its seat in every
-- auction already open until someone happened to bid or pass on that specific
-- auction. Observed live in "לייב אוקשן רק דראפט" on 2026-09-06: Bobinass
-- completed at 12:40 (Israel) and was the only team left without a pass on the
-- Cedric Coward auction, which had last been touched at 12:03. It could not
-- bid — open_place_bid() rejects a team with no free slot — so the auction was
-- waiting on an answer that could never come, and would have closed on the
-- clock at 13:40 as `timeout` instead of immediately as `all_passed`. The
-- manager meanwhile saw a live bid box on the card, refusing him with
-- "אין תקציב", which is not the reason at all.
--
-- Auctions nominated AFTER the roster filled were never affected: open_nominate()
-- settles the auction it just created, so the `complete` pass is written on the
-- spot. Only auctions already open at the moment of completion were missed.
--
-- Two changes, both re-running the existing test — no new rule about who is out:
--   1. open_close_auction() settles every other open auction in the league.
--   2. open_draft_tick() settles the whole board once a minute, as a net.
--
-- Idempotent; safe to re-run. Folded into migration_open_auction_draft.sql.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. open_close_auction(): re-settle the rest of the board
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION open_close_auction(p_auction_id UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_league_id UUID; v_player_id UUID; v_leader UUID;
  v_price INTEGER; v_status TEXT;
  v_approved INTEGER; v_complete INTEGER;
  r RECORD;
BEGIN
  SELECT league_id, player_id, leader_team_id, current_price, status
  INTO v_league_id, v_player_id, v_leader, v_price, v_status
  FROM open_auctions WHERE id = p_auction_id FOR UPDATE;

  IF NOT FOUND OR v_status <> 'open' THEN RETURN; END IF;

  -- Cannot normally happen: the nominator's $1 auto-bid means there is always a
  -- leader. Kept as a guard so a player is never marked drafted with no owner —
  -- the exact failure resolve_auction() had to be fixed for.
  IF v_leader IS NULL THEN
    UPDATE open_auctions
    SET status = 'cancelled', closed_reason = p_reason, updated_at = NOW()
    WHERE id = p_auction_id;
    UPDATE players SET status = 'available' WHERE id = v_player_id;
    RETURN;
  END IF;

  UPDATE players SET
    status = 'drafted',
    drafted_by_team_id = v_leader,
    draft_price = v_price
  WHERE id = v_player_id;

  -- No-op for leagues with no roster_slots configured.
  PERFORM assign_roster_slot(v_player_id, v_leader, v_league_id);

  UPDATE open_auctions SET
    status = 'completed',
    winning_team_id = v_leader,
    winning_bid = v_price,
    closed_reason = p_reason,
    updated_at = NOW()
  WHERE id = p_auction_id;

  PERFORM refresh_team_stats(v_leader);

  -- No nomination demotion here: the turn already rotated when the player went
  -- up (see open_nominate). And no tiebreak demotion — an open auction cannot
  -- tie, so tiebreak_rank is not part of this format at all.

  -- The win just changed the winner's roster and budget, which are exactly the
  -- two inputs to the auto-PASS test — on every other auction on the board, not
  -- just this one. Re-run it there. Recursion terminates: this row is already
  -- `completed`, so a sibling that closes and settles back finds nothing to do,
  -- and each level closes a different auction out of at most open_board_size.
  --
  -- SKIP LOCKED, not a plain FOR UPDATE: a locked sibling row means another
  -- transaction is mid-bid or mid-pass on it and will settle it itself, and
  -- waiting would invite a deadlock — that transaction may be closing an
  -- auction and waiting on the row this one already holds. Anything skipped is
  -- caught by the next open_draft_tick(), one minute later at worst.
  FOR r IN
    SELECT id FROM open_auctions
    WHERE league_id = v_league_id AND status = 'open' AND id <> p_auction_id
    ORDER BY id
    FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM open_settle_auction(r.id);
  END LOOP;

  -- Counted after that sweep: settling siblings can close them, which can fill
  -- another roster, which can be the win that ends the draft.
  SELECT COUNT(*) FILTER (WHERE approved),
         COUNT(*) FILTER (WHERE approved AND is_complete)
  INTO v_approved, v_complete
  FROM teams WHERE league_id = v_league_id;

  IF v_approved > 0 AND v_complete >= v_approved THEN
    UPDATE leagues SET status = 'completed', updated_at = NOW()
    WHERE id = v_league_id AND status <> 'completed';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. open_draft_tick(): settle the whole board every minute
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION open_draft_tick(p_league_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_league RECORD; v_running BOOLEAN; v_freeze_at TIMESTAMPTZ;
  v_gap INTERVAL; r RECORD;
BEGIN
  SELECT id, status, draft_type, draft_start_hour, draft_end_hour, open_frozen_since
  INTO v_league FROM leagues WHERE id = p_league_id FOR UPDATE;

  IF NOT FOUND OR v_league.draft_type <> 'open' THEN RETURN; END IF;

  -- A league that has not started (or has finished) has no clock to freeze, and
  -- must not be carrying a stamp: this function is called on every page load, so
  -- a league sitting in `setup` for days would otherwise accumulate a huge gap
  -- and shift the very first auction's deadline forward by all of it the moment
  -- the draft went active.
  IF v_league.status NOT IN ('active', 'paused') THEN
    IF v_league.open_frozen_since IS NOT NULL THEN
      UPDATE leagues SET open_frozen_since = NULL WHERE id = p_league_id;
    END IF;
    RETURN;
  END IF;

  v_running := v_league.status = 'active'
    AND open_within_hours(v_league.draft_start_hour, v_league.draft_end_hour, NOW());

  IF NOT v_running THEN
    IF v_league.open_frozen_since IS NULL THEN
      -- Night: stamp the boundary itself. Pause: open_set_pause already stamped,
      -- so this branch only catches a status change made some other way.
      IF v_league.status = 'active' THEN
        v_freeze_at := open_last_hours_boundary(v_league.draft_end_hour, NOW());
      ELSE
        v_freeze_at := NOW();
      END IF;
      UPDATE leagues SET open_frozen_since = v_freeze_at WHERE id = p_league_id;
    END IF;
    RETURN;
  END IF;

  IF v_league.open_frozen_since IS NOT NULL THEN
    v_gap := NOW() - v_league.open_frozen_since;
    UPDATE open_auctions
    SET deadline_at = deadline_at + v_gap, updated_at = NOW()
    WHERE league_id = p_league_id AND status = 'open';
    UPDATE leagues SET open_frozen_since = NULL WHERE id = p_league_id;
  END IF;

  -- The net under open_close_auction()'s sweep. Whatever that had to skip
  -- because another transaction held the row is settled here instead, so the
  -- board can never sit waiting on a team that is out for good for longer than
  -- a minute. Runs before the deadline loop so such an auction closes as
  -- `all_passed` — the true reason — rather than on the clock.
  --
  -- SKIP LOCKED for the same reason as above: a row held right now belongs to a
  -- bid or pass that settles it on its own, and this job must never block on it.
  FOR r IN
    SELECT id FROM open_auctions
    WHERE league_id = p_league_id AND status = 'open'
    ORDER BY id
    FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM open_settle_auction(r.id);
  END LOOP;

  FOR r IN
    SELECT id, leader_team_id FROM open_auctions
    WHERE league_id = p_league_id AND status = 'open' AND deadline_at <= NOW()
  LOOP
    -- Whoever has not answered by the deadline is out. Recorded rather than
    -- implied, so the closed auction still shows who passed and why.
    INSERT INTO open_passes (open_auction_id, team_id, reason)
    SELECT r.id, t.id, 'timeout'
    FROM teams t
    WHERE t.league_id = p_league_id
      AND t.approved
      AND (r.leader_team_id IS NULL OR t.id <> r.leader_team_id)
    ON CONFLICT (open_auction_id, team_id) DO NOTHING;

    PERFORM open_close_auction(r.id, 'timeout');
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Grants
-- ---------------------------------------------------------------------------
-- CREATE OR REPLACE keeps the existing ACL, so these are only insurance for a
-- database where the function did not exist yet: Supabase ships an
-- ALTER DEFAULT PRIVILEGES that grants EXECUTE on every new public function to
-- anon and authenticated, and revoking PUBLIC alone does not undo it.

REVOKE ALL ON FUNCTION open_close_auction(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION open_draft_tick(UUID)          FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION open_close_auction(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION open_draft_tick(UUID)          TO service_role;

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
-- Both bodies should contain the sweep:
--   SELECT proname FROM pg_proc
--   WHERE proname IN ('open_close_auction', 'open_draft_tick')
--     AND prosrc LIKE '%FOR UPDATE SKIP LOCKED%';
--
-- And no open auction should be waiting on a team that is out for good:
--   SELECT a.id, t.name, t.is_complete
--   FROM open_auctions a
--   JOIN teams t ON t.league_id = a.league_id AND t.approved
--   WHERE a.status = 'open'
--     AND t.id <> a.leader_team_id
--     AND t.is_complete
--     AND NOT EXISTS (SELECT 1 FROM open_passes p
--                     WHERE p.open_auction_id = a.id AND p.team_id = t.id);
