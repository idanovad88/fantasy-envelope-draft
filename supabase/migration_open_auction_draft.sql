-- Migration: third draft type — open outcry auction (`draft_type = 'open'`)
--
-- Several players sit on the board at once. Bids are public and ascending; a
-- team that is done with a player marks PASS, which is FINAL for that auction.
-- An auction closes when every approved team except the current leader has
-- passed — or when its deadline runs out, whichever comes first. A team that is
-- currently the highest bidder may not pass.
--
-- WHY NEW TABLES INSTEAD OF REUSING `auctions` / `bids`
-- -----------------------------------------------------
-- 1. `bids` has UNIQUE(auction_id, team_id) — one row per team per auction,
--    which is exactly right for a sealed envelope and useless as an ascending
--    ledger.
-- 2. Worse, the live `auto-resolve-expired-auctions` cron loops over
--    `auctions WHERE status='active' AND reveal_time <= NOW()` and runs
--    `resolve_auction()` — envelope logic. An open auction sharing that table
--    would be closed by the wrong rules, in the production league that is
--    running right now. `trg_auto_bid_nominating_team` and `trg_enforce_min_bid`
--    would fire on rows they know nothing about for the same reason.
--
-- So: open_auctions / open_bids / open_passes, and zero changes to the envelope
-- path. Everything genuinely shared — players, teams, assign_roster_slot(),
-- refresh_team_stats(), demote_nomination_rank() — is still shared.
--
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE throughout. Safe to re-run.

-- ============================================================================
-- 1. LEAGUES
-- ============================================================================

-- The CHECK is recreated rather than altered — there is no ALTER CONSTRAINT for
-- a CHECK. Every existing check constraint on `leagues` whose definition
-- mentions draft_type is dropped by lookup rather than by guessing the name
-- Postgres generated: dropping the wrong name would leave the old
-- envelope/snake-only constraint in place, and creating an 'open' league would
-- then fail against a constraint that no file in this directory mentions.
-- Widening only — no existing row can violate the new form.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'leagues'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%draft_type%'
  LOOP
    EXECUTE format('ALTER TABLE leagues DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE leagues ADD CONSTRAINT leagues_draft_type_check
  CHECK (draft_type IN ('envelope', 'snake', 'open'));

ALTER TABLE leagues
  ADD COLUMN IF NOT EXISTS open_board_size INTEGER NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS open_pass_timeout_minutes INTEGER NOT NULL DEFAULT 120,
  -- Set while the draft's clocks are stopped (admin pause, or outside the
  -- league's active hours). On resume every open deadline moves forward by the
  -- elapsed gap. See open_draft_tick().
  ADD COLUMN IF NOT EXISTS open_frozen_since TIMESTAMPTZ,
  -- Soft close. On a bid the deadline moves to NOW() + the smallest of these
  -- that is larger than the time remaining; if neither is, it does not move.
  -- See open_place_bid().
  ADD COLUMN IF NOT EXISTS open_extend_short_minutes INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS open_extend_long_minutes INTEGER NOT NULL DEFAULT 60;

ALTER TABLE leagues DROP CONSTRAINT IF EXISTS leagues_open_board_size_check;
ALTER TABLE leagues ADD CONSTRAINT leagues_open_board_size_check
  CHECK (open_board_size BETWEEN 1 AND 30);

ALTER TABLE leagues DROP CONSTRAINT IF EXISTS leagues_open_pass_timeout_check;
ALTER TABLE leagues ADD CONSTRAINT leagues_open_pass_timeout_check
  CHECK (open_pass_timeout_minutes BETWEEN 5 AND 2880);

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

-- NOTE: draft_start_hour (8) and draft_end_hour (22) already exist on `leagues`
-- from the original schema and were never used by anything. They become this
-- format's active-hours window — no new columns needed.

-- ============================================================================
-- 2. TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS open_auctions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id),
  nominating_team_id UUID NOT NULL REFERENCES teams(id),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'completed', 'cancelled')),
  current_price INTEGER NOT NULL DEFAULT 1 CHECK (current_price >= 1),
  leader_team_id UUID REFERENCES teams(id),
  deadline_at TIMESTAMPTZ NOT NULL,
  winning_team_id UUID REFERENCES teams(id),
  winning_bid INTEGER,
  closed_reason TEXT CHECK (closed_reason IN ('all_passed', 'timeout', 'admin', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A player can only be on the board once at a time; a cancelled auction frees
-- them to be nominated again.
CREATE UNIQUE INDEX IF NOT EXISTS open_auctions_one_open_per_player
  ON open_auctions (player_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS open_auctions_league_status
  ON open_auctions (league_id, status);
CREATE INDEX IF NOT EXISTS open_auctions_leader
  ON open_auctions (leader_team_id) WHERE status = 'open';

-- Append-only ledger. Unlike `bids` this is many rows per team per auction —
-- it is the public bid history the board renders.
CREATE TABLE IF NOT EXISTS open_bids (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  open_auction_id UUID NOT NULL REFERENCES open_auctions(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL CHECK (amount >= 1),
  -- the nominator's mandatory opening $1
  is_auto BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS open_bids_auction
  ON open_bids (open_auction_id, created_at DESC);

CREATE TABLE IF NOT EXISTS open_passes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  open_auction_id UUID NOT NULL REFERENCES open_auctions(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  reason TEXT NOT NULL DEFAULT 'manual'
    CHECK (reason IN ('manual', 'admin', 'timeout', 'no_budget', 'roster_full', 'complete')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (open_auction_id, team_id)
);

-- ============================================================================
-- 3. RLS — public read, no write policy at all
-- ============================================================================
-- Same shape as snake_picks / trades: everything here is public by design (it
-- is an open outcry), and every write goes through an API route holding the
-- service-role key. With no INSERT/UPDATE/DELETE policy the browser cannot
-- write to these tables via PostgREST even with a valid session, which is why
-- the validation lives in the functions below and not in a BEFORE trigger.

ALTER TABLE open_auctions ENABLE ROW LEVEL SECURITY;
ALTER TABLE open_bids     ENABLE ROW LEVEL SECURITY;
ALTER TABLE open_passes   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "open_auctions_select" ON open_auctions;
CREATE POLICY "open_auctions_select" ON open_auctions FOR SELECT USING (true);

DROP POLICY IF EXISTS "open_bids_select" ON open_bids;
CREATE POLICY "open_bids_select" ON open_bids FOR SELECT USING (true);

DROP POLICY IF EXISTS "open_passes_select" ON open_passes;
CREATE POLICY "open_passes_select" ON open_passes FOR SELECT USING (true);

-- ============================================================================
-- 4. READ-ONLY HELPERS
-- ============================================================================

-- Is `p_at` inside [start_hour, end_hour) in Israel local time?
-- start = end means "no night" (always running).
-- STABLE, not IMMUTABLE: `timestamptz AT TIME ZONE` depends on the timezone
-- database, so it is only stable within a statement. Mislabelling it IMMUTABLE
-- would let the planner fold it away.
CREATE OR REPLACE FUNCTION open_within_hours(p_start INTEGER, p_end INTEGER, p_at TIMESTAMPTZ)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
DECLARE v_hour INTEGER;
BEGIN
  IF p_start IS NULL OR p_end IS NULL OR p_start = p_end THEN RETURN TRUE; END IF;
  v_hour := EXTRACT(HOUR FROM (p_at AT TIME ZONE 'Asia/Jerusalem'))::INTEGER;
  IF p_start < p_end THEN
    RETURN v_hour >= p_start AND v_hour < p_end;
  END IF;
  -- window wraps midnight, e.g. 20 → 6
  RETURN v_hour >= p_start OR v_hour < p_end;
END;
$$;

-- The most recent moment the active-hours window closed, at or before p_at.
-- Used so the once-a-minute tick stamps the real boundary instead of `now()`,
-- which would leak up to a minute of clock onto every open auction each night.
CREATE OR REPLACE FUNCTION open_last_hours_boundary(p_end INTEGER, p_at TIMESTAMPTZ)
RETURNS TIMESTAMPTZ LANGUAGE plpgsql STABLE AS $$
DECLARE v_local TIMESTAMP; v_boundary TIMESTAMP;
BEGIN
  v_local := p_at AT TIME ZONE 'Asia/Jerusalem';
  v_boundary := date_trunc('day', v_local) + make_interval(hours => p_end);
  IF v_boundary > v_local THEN v_boundary := v_boundary - INTERVAL '1 day'; END IF;
  RETURN v_boundary AT TIME ZONE 'Asia/Jerusalem';
END;
$$;

CREATE OR REPLACE FUNCTION open_is_running(p_league_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
DECLARE v_status TEXT; v_start INTEGER; v_end INTEGER;
BEGIN
  SELECT status, draft_start_hour, draft_end_hour
  INTO v_status, v_start, v_end
  FROM leagues WHERE id = p_league_id;

  IF v_status IS DISTINCT FROM 'active' THEN RETURN FALSE; END IF;
  RETURN open_within_hours(v_start, v_end, NOW());
END;
$$;

-- Roster slots a team has left once the auctions it is currently leading are
-- counted as already won.
CREATE OR REPLACE FUNCTION open_team_open_slots(p_team_id UUID)
RETURNS INTEGER LANGUAGE plpgsql STABLE AS $$
DECLARE v_count INTEGER; v_per_team INTEGER; v_leading INTEGER;
BEGIN
  SELECT t.player_count, l.players_per_team
  INTO v_count, v_per_team
  FROM teams t JOIN leagues l ON l.id = t.league_id
  WHERE t.id = p_team_id;

  IF v_per_team IS NULL THEN RETURN 0; END IF;

  SELECT COUNT(*) INTO v_leading
  FROM open_auctions WHERE leader_team_id = p_team_id AND status = 'open';

  RETURN v_per_team - v_count - v_leading;
END;
$$;

-- The ceiling for a NEW bid on an auction this team is not already leading.
--
-- This is getMaxBid() from lib/utils.ts with shifted arguments, not a new rule:
--   getMaxBid(budget - sumLeading, playerCount + leadingCount, playersPerTeam)
-- Only auctions the team currently *leads* tie up money — being outbid frees it
-- immediately, because a losing bid can never turn into a purchase.
-- budget_remaining already excludes players actually won (refresh_team_stats),
-- so there is no double counting.
CREATE OR REPLACE FUNCTION open_team_max_bid(p_team_id UUID)
RETURNS INTEGER LANGUAGE plpgsql STABLE AS $$
DECLARE v_budget INTEGER; v_sum_leading INTEGER; v_slots_left INTEGER;
BEGIN
  SELECT budget_remaining INTO v_budget FROM teams WHERE id = p_team_id;
  IF v_budget IS NULL THEN RETURN 0; END IF;

  v_slots_left := open_team_open_slots(p_team_id);
  IF v_slots_left <= 0 THEN RETURN 0; END IF;

  SELECT COALESCE(SUM(current_price), 0) INTO v_sum_leading
  FROM open_auctions WHERE leader_team_id = p_team_id AND status = 'open';

  -- Reserve $1 for every slot still open after this one.
  RETURN (v_budget - v_sum_leading) - (v_slots_left - 1);
END;
$;

-- The ceiling this team could reach if every auction it currently leads were
-- lost. This is the test for "out for good", and it is the ONLY budget reason
-- that may produce a permanent auto-PASS: money tied up in another open auction
-- comes back the moment the team is outbid there, so it must not eliminate.
CREATE OR REPLACE FUNCTION open_team_hard_max_bid(p_team_id UUID)
RETURNS INTEGER LANGUAGE plpgsql STABLE AS $
DECLARE v_budget INTEGER; v_count INTEGER; v_per_team INTEGER; v_slots INTEGER;
BEGIN
  SELECT t.budget_remaining, t.player_count, l.players_per_team
  INTO v_budget, v_count, v_per_team
  FROM teams t JOIN leagues l ON l.id = t.league_id
  WHERE t.id = p_team_id;

  IF v_per_team IS NULL THEN RETURN 0; END IF;

  -- Real roster slots: unlike open_team_open_slots() this does not subtract
  -- auctions the team is leading.
  v_slots := v_per_team - v_count;
  IF v_slots <= 0 THEN RETURN 0; END IF;

  RETURN v_budget - (v_slots - 1);
END;
$;

-- ============================================================================
-- 5. MUTATING FUNCTIONS
-- ============================================================================

CREATE OR REPLACE FUNCTION open_close_auction(p_auction_id UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_league_id UUID; v_player_id UUID; v_leader UUID;
  v_price INTEGER; v_status TEXT;
  v_approved INTEGER; v_complete INTEGER;
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

-- Run after every bid and every pass.
--   1. Auto-PASS any team that is out for good — roster full, or unable to
--      afford the price even if every auction it leads were lost — with an
--      explicit reason so the board can say why. A team blocked only by its own
--      commitments is NOT passed; the deadline is what ends the auction then.
--   2. If nobody but the leader is left without a pass, close.
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

  -- Only teams that can never come back are passed. A team held up purely by
  -- its own leading bids is left alone: it cannot bid at this moment, but being
  -- outbid elsewhere puts it straight back in. Passing it would turn a rival's
  -- temporary commitment into a permanent elimination, which is timeable.
  --
  -- 'roster_full' is therefore never produced: a team that is not is_complete
  -- always has a real slot free, and a merely committed slot is temporary. The
  -- value stays in the CHECK for rows written before this rule.
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

-- ⚠️ The 3-argument version must be DROPPED, not replaced. A defaulted 4th
-- argument creates a NEW function rather than replacing the old one, and a
-- 3-argument call would then match both and fail as ambiguous.

DROP FUNCTION IF EXISTS open_nominate(UUID, UUID, UUID);

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
  IF NOT open_is_running(p_league_id) THEN
    RAISE EXCEPTION 'הדראפט אינו פעיל כרגע — מושהה או מחוץ לשעות הפעילות';
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

  INSERT INTO open_auctions
    (league_id, player_id, nominating_team_id, current_price, leader_team_id, deadline_at)
  VALUES
    (p_league_id, p_player_id, p_team_id, p_opening_bid, p_team_id,
     NOW() + make_interval(mins => v_league.open_pass_timeout_minutes))
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

  -- Graduated soft close: the deadline moves to NOW() + the smallest configured
  -- window LARGER than the time remaining, and stands when neither qualifies.
  -- With 30/60: 90 minutes left is untouched, 50 left goes back up to an hour,
  -- 10 left gains 20 minutes for half an hour to respond. It can never move
  -- earlier — only a window greater than the remaining time is ever chosen.
  --
  -- open_pass_timeout_minutes is NOT used here; that is the opening window a
  -- newly nominated player gets, set in open_nominate().
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

CREATE OR REPLACE FUNCTION open_pass(p_auction_id UUID, p_team_id UUID, p_reason TEXT DEFAULT 'manual')
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_a RECORD;
BEGIN
  SELECT * INTO v_a FROM open_auctions WHERE id = p_auction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'המכרז לא נמצא'; END IF;
  IF v_a.status <> 'open' THEN RAISE EXCEPTION 'המכרז כבר נסגר'; END IF;

  -- Automatic reasons (timeout / no_budget) are written by the clock, which
  -- runs precisely when the league is not.
  IF p_reason IN ('manual', 'admin') AND NOT open_is_running(v_a.league_id) THEN
    RAISE EXCEPTION 'הדראפט אינו פעיל כרגע — מושהה או מחוץ לשעות הפעילות';
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

-- Admin escape hatch. PASS is final by design, so cancelling and re-nominating
-- is the only way to undo a mistaken pass.
CREATE OR REPLACE FUNCTION open_cancel_auction(p_auction_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_player_id UUID; v_status TEXT;
BEGIN
  SELECT player_id, status INTO v_player_id, v_status
  FROM open_auctions WHERE id = p_auction_id FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'המכרז לא נמצא'; END IF;
  IF v_status <> 'open' THEN RAISE EXCEPTION 'אפשר לבטל רק מכרז פתוח'; END IF;

  -- Bids and passes cascade with the rows below; the auction row itself is kept
  -- so the history shows the player was up and pulled.
  DELETE FROM open_bids   WHERE open_auction_id = p_auction_id;
  DELETE FROM open_passes WHERE open_auction_id = p_auction_id;

  UPDATE open_auctions SET
    status = 'cancelled', closed_reason = 'cancelled',
    leader_team_id = NULL, updated_at = NOW()
  WHERE id = p_auction_id;

  UPDATE players SET status = 'available' WHERE id = v_player_id;
END;
$$;

CREATE OR REPLACE FUNCTION open_set_pause(p_league_id UUID, p_paused BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_status TEXT; v_type TEXT;
BEGIN
  SELECT status, draft_type INTO v_status, v_type
  FROM leagues WHERE id = p_league_id FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'הליגה לא נמצאה'; END IF;
  IF v_type <> 'open' THEN RAISE EXCEPTION 'הליגה אינה דראפט מכרז פתוח'; END IF;

  IF p_paused THEN
    IF v_status NOT IN ('active', 'paused') THEN
      RAISE EXCEPTION 'אפשר להשהות רק דראפט פעיל';
    END IF;
    -- Stamped here rather than left to the tick so a pause does not leak up to
    -- a minute of clock onto every open auction.
    UPDATE leagues SET
      status = 'paused',
      open_frozen_since = COALESCE(open_frozen_since, NOW()),
      updated_at = NOW()
    WHERE id = p_league_id;
  ELSE
    IF v_status <> 'paused' THEN RAISE EXCEPTION 'הדראפט אינו מושהה'; END IF;
    UPDATE leagues SET status = 'active', updated_at = NOW() WHERE id = p_league_id;
    -- The unfreeze and the deadline shift belong to the tick: resuming inside
    -- night hours must leave the clocks stopped.
    PERFORM open_draft_tick(p_league_id);
  END IF;
END;
$$;

-- ============================================================================
-- 6. THE CLOCK
-- ============================================================================
-- Freeze / thaw, then close anything out of time. Idempotent and cheap — safe
-- to call on every page load as well as from the every-minute cron, the same
-- shape as activateOverduePendingAuctions() in lib/auctions.ts.
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

CREATE OR REPLACE FUNCTION open_draft_tick_all()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r RECORD; v_n INTEGER := 0;
BEGIN
  FOR r IN
    SELECT id FROM leagues
    WHERE draft_type = 'open' AND status IN ('active', 'paused')
  LOOP
    BEGIN
      PERFORM open_draft_tick(r.id);
      v_n := v_n + 1;
    EXCEPTION WHEN OTHERS THEN
      -- Lands in the Postgres log, NOT in cron.job_run_details — the same blind
      -- spot auto_resolve_expired_auctions() has. The query that surfaces a
      -- stuck auction is in cron_open_draft_tick.sql.
      RAISE WARNING 'open_draft_tick failed for league %: %', r.id, SQLERRM;
    END;
  END LOOP;
  RETURN v_n;
END;
$$;


-- Undo a CLOSED auction: the player returns to the pool and the money returns
-- to the winner. open_cancel_auction() above only handles an auction that is
-- still open; without this a mistaken close was permanent.
--
-- The refund is refresh_team_stats(), which recomputes budget and player_count
-- from the team's drafted players — so clearing drafted_by_team_id/draft_price
-- first IS the refund, and it cannot drift from a hand-written `+ price`.
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
-- ============================================================================
-- 7. EXECUTE GRANTS
-- ============================================================================
-- These are SECURITY DEFINER, so whoever can execute them acts as the owner.
-- Without this block any visitor could call them straight through PostgREST
-- with someone else's team_id and skip the identity check the API routes do —
-- which would make the write-policy-free RLS above pointless.
--
-- ⚠️ Revoking from PUBLIC alone is NOT enough on Supabase, and this was
-- verified the hard way: `anon` and `authenticated` hold a *direct* EXECUTE
-- grant on every new function in the public schema (Supabase ships an
-- ALTER DEFAULT PRIVILEGES that grants it), so dropping the PUBLIC grant left
-- both roles able to run all of these. They must be named explicitly.

REVOKE ALL ON FUNCTION open_nominate(UUID, UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION open_place_bid(UUID, UUID, INTEGER)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION open_pass(UUID, UUID, TEXT)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION open_close_auction(UUID, TEXT)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION open_settle_auction(UUID)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION open_cancel_auction(UUID)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION open_undo_auction(UUID)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION open_set_pause(UUID, BOOLEAN)        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION open_draft_tick(UUID)                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION open_draft_tick_all()                FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION open_nominate(UUID, UUID, UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION open_place_bid(UUID, UUID, INTEGER)  TO service_role;
GRANT EXECUTE ON FUNCTION open_pass(UUID, UUID, TEXT)          TO service_role;
GRANT EXECUTE ON FUNCTION open_close_auction(UUID, TEXT)       TO service_role;
GRANT EXECUTE ON FUNCTION open_settle_auction(UUID)            TO service_role;
GRANT EXECUTE ON FUNCTION open_cancel_auction(UUID)            TO service_role;
GRANT EXECUTE ON FUNCTION open_undo_auction(UUID)              TO service_role;
GRANT EXECUTE ON FUNCTION open_set_pause(UUID, BOOLEAN)        TO service_role;
GRANT EXECUTE ON FUNCTION open_draft_tick(UUID)                TO service_role;
GRANT EXECUTE ON FUNCTION open_draft_tick_all()                TO service_role;

-- The read-only helpers stay callable by anyone: they only read data that is
-- already public through the SELECT policies above.

-- ============================================================================
-- 8. REALTIME
-- ============================================================================
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE open_auctions;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- open_bids / open_passes are deliberately NOT published. Neither has a
-- league_id, so a subscription on them could not be filtered per league and
-- every client in every league would wake on every write. Instead both write
-- paths bump `open_auctions.updated_at`, so the one filtered subscription above
-- covers nominations (INSERT), bids, passes and closes (UPDATE).

-- Verify (changes nothing):
--   SELECT proname FROM pg_proc WHERE proname LIKE 'open\_%' ORDER BY proname;
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'leagues'::regclass AND conname LIKE '%draft_type%';
