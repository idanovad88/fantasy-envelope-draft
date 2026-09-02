-- ============================================================================
-- Open outcry: bidding and PASS through the night, with the clocks still frozen
-- ============================================================================
-- Until now `open_place_bid()` and `open_pass()` both refused outside the
-- league's active hours, so a draft went completely dark every night. The clock
-- stopping is the point of those hours; nothing about them requires the managers
-- to stop. After this migration:
--
--   * A bid or a PASS is accepted whenever the league is `active`, night or day.
--     Only an admin PAUSE stops them.
--   * The clocks still do not run at night. A deadline written during a freeze
--     is expressed in frozen time, so the morning thaw turns it into exactly the
--     window the bidder earned.
--   * An auction may therefore close at night, when every team but the leader
--     has passed. That is a decision the managers made, not a clock running.
--
-- Nomination is deliberately NOT included: `open_nominate()` keeps its
-- `open_is_running()` gate, so new players still go up only during the day.
--
-- Idempotent. Also folded into migration_open_auction_draft.sql.

-- ----------------------------------------------------------------------------
-- Who may act, and when
-- ----------------------------------------------------------------------------
-- `open_is_running()` answers "is the clock running", which is now a different
-- question from "may a manager act". Both are kept: nomination still uses the
-- first, bids and passes use this one.
CREATE OR REPLACE FUNCTION open_accepts_actions(p_league_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
DECLARE v_status TEXT;
BEGIN
  SELECT status INTO v_status FROM leagues WHERE id = p_league_id;
  RETURN v_status = 'active';
END;
$$;

-- "Now" on the draft's own clock.
--
-- The tick stamps `leagues.open_frozen_since` when the active-hours window
-- closes and, in the morning, shifts every open deadline forward by the gap. A
-- deadline written during a freeze must therefore be expressed in frozen time:
-- `frozen_since + W` becomes `morning + W` once that shift lands, which is
-- precisely "the clock did not run while you were asleep".
--
-- The order of the branches matters, and the stamp comes first. A stamp still
-- set while the league is inside its hours means the thaw has not been applied
-- yet (the tick runs once a minute), so the deadlines it is about to shift are
-- still the pre-freeze ones and the stamp is the right base then too. Only with
-- no stamp does the window decide — and outside it the boundary is used rather
-- than NOW(), which is exactly what the tick would have stamped had it already
-- run. Without that branch a bid in the first minute of the night would quietly
-- be granted the length of that minute twice.
CREATE OR REPLACE FUNCTION open_clock_now(p_league_id UUID)
RETURNS TIMESTAMPTZ LANGUAGE plpgsql STABLE AS $$
DECLARE v RECORD;
BEGIN
  SELECT status, draft_start_hour, draft_end_hour, open_frozen_since
  INTO v FROM leagues WHERE id = p_league_id;

  IF NOT FOUND THEN RETURN NOW(); END IF;
  IF v.open_frozen_since IS NOT NULL THEN RETURN v.open_frozen_since; END IF;

  IF v.status = 'active'
     AND NOT open_within_hours(v.draft_start_hour, v.draft_end_hour, NOW()) THEN
    RETURN open_last_hours_boundary(v.draft_end_hour, NOW());
  END IF;

  RETURN NOW();
END;
$$;

-- ----------------------------------------------------------------------------
-- Bidding
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION open_place_bid(p_auction_id UUID, p_team_id UUID, p_amount INTEGER)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_a RECORD; v_max INTEGER;
  v_short INTEGER; v_long INTEGER;
  v_now TIMESTAMPTZ; v_remaining INTERVAL; v_deadline TIMESTAMPTZ;
BEGIN
  -- Row lock: two teams raising the same auction at the same instant must not
  -- both read the same current_price.
  SELECT * INTO v_a FROM open_auctions WHERE id = p_auction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'המכרז לא נמצא'; END IF;
  IF v_a.status <> 'open' THEN RAISE EXCEPTION 'המכרז כבר נסגר'; END IF;

  -- Night is not a reason to refuse a bid — the clock stops, the draft does
  -- not. A pause stops both.
  IF NOT open_accepts_actions(v_a.league_id) THEN
    RAISE EXCEPTION 'הדראפט מושהה כרגע — אי-אפשר להציע';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM teams
    WHERE id = p_team_id AND league_id = v_a.league_id AND approved
  ) THEN
    RAISE EXCEPTION 'הקבוצה אינה בליגה';
  END IF;

  IF v_a.leader_team_id = p_team_id THEN
    RAISE EXCEPTION 'הקבוצה כבר מובילה במכרז הזה';
  END IF;

  IF EXISTS (
    SELECT 1 FROM open_passes
    WHERE open_auction_id = p_auction_id AND team_id = p_team_id
  ) THEN
    RAISE EXCEPTION 'הקבוצה כבר סימנה PASS במכרז הזה — אין חזרה';
  END IF;

  IF p_amount < v_a.current_price + 1 THEN
    RAISE EXCEPTION 'ההצעה חייבת להיות לפחות $%', v_a.current_price + 1;
  END IF;

  v_max := open_team_max_bid(p_team_id);
  IF p_amount > v_max THEN
    RAISE EXCEPTION 'ההצעה חורגת מהתקציב הפנוי של הקבוצה — מקסימום $%', GREATEST(v_max, 0);
  END IF;

  SELECT open_extend_short_minutes, open_extend_long_minutes
  INTO v_short, v_long
  FROM leagues WHERE id = v_a.league_id;

  -- Graduated soft close: the deadline moves to now + the smallest configured
  -- window LARGER than the time remaining, and stands when neither qualifies.
  -- With 30/60: 90 minutes left is untouched, 50 left goes back up to an hour,
  -- 10 left gains 20 minutes for half an hour to respond. It can never move
  -- earlier — only a window greater than the remaining time is ever chosen.
  --
  -- "Now" here is open_clock_now(), not NOW(). During a freeze the two differ,
  -- and the wall clock would be wrong twice over: the remaining time would read
  -- as shrinking through the night (so every night bid would take the short
  -- window, and a long-running auction would look nearly expired), and the
  -- morning shift would then add the whole night on top of the window just
  -- granted.
  --
  -- open_pass_timeout_minutes is NOT used here; that is the opening window a
  -- newly nominated player gets, set in open_nominate().
  v_now := open_clock_now(v_a.league_id);
  v_remaining := v_a.deadline_at - v_now;
  v_deadline := CASE
    WHEN v_remaining < make_interval(mins => v_short) THEN v_now + make_interval(mins => v_short)
    WHEN v_remaining < make_interval(mins => v_long)  THEN v_now + make_interval(mins => v_long)
    ELSE v_a.deadline_at
  END;

  INSERT INTO open_bids (open_auction_id, team_id, amount)
  VALUES (p_auction_id, p_team_id, p_amount);

  -- updated_at stays on the wall clock: it drives the realtime subscription,
  -- not the auction's deadline.
  UPDATE open_auctions SET
    current_price  = p_amount,
    leader_team_id = p_team_id,
    deadline_at    = v_deadline,
    updated_at     = NOW()
  WHERE id = p_auction_id;

  -- The team that was just outbid has no pass row, so it is back in and must
  -- either raise again or pass. That is the whole loop.
  PERFORM open_settle_auction(p_auction_id);
END;
$$;

-- ----------------------------------------------------------------------------
-- Passing
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION open_pass(p_auction_id UUID, p_team_id UUID, p_reason TEXT DEFAULT 'manual')
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_a RECORD;
BEGIN
  SELECT * INTO v_a FROM open_auctions WHERE id = p_auction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'המכרז לא נמצא'; END IF;
  IF v_a.status <> 'open' THEN RAISE EXCEPTION 'המכרז כבר נסגר'; END IF;

  -- A manager may drop out at any hour; only a pause stops it. Automatic
  -- reasons (timeout / no_budget) are written by the clock, which runs
  -- precisely when the league is not, and are never gated.
  --
  -- This is what lets an auction close at night: once the last non-leader
  -- passes, open_settle_auction() closes it. Nobody was cut off by a timer —
  -- every team still in it chose to leave.
  IF p_reason IN ('manual', 'admin') AND NOT open_accepts_actions(v_a.league_id) THEN
    RAISE EXCEPTION 'הדראפט מושהה כרגע — אי-אפשר לסמן PASS';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM teams
    WHERE id = p_team_id AND league_id = v_a.league_id AND approved
  ) THEN
    RAISE EXCEPTION 'הקבוצה אינה בליגה';
  END IF;

  -- Putting a player up is what buys the right to take him for a dollar. A
  -- leader stepping away could leave the auction with nobody in it at all.
  IF v_a.leader_team_id = p_team_id THEN
    RAISE EXCEPTION 'אי-אפשר לסמן PASS כשאתה ההצעה הגבוהה ביותר';
  END IF;

  IF EXISTS (
    SELECT 1 FROM open_passes
    WHERE open_auction_id = p_auction_id AND team_id = p_team_id
  ) THEN
    RAISE EXCEPTION 'הקבוצה כבר סימנה PASS במכרז הזה';
  END IF;

  INSERT INTO open_passes (open_auction_id, team_id, reason)
  VALUES (p_auction_id, p_team_id, p_reason);

  -- Touch the parent so realtime sees it. `open_passes` has no league_id and so
  -- cannot be filtered per league in a subscription; bumping the auction means
  -- one filtered subscription on open_auctions covers bids, passes and closes.
  UPDATE open_auctions SET updated_at = NOW() WHERE id = p_auction_id;

  PERFORM open_settle_auction(p_auction_id);
END;
$$;

-- ----------------------------------------------------------------------------
-- Grants
-- ----------------------------------------------------------------------------
-- CREATE OR REPLACE preserves an existing function's ACL, so these two are
-- already locked down on a database where the base migration ran. Re-run anyway:
-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE on every NEW function in
-- `public` to anon and authenticated directly, so any path that creates them
-- fresh would otherwise leave a SECURITY DEFINER bid/pass callable straight from
-- the browser with nothing but an anon key.
REVOKE ALL ON FUNCTION open_place_bid(UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION open_pass(UUID, UUID, TEXT)         FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION open_place_bid(UUID, UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION open_pass(UUID, UUID, TEXT)         TO service_role;

-- open_accepts_actions() and open_clock_now() are read-only helpers over data
-- the SELECT policies already expose, and stay callable by anyone, exactly like
-- open_is_running() and open_within_hours().
