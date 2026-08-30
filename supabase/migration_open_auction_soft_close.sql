-- Follow-up to migration_open_auction_draft.sql — a graduated soft close on the
-- bid clock, replacing the full reset.
--
-- Touches ONLY open-outcry objects (every name starts with open_). Nothing here
-- references `auctions`, `bids`, `resolve_auction`, or any envelope/snake
-- object. Idempotent.
--
-- WHY
-- ---
-- Until now every bid set deadline_at = NOW() + open_pass_timeout_minutes, i.e.
-- a bid one minute before the close handed everyone another two hours. That
-- made sniping impossible, but it also meant a contested auction could run for
-- days: each late bid bought another full window.
--
-- THE RULE
-- --------
-- On a bid, the deadline moves to NOW() + W, where W is the SMALLEST configured
-- window LARGER than the time currently remaining. If no window qualifies, the
-- deadline does not move. With the defaults (30 and 60):
--
--   90 minutes left → no window is larger → unchanged, 90 minutes still to run
--   50 minutes left → 60 → the clock goes back to showing an hour
--   10 minutes left → 30 → 20 minutes are added, half an hour to respond
--
-- The deadline can never move EARLIER, and that follows from the rule rather
-- than needing a guard: only a W greater than the remaining time is chosen, so
-- NOW() + W is always past the deadline it replaces.
--
-- open_pass_timeout_minutes keeps its old meaning — it is the OPENING window a
-- newly nominated player gets, set in open_nominate(), not an extension.
--
-- To switch this off, set both windows equal to open_pass_timeout_minutes: then
-- every bid lands on NOW() + timeout, exactly the previous behaviour.

-- ── 1. The two windows ──────────────────────────────────────────────────────
ALTER TABLE leagues
  ADD COLUMN IF NOT EXISTS open_extend_short_minutes INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS open_extend_long_minutes  INTEGER NOT NULL DEFAULT 60;

ALTER TABLE leagues DROP CONSTRAINT IF EXISTS leagues_open_extend_short_check;
ALTER TABLE leagues ADD CONSTRAINT leagues_open_extend_short_check
  CHECK (open_extend_short_minutes BETWEEN 1 AND 2880);

ALTER TABLE leagues DROP CONSTRAINT IF EXISTS leagues_open_extend_long_check;
ALTER TABLE leagues ADD CONSTRAINT leagues_open_extend_long_check
  CHECK (open_extend_long_minutes BETWEEN 1 AND 2880);

-- A "far" window shorter than the "near" one would simply never be selected,
-- which reads as the setting doing nothing. Rejected outright instead.
ALTER TABLE leagues DROP CONSTRAINT IF EXISTS leagues_open_extend_order_check;
ALTER TABLE leagues ADD CONSTRAINT leagues_open_extend_order_check
  CHECK (open_extend_long_minutes >= open_extend_short_minutes);

-- ── 2. The bid, with the ladder ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION open_place_bid(p_auction_id UUID, p_team_id UUID, p_amount INTEGER)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_a RECORD; v_max INTEGER;
  v_short INTEGER; v_long INTEGER;
  v_remaining INTERVAL; v_deadline TIMESTAMPTZ;
BEGIN
  -- Row lock: two teams raising the same auction at the same instant must not
  -- both read the same current_price.
  SELECT * INTO v_a FROM open_auctions WHERE id = p_auction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'המכרז לא נמצא'; END IF;
  IF v_a.status <> 'open' THEN RAISE EXCEPTION 'המכרז כבר נסגר'; END IF;

  IF NOT open_is_running(v_a.league_id) THEN
    RAISE EXCEPTION 'הדראפט אינו פעיל כרגע — מושהה או מחוץ לשעות הפעילות';
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

  -- The smallest configured window larger than what is left. Nothing qualifies
  -- when the auction still has plenty of time, and then the deadline stands.
  v_remaining := v_a.deadline_at - NOW();
  v_deadline := CASE
    WHEN v_remaining < make_interval(mins => v_short) THEN NOW() + make_interval(mins => v_short)
    WHEN v_remaining < make_interval(mins => v_long)  THEN NOW() + make_interval(mins => v_long)
    ELSE v_a.deadline_at
  END;

  INSERT INTO open_bids (open_auction_id, team_id, amount)
  VALUES (p_auction_id, p_team_id, p_amount);

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

-- ── 3. Grants ───────────────────────────────────────────────────────────────
-- CREATE OR REPLACE keeps the existing ACL, but this project has been bitten
-- once by assuming a revoke stuck, so re-assert it. anon and authenticated must
-- be named explicitly — see migration_open_auction_grants_fix.sql.
REVOKE ALL ON FUNCTION open_place_bid(UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION open_place_bid(UUID, UUID, INTEGER) TO service_role;

-- Verify (changes nothing):
--   SELECT name, open_pass_timeout_minutes, open_extend_short_minutes,
--          open_extend_long_minutes
--   FROM leagues WHERE draft_type = 'open';
