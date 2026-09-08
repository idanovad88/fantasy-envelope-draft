-- Migration: automatic nomination queue for the open outcry draft
--
-- A board slot frees when an auction closes, and from that moment the board sits
-- empty until a human puts a player up: open_close_auction() settles its
-- siblings and nothing else. A turn that comes round at 03:00 simply waits, so
-- the pace of the whole draft is set by who happens to be awake.
--
-- Each team can now keep an ordered, PRIVATE list of players it wants to put
-- up, each with its own opening bid. When the team's turn arrives the first
-- viable entry goes up on its own.
--
-- WHERE THE FILL RUNS, AND WHY NOT AT CLOSE
-- -----------------------------------------
-- open_nominate() ends by calling open_settle_auction(), which can close the
-- auction inside the nomination itself -> open_close_auction() -> the sibling
-- sweep -> more settling. Filling from open_close_auction() would re-enter
-- open_nominate() from inside that recursion. So the fill lives at the end of
-- open_draft_tick(), which the cron runs every minute AND every relevant page
-- load runs through settleOpenDraft() — immediate for anyone actually watching.
-- The loop is bounded by a hard iteration cap rather than `WHILE free > 0`,
-- because filling one slot can legitimately free another.
--
-- NIGHT FILLS TOO
-- ---------------
-- Nominating by hand is allowed right through the night in this format — only
-- the clocks stop (open_accepts_actions). The tick used to RETURN early while
-- frozen, so a fill at the end of the body would silently not have run at
-- night, contradicting the manual rule. The freeze/thaw branch is therefore
-- restructured from an early RETURN into IF/ELSE, and the fill runs after it
-- whenever the league is `active`. An admin PAUSE still fills nothing:
-- open_nominate() refuses it, so the call is skipped rather than attempted.
--
-- THE FIRST *VIABLE* ENTRY, NOT THE FIRST ENTRY
-- ---------------------------------------------
-- Viable = the player is still `available` AND the entry's opening bid is
-- within open_team_max_bid() right now. Taking the head of the list blindly
-- would let one unaffordable entry block the whole queue for good.
--
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE throughout. Safe to re-run.
--
-- ⚠️ This file REPLACES the bodies of open_draft_tick() and
-- open_notify_turn_candidates(). Re-running migration_open_auction_draft.sql or
-- migration_open_notifications.sql after it silently reverts both — the fill
-- stops happening and the "your turn" push comes back for teams whose queue is
-- about to answer for them.

-- ============================================================================
-- 1. THE QUEUE
-- ============================================================================
-- Per TEAM, not per user: an owner and their assistant manager share one list,
-- so there is never a question of which one answers when the turn comes.
--
-- No UNIQUE (team_id, position) — reordering the list would need a deferred
-- constraint to avoid transient collisions. Order is always read as
-- (position, created_at), and the reorder route rewrites every row at once.

CREATE TABLE IF NOT EXISTS open_nomination_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  team_id   UUID NOT NULL REFERENCES teams(id)   ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  opening_bid INTEGER NOT NULL DEFAULT 1 CHECK (opening_bid >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (team_id, player_id)
);
CREATE INDEX IF NOT EXISTS open_nomination_queue_team ON open_nomination_queue (team_id, position);
CREATE INDEX IF NOT EXISTS open_nomination_queue_league ON open_nomination_queue (league_id);

ALTER TABLE open_nomination_queue ENABLE ROW LEVEL SECURITY;

-- The list is SECRET, and that is the security point of the feature: a rival
-- who can read your queue knows exactly whom to put up ahead of you. Unlike the
-- other open_* tables, which are `FOR SELECT USING (true)`, this one is
-- readable only by the team it belongs to — owner or assistant. That SELECT
-- policy is what lets the players page read it with the cookie client.
--
-- No write policy at all: every write goes through /api/open/queue with the
-- service-role client, the same shape as the rest of the open format.
DROP POLICY IF EXISTS "open_queue_select_own" ON open_nomination_queue;
CREATE POLICY "open_queue_select_own" ON open_nomination_queue
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM teams t
    WHERE t.id = open_nomination_queue.team_id
      AND (t.user_id = auth.uid() OR t.assistant_user_id = auth.uid())
  ));

-- ============================================================================
-- 2. READ-ONLY HELPERS
-- ============================================================================

-- How many board slots are free. The expression
-- `open_board_size - COUNT(status = 'open')` is currently hand-copied into
-- open_nominate(), open_notify_turn_candidates() and getOpenNominationOrder();
-- this feature needs it twice more and adds a name instead of two more copies.
CREATE OR REPLACE FUNCTION open_board_free_slots(p_league_id UUID)
RETURNS INTEGER LANGUAGE sql STABLE AS $$
  SELECT GREATEST(0, l.open_board_size - (
    SELECT COUNT(*) FROM open_auctions a
    WHERE a.league_id = l.id AND a.status = 'open'
  ))::INTEGER
  FROM leagues l
  WHERE l.id = p_league_id;
$$;

-- The entry this team would put up right now, or no row at all.
--
-- SECURITY INVOKER — deliberately NOT definer. It reads a private table, so RLS
-- must apply to anyone calling it directly; a definer version would hand any
-- authenticated user another team's queue. Called from inside the definer
-- functions below it runs as their owner and sees everything, which is what the
-- fill needs.
CREATE OR REPLACE FUNCTION open_queue_next_entry(p_team_id UUID)
RETURNS TABLE (player_id UUID, opening_bid INTEGER)
LANGUAGE sql STABLE AS $$
  SELECT q.player_id, q.opening_bid
  FROM open_nomination_queue q
  JOIN players p ON p.id = q.player_id
  WHERE q.team_id = p_team_id
    -- A player somebody else already put up (or who has been sold) is simply
    -- skipped, and reappears if an admin cancels that auction. Nothing deletes
    -- the row, so the list is self-healing rather than quietly rewritten.
    AND p.status = 'available'
    -- An entry priced above what the team can pay today is skipped, not stuck
    -- at the head of the queue blocking everything behind it.
    AND q.opening_bid <= open_team_max_bid(p_team_id)
  ORDER BY q.position, q.created_at
  LIMIT 1;
$$;

-- ============================================================================
-- 3. THE FILL
-- ============================================================================
CREATE OR REPLACE FUNCTION open_autofill_board(p_league_id UUID)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_board_size INTEGER;
  v_free INTEGER;
  v_filled INTEGER := 0;
  v_did_one BOOLEAN;
  t RECORD;
  -- Scalars rather than a RECORD: `SELECT INTO` a record that matched no row
  -- leaves field access ambiguous to read, and this runs on every page load.
  v_player UUID;
  v_bid INTEGER;
BEGIN
  -- 'active' only. open_nominate() refuses a paused league, so attempting the
  -- fill there would just raise once per team per tick.
  SELECT l.open_board_size INTO v_board_size
  FROM leagues l
  WHERE l.id = p_league_id AND l.draft_type = 'open' AND l.status = 'active';
  IF NOT FOUND THEN RETURN 0; END IF;

  -- Hard cap rather than `WHILE v_free > 0`: open_nominate() settles the
  -- auction it just created, which can close it on the spot (every other team
  -- auto-passed on the opening price) and free the slot straight back. Without
  -- a cap that is an infinite loop inside a function four pages call on render.
  FOR i IN 1..(v_board_size + 2) LOOP
    v_free := open_board_free_slots(p_league_id);
    EXIT WHEN v_free <= 0;

    v_did_one := FALSE;

    -- The eligible teams whose turn it is right now, in rank order. Same filter
    -- as the turn check inside open_nominate() — approved, ranked, not
    -- complete, able to afford the $1 a nomination forces — so this can only
    -- ever offer a turn the DB would also accept. Recomputed every iteration,
    -- never snapshotted: each nomination demotes its nominator, so the head of
    -- the order moves underneath us.
    FOR t IN
      SELECT tm.id
      FROM teams tm
      WHERE tm.league_id = p_league_id
        AND tm.approved
        AND tm.priority_rank IS NOT NULL
        AND NOT tm.is_complete
        AND open_team_max_bid(tm.id) >= 1
      ORDER BY tm.priority_rank
      LIMIT v_free
    LOOP
      v_player := NULL;
      SELECT q.player_id, q.opening_bid INTO v_player, v_bid
      FROM open_queue_next_entry(t.id) q;
      -- No queue, or nothing in it is viable: this team keeps its turn and
      -- nominates by hand. Auto-nomination is opt-in by having a list.
      CONTINUE WHEN v_player IS NULL;

      -- open_nominate() RAISEs instead of returning a status, and this runs on
      -- every page load of four pages. One stale entry must not take the tick
      -- down with it — same shape as open_draft_tick_all().
      BEGIN
        PERFORM open_nominate(p_league_id, v_player, t.id, v_bid);
        v_filled := v_filled + 1;
        v_did_one := TRUE;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'open_autofill_board: league % team % player % — %',
          p_league_id, t.id, v_player, SQLERRM;
      END;

      -- On success, break out and recount the board. On failure, fall through
      -- to the next team — one team's bad entry must not stall the others.
      EXIT WHEN v_did_one;
    END LOOP;

    EXIT WHEN NOT v_did_one;
  END LOOP;

  RETURN v_filled;
END;
$$;

-- ============================================================================
-- 4. THE TICK
-- ============================================================================
-- Identical to the body in migration_open_auction_draft.sql except that the
-- frozen branch no longer RETURNs (so the fill below it is reached at night)
-- and the fill is called at the end.
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
  ELSE
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
  END IF;

  -- Last, so the board count it reads is final for this tick: the thaw, the
  -- settle sweep and the close loop can all free a slot. Reached in the frozen
  -- branch too — night stops the clocks, not the nominating.
  IF v_league.status = 'active' THEN
    PERFORM open_autofill_board(p_league_id);
  END IF;
END;
$$;

-- ============================================================================
-- 5. DON'T ANNOUNCE A TURN THE QUEUE IS ABOUT TO ANSWER
-- ============================================================================
-- Identical to migration_open_notifications.sql except for the final NOT EXISTS.
-- Both jobs run every minute, so without this a team with a filled queue gets
-- "🏀 תורך להעלות שחקן" seconds before the board answers for it.
CREATE OR REPLACE FUNCTION open_notify_turn_candidates()
RETURNS TABLE (
  league_id UUID,
  team_id UUID,
  turn_rank INTEGER,
  team_name TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT t.league_id, t.id, t.priority_rank, t.name
  FROM teams t
  JOIN leagues l ON l.id = t.league_id
  WHERE l.draft_type = 'open'
    AND l.status = 'active'
    AND open_within_hours(l.draft_start_hour, l.draft_end_hour, NOW())
    AND t.approved
    AND t.priority_rank IS NOT NULL
    AND NOT t.is_complete
    AND open_team_max_bid(t.id) >= 1
    AND (
      SELECT COUNT(*)
      FROM teams t2
      WHERE t2.league_id = t.league_id
        AND t2.approved
        AND t2.priority_rank IS NOT NULL
        AND t2.priority_rank < t.priority_rank
        AND NOT t2.is_complete
        AND open_team_max_bid(t2.id) >= 1
    ) <= l.open_board_size
         - (SELECT COUNT(*) FROM open_auctions a
            WHERE a.league_id = t.league_id AND a.status = 'open')
         - 1
    AND NOT EXISTS (
      SELECT 1 FROM open_notifications n
      WHERE n.kind = 'turn' AND n.team_id = t.id AND n.turn_rank = t.priority_rank
    )
    -- Nothing to tell a team that has already said what it wants.
    AND NOT EXISTS (SELECT 1 FROM open_queue_next_entry(t.id));
$$;

-- ============================================================================
-- 6. EXECUTE GRANTS
-- ============================================================================
-- Supabase ships ALTER DEFAULT PRIVILEGES granting EXECUTE on new functions in
-- `public` to anon and authenticated, so every definer function gets a DIRECT
-- grant on top of the PUBLIC one and must be revoked BY NAME. This project has
-- already shipped that bug once (migration_open_auction_grants_fix.sql).
REVOKE ALL ON FUNCTION open_autofill_board(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION open_autofill_board(UUID) TO service_role;

REVOKE ALL ON FUNCTION open_draft_tick(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION open_draft_tick(UUID) TO service_role;

REVOKE ALL ON FUNCTION open_notify_turn_candidates() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION open_notify_turn_candidates() TO service_role;

-- open_board_free_slots() and open_queue_next_entry() stay publicly callable,
-- like the other read-only helpers. Neither is SECURITY DEFINER, so the queue's
-- RLS still applies to anyone calling open_queue_next_entry() directly — it
-- returns nothing for a team that is not theirs.

-- Verify (changes nothing):
--   SELECT p.proname, array_to_string(p.proacl, ', ') AS grants
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.proname LIKE 'open\_%' ORDER BY p.proname;
--   -- open_autofill_board, open_draft_tick, open_notify_turn_candidates:
--   -- postgres and service_role only.
--
--   -- With the ANON key, this must come back empty:
--   SELECT * FROM open_nomination_queue;
--
--   -- Nothing stuck after the new loop (a frozen league is not stuck):
--   SELECT id, league_id, deadline_at FROM open_auctions
--   WHERE status = 'open' AND deadline_at < now() - interval '5 minutes';
