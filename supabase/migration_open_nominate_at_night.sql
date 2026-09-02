-- ============================================================================
-- Open outcry: nominating through the night too
-- ============================================================================
-- migration_open_night_actions.sql opened bidding and PASS outside the league's
-- active hours and deliberately left `open_nominate()` on `open_is_running()`,
-- so new players still went up only during the day. This finishes the job: the
-- whole draft now runs on `open_accepts_actions()` and only an admin PAUSE stops
-- anything. The active hours are purely a clock rule.
--
-- Two changes, and the second is the one that matters:
--
--   1. The gate. `open_is_running()` -> `open_accepts_actions()`.
--   2. The opening window. A newly nominated player gets
--      `open_pass_timeout_minutes` measured from `open_clock_now()`, not NOW().
--      Nominate at 02:00 with a 120-minute window and a wall-clock deadline
--      would be `04:00` — an instant the clock never reaches, because it is
--      stopped. The morning thaw shifts every open deadline forward by the
--      whole gap, so that auction would open at 08:00 with far more than two
--      hours on it, scaled by how deep into the night it was created. Measured
--      in frozen time it is `frozen_since + 120min`, which the same shift turns
--      into exactly `08:00 + 120min` — the window the nominator was promised,
--      starting when the draft does.
--
-- `open_is_running()` is left in place: nothing calls it any more, but older
-- function bodies in migration files here still do, and dropping it would make
-- re-running one of those fail rather than merely revert behaviour.
--
-- Idempotent. Also folded into migration_open_auction_draft.sql.

CREATE OR REPLACE FUNCTION open_nominate(
  p_league_id UUID,
  p_player_id UUID,
  p_team_id UUID,
  p_opening_bid INTEGER DEFAULT 1
)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_league RECORD; v_open INTEGER; v_rank INTEGER;
  v_eligible_ahead INTEGER; v_auction_id UUID; v_player_status TEXT;
  v_max INTEGER;
BEGIN
  SELECT * INTO v_league FROM leagues WHERE id = p_league_id FOR UPDATE;
  IF NOT FOUND OR v_league.draft_type <> 'open' THEN
    RAISE EXCEPTION 'הליגה אינה דראפט מכרז פתוח';
  END IF;
  -- Night stops the clock, not the draft. Only a pause stops this.
  IF NOT open_accepts_actions(p_league_id) THEN
    RAISE EXCEPTION 'הדראפט מושהה כרגע — אי-אפשר להעלות שחקן';
  END IF;

  IF p_opening_bid IS NULL OR p_opening_bid < 1 THEN
    RAISE EXCEPTION 'הצעת הפתיחה חייבת להיות לפחות $1';
  END IF;

  SELECT COUNT(*) INTO v_open
  FROM open_auctions WHERE league_id = p_league_id AND status = 'open';
  IF v_open >= v_league.open_board_size THEN
    RAISE EXCEPTION 'הלוח מלא — כבר יש % שחקנים במכרז', v_league.open_board_size;
  END IF;

  SELECT status INTO v_player_status
  FROM players WHERE id = p_player_id AND league_id = p_league_id;
  IF v_player_status IS NULL THEN RAISE EXCEPTION 'השחקן לא נמצא בליגה'; END IF;
  IF v_player_status <> 'available' THEN RAISE EXCEPTION 'השחקן אינו זמין'; END IF;

  SELECT priority_rank INTO v_rank
  FROM teams WHERE id = p_team_id AND league_id = p_league_id AND approved;
  IF v_rank IS NULL THEN RAISE EXCEPTION 'הקבוצה אינה בסדר ההעלאות של הליגה'; END IF;

  -- Two separate gates, and they answer different questions. The first is
  -- eligibility — may this team take a turn at all — and stays keyed to $1
  -- so it matches canNominateNow in getOpenNominationOrder() exactly. The
  -- second is about the number that was actually typed.
  v_max := open_team_max_bid(p_team_id);
  IF v_max < 1 THEN
    RAISE EXCEPTION 'לקבוצה אין תקציב או משבצת פנויה להעלאת שחקן';
  END IF;
  IF p_opening_bid > v_max THEN
    RAISE EXCEPTION 'הצעת הפתיחה חורגת מהתקציב הפנוי של הקבוצה — מקסימום $%', v_max;
  END IF;

  -- Turn check. With K = board_size − open auctions, the first K eligible teams
  -- in priority_rank order may nominate right now. A team that already put a
  -- player up was demoted to the bottom on the spot, so it is not in that set.
  SELECT COUNT(*) INTO v_eligible_ahead
  FROM teams t
  WHERE t.league_id = p_league_id
    AND t.approved
    AND t.priority_rank IS NOT NULL
    AND t.priority_rank < v_rank
    AND NOT t.is_complete
    AND open_team_max_bid(t.id) >= 1;

  IF v_eligible_ahead > (v_league.open_board_size - v_open - 1) THEN
    RAISE EXCEPTION 'עדיין לא תורה של הקבוצה להעלות שחקן';
  END IF;

  -- The opening window runs on the draft's clock, not the wall's — see the
  -- header. During the day the two are the same instant.
  INSERT INTO open_auctions
    (league_id, player_id, nominating_team_id, current_price, leader_team_id, deadline_at)
  VALUES
    (p_league_id, p_player_id, p_team_id, p_opening_bid, p_team_id,
     open_clock_now(p_league_id) + make_interval(mins => v_league.open_pass_timeout_minutes))
  RETURNING id INTO v_auction_id;

  -- is_auto stays TRUE whatever the amount: it marks the bid that came with the
  -- nomination rather than one placed against a standing price, and the board
  -- renders it as "הצעת פתיחה" — which is what this is at any number.
  INSERT INTO open_bids (open_auction_id, team_id, amount, is_auto)
  VALUES (v_auction_id, p_team_id, p_opening_bid, TRUE);

  UPDATE players SET status = 'on_auction' WHERE id = p_player_id;

  -- The turn rotates the moment a player goes up, not when the auction closes:
  -- several auctions run at once and finish out of order, so rotating on close
  -- would make the order depend on which one happened to end first.
  PERFORM demote_nomination_rank(p_team_id, p_league_id);

  -- A high opening bid can auto-PASS teams that cannot reach opening + 1, which
  -- is the point: it is exactly what a bid at that price would have done.
  PERFORM open_settle_auction(v_auction_id);
  RETURN v_auction_id;
END;
$$;

-- ----------------------------------------------------------------------------
-- Grants
-- ----------------------------------------------------------------------------
-- CREATE OR REPLACE preserves the existing ACL, so this is already locked down
-- where the base migration ran. Re-run anyway: Supabase's ALTER DEFAULT
-- PRIVILEGES grants EXECUTE on every NEW function in `public` directly to anon
-- and authenticated, so any path that creates it fresh would leave a SECURITY
-- DEFINER nominate callable from the browser with nothing but an anon key.
REVOKE ALL ON FUNCTION open_nominate(UUID, UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION open_nominate(UUID, UUID, UUID, INTEGER) TO service_role;
