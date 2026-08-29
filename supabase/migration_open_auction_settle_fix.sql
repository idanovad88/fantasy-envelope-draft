-- Follow-up to migration_open_auction_draft.sql — auto-PASS only the teams that
-- are actually finished, never the ones merely committed elsewhere.
--
-- Touches ONLY open-outcry objects. Nothing here references `auctions`, `bids`,
-- `resolve_auction`, or any envelope/snake object. Idempotent.
--
-- WHY
-- ---
-- open_settle_auction() wrote a permanent PASS for any team that could not
-- reach current_price + 1 *at that instant*, and the ceiling it used
-- (open_team_max_bid) subtracts money tied up in other auctions the team is
-- currently leading. That made a rival's temporary commitment into a permanent
-- elimination, and it was timeable:
--
--   A rival leads an expensive auction elsewhere, so their money is committed.
--   You jump the price here. They are auto-passed for good — even though the
--   moment someone outbids them over there, the money frees up. If they were
--   the last team in, the auction closes to you instantly, with no timer and
--   no chance for anyone to respond.
--
-- `roster_full` had the same flaw: open_team_open_slots() counts a slot that is
-- merely committed to an open auction as taken.
--
-- The fix: only a team that is out for good is passed automatically —
--   * roster is full (is_complete), or
--   * it cannot afford the price even if every auction it leads were lost.
-- A team blocked only by its own commitments stays in the auction. It cannot
-- bid right now, and the auction simply runs to its deadline unless it acts or
-- passes by hand. Termination is unaffected: open_draft_tick() still closes an
-- expired auction with `timeout` passes, which is exactly what the timer is for.

-- ── 1. The ceiling ignoring current commitments ─────────────────────────────
-- "Out of money for good" = cannot reach the price even with everything
-- released. Same formula as getMaxBid() in lib/utils.ts, minus the deduction
-- for leading bids that open_team_max_bid() applies.
CREATE OR REPLACE FUNCTION open_team_hard_max_bid(p_team_id UUID)
RETURNS INTEGER LANGUAGE plpgsql STABLE AS $$
DECLARE v_budget INTEGER; v_count INTEGER; v_per_team INTEGER; v_slots INTEGER;
BEGIN
  SELECT t.budget_remaining, t.player_count, l.players_per_team
  INTO v_budget, v_count, v_per_team
  FROM teams t JOIN leagues l ON l.id = t.league_id
  WHERE t.id = p_team_id;

  IF v_per_team IS NULL THEN RETURN 0; END IF;

  -- Real roster slots. Unlike open_team_open_slots() this does NOT subtract
  -- auctions the team is leading — losing them frees the slot again.
  v_slots := v_per_team - v_count;
  IF v_slots <= 0 THEN RETURN 0; END IF;

  RETURN v_budget - (v_slots - 1);
END;
$$;

-- ── 2. Settle: permanent blocks only ────────────────────────────────────────
CREATE OR REPLACE FUNCTION open_settle_auction(p_auction_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_league_id UUID; v_status TEXT; v_leader UUID; v_price INTEGER;
  v_remaining INTEGER;
BEGIN
  SELECT league_id, status, leader_team_id, current_price
  INTO v_league_id, v_status, v_leader, v_price
  FROM open_auctions WHERE id = p_auction_id;

  IF NOT FOUND OR v_status <> 'open' THEN RETURN; END IF;

  -- Auto-PASS only teams that can never come back to this auction. A team held
  -- up by its own leading bids is left alone: it cannot bid at this moment, but
  -- being outbid elsewhere puts it straight back in.
  --
  -- 'roster_full' is deliberately not produced any more — a team that is not
  -- is_complete always has a real slot free, and a merely committed slot is a
  -- temporary state. The value stays in the CHECK for rows written before this.
  INSERT INTO open_passes (open_auction_id, team_id, reason)
  SELECT p_auction_id, t.id,
         CASE WHEN t.is_complete THEN 'complete' ELSE 'no_budget' END
  FROM teams t
  WHERE t.league_id = v_league_id
    AND t.approved
    AND (v_leader IS NULL OR t.id <> v_leader)
    AND (t.is_complete OR open_team_hard_max_bid(t.id) < v_price + 1)
  ON CONFLICT (open_auction_id, team_id) DO NOTHING;

  SELECT COUNT(*) INTO v_remaining
  FROM teams t
  WHERE t.league_id = v_league_id
    AND t.approved
    AND (v_leader IS NULL OR t.id <> v_leader)
    AND NOT EXISTS (
      SELECT 1 FROM open_passes p
      WHERE p.open_auction_id = p_auction_id AND p.team_id = t.id
    );

  IF v_remaining = 0 THEN
    PERFORM open_close_auction(p_auction_id, 'all_passed');
  END IF;
END;
$$;

-- ── 3. Grants ───────────────────────────────────────────────────────────────
-- CREATE OR REPLACE keeps the existing ACL, but this project has already been
-- bitten once by assuming a revoke stuck, so re-assert it. See
-- migration_open_auction_grants_fix.sql for why anon/authenticated must be
-- named explicitly rather than relying on PUBLIC.
REVOKE ALL ON FUNCTION open_settle_auction(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION open_settle_auction(UUID) TO service_role;

-- open_team_hard_max_bid stays publicly callable like the other read-only
-- helpers: it reads nothing that is not already public through the SELECT
-- policies on teams and leagues.

-- Verify (changes nothing):
--   SELECT proname FROM pg_proc WHERE proname = 'open_team_hard_max_bid';
--   SELECT prosrc FROM pg_proc WHERE proname = 'open_settle_auction';
