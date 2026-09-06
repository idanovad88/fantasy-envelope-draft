-- Migration: push notifications for the open outcry draft (`draft_type = 'open'`)
--
-- Until now this format sent nothing. With a 30-minute soft-close window that
-- meant a manager had to be watching the screen to stay in an auction. Three
-- notifications are added, all of them open-outcry only:
--
--   1. "your turn to put a player up" — to the team (owner + assistant) the
--      moment a board slot opens for it;
--   2. a starred player — to every user who starred him, when he goes up and on
--      every raise against him;
--   3. "you have been outbid" — to whoever was leading before this bid.
--
-- WHERE THE DECISION LIVES
-- ------------------------
-- Both open_notify_turn_candidates() and open_notify_bid_events() return
-- exactly what still has to be sent. The pg_cron guard and the Next route call
-- the SAME function, so the two cannot drift — the failure CLAUDE.md warns
-- about under "Widening what the route does means widening the guard". The send
-- itself has to be Node (web-push signs VAPID and encrypts the payload), hence
-- a guarded net.http_post job rather than pure SQL.
--
-- NIGHT HOLDS THE NOTIFICATION, NOT THE ACTION
-- --------------------------------------------
-- Nominating, bidding and PASS all run straight through the night in this
-- format — only the clocks stop. A push does not: both functions filter on
-- open_within_hours(), so an event at 03:00 is simply not due yet and goes out
-- on the first tick after draft_start_hour. Because the bid key is the LATEST
-- bid of each open auction rather than every row in the ledger, five overnight
-- raises on one player collapse into one morning notification carrying the
-- current price — not five stale ones.
--
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE throughout. Safe to re-run,
-- with one caveat noted at the baseline.

-- ============================================================================
-- 1. STARRED PLAYERS
-- ============================================================================
-- Per USER, not per team: an owner and their assistant manager each keep their
-- own list, and nobody sees anyone else's. league_id is denormalised off
-- players so the dashboard card can filter without a join.

CREATE TABLE IF NOT EXISTS player_watch (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  league_id UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, player_id)
);
CREATE INDEX IF NOT EXISTS player_watch_player ON player_watch (player_id);
CREATE INDEX IF NOT EXISTS player_watch_user_league ON player_watch (user_id, league_id);

ALTER TABLE player_watch ENABLE ROW LEVEL SECURITY;

-- Own rows only, the league_hidden shape. The SELECT policy is what lets the
-- server components read the list with the cookie client instead of the service
-- role; writes still go through /api/players/watch, which also checks league
-- membership.
DROP POLICY IF EXISTS "player_watch_select_own" ON player_watch;
CREATE POLICY "player_watch_select_own" ON player_watch
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "player_watch_insert_own" ON player_watch;
CREATE POLICY "player_watch_insert_own" ON player_watch
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "player_watch_delete_own" ON player_watch;
CREATE POLICY "player_watch_delete_own" ON player_watch
  FOR DELETE USING (auth.uid() = user_id);

-- ============================================================================
-- 2. SEND LEDGER
-- ============================================================================
-- Same contract as auction_notifications: the route inserts the claim BEFORE
-- sending, so two overlapping ticks cannot both send — the unique index is the
-- lock, not an afterthought.
--
-- The turn key is (team_id, priority_rank). demote_nomination_rank() writes
-- MAX(rank) + 1, so a team's rank rises strictly after every nomination: a new
-- turn cycle is a new key, and within one cycle there is nothing to repeat.
-- (Known gap: rewriting the order by hand in the admin lottery tab can hand a
-- team a rank it already held, which would swallow one notification. Not worth
-- a column of its own.)
--
-- The bid key is the bid row itself, and only ever the latest bid of an auction
-- that is still open — see the header on why that is what makes the night hold
-- collapse correctly.

CREATE TABLE IF NOT EXISTS open_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('turn', 'bid')),
  -- kind = 'turn'
  team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
  turn_rank INTEGER,
  -- kind = 'bid'
  open_bid_id UUID REFERENCES open_bids(id) ON DELETE CASCADE,
  sent_at TIMESTAMPTZ,
  recipients INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS open_notifications_turn_key
  ON open_notifications (team_id, turn_rank) WHERE kind = 'turn';
CREATE UNIQUE INDEX IF NOT EXISTS open_notifications_bid_key
  ON open_notifications (open_bid_id) WHERE kind = 'bid';
CREATE INDEX IF NOT EXISTS open_notifications_league
  ON open_notifications (league_id, created_at DESC);

ALTER TABLE open_notifications ENABLE ROW LEVEL SECURITY;
-- No policies -> service-role only, like auction_notifications. Nothing in the
-- UI reads it.

-- ============================================================================
-- 3. WHAT IS DUE
-- ============================================================================

-- Teams that may put a player up right now and have not been told about this
-- turn yet.
--
-- The eligibility test is a transcription of the gate inside open_nominate():
-- approved, ranked, not complete, able to afford the $1 the nomination forces,
-- and with fewer eligible teams ahead of it than there are free board slots. If
-- those two ever disagree this announces a turn the DB then refuses.
--
-- Every column reference is table-qualified on purpose: the RETURNS TABLE names
-- are output parameters, and an unqualified `team_id` here would be ambiguous.
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
    -- 'active' only: a pause refuses a nomination (open_accepts_actions), so a
    -- turn announced during one would point at a button that rejects it.
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
    );
$$;

-- The newest bid on each auction that is still open, when nobody has been told
-- about it yet — plus the bid under it, whose team IS the previous leader:
-- open_place_bid() refuses a raise from the team already leading, so two
-- consecutive rows in the ledger always belong to different teams. That is the
-- whole source of "you have been outbid"; no extra table needed.
--
-- is_opening (open_bids.is_auto) marks the bid that came with the nomination,
-- i.e. the player going up rather than a raise against a standing price.
--
-- At most open_board_size rows per league, so the 1000-row cap is not in play
-- and the ledger is never read league-wide.
CREATE OR REPLACE FUNCTION open_notify_bid_events()
RETURNS TABLE (
  league_id UUID,
  open_auction_id UUID,
  bid_id UUID,
  player_id UUID,
  player_name TEXT,
  bidder_team_id UUID,
  bidder_team_name TEXT,
  amount INTEGER,
  is_opening BOOLEAN,
  prev_leader_team_id UUID
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT a.league_id, a.id, b.id, a.player_id, p.name,
         b.team_id, bt.name, b.amount, b.is_auto, prev.team_id
  FROM open_auctions a
  JOIN leagues l ON l.id = a.league_id
  JOIN players p ON p.id = a.player_id
  JOIN LATERAL (
    SELECT ob.id, ob.team_id, ob.amount, ob.is_auto
    FROM open_bids ob
    WHERE ob.open_auction_id = a.id
    ORDER BY ob.created_at DESC, ob.id DESC
    LIMIT 1
  ) b ON TRUE
  JOIN teams bt ON bt.id = b.team_id
  LEFT JOIN LATERAL (
    SELECT ob.team_id
    FROM open_bids ob
    WHERE ob.open_auction_id = a.id AND ob.id <> b.id
    ORDER BY ob.created_at DESC, ob.id DESC
    LIMIT 1
  ) prev ON TRUE
  WHERE l.draft_type = 'open'
    AND l.status = 'active'
    AND open_within_hours(l.draft_start_hour, l.draft_end_hour, NOW())
    AND a.status = 'open'
    AND NOT EXISTS (
      SELECT 1 FROM open_notifications n
      WHERE n.kind = 'bid' AND n.open_bid_id = b.id
    );
$$;

-- ============================================================================
-- 4. EXECUTE GRANTS
-- ============================================================================
-- Both functions are read-only, but they are SECURITY DEFINER, which is enough
-- to require the same treatment every other open_* definer function gets:
-- `anon` and `authenticated` hold a DIRECT grant on every new function in the
-- public schema (Supabase ships an ALTER DEFAULT PRIVILEGES for it), so
-- revoking from PUBLIC alone leaves them callable. Name the roles.
--
-- Check, the same query as for the mutating ones:
--   SELECT p.proname, array_to_string(p.proacl, ', ') AS grants
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.proname LIKE 'open\_notify\_%';

REVOKE ALL ON FUNCTION open_notify_turn_candidates() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION open_notify_bid_events()      FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION open_notify_turn_candidates() TO service_role;
GRANT EXECUTE ON FUNCTION open_notify_bid_events()      TO service_role;

-- ============================================================================
-- 5. BASELINE
-- ============================================================================
-- Claim everything that is already true, so switching the feature on does not
-- fire a backlog at a league that is mid-draft. Written out here rather than
-- through the two functions above, deliberately: those filter on
-- open_within_hours(), and applying this at night would leave the whole night's
-- state unclaimed and blast it at draft_start_hour.
--
-- ⚠️ Re-running the migration re-baselines: anything pending at that moment is
-- marked as sent and will not go out. That is what a baseline means, but do not
-- re-run it casually mid-draft.

INSERT INTO open_notifications (league_id, kind, team_id, turn_rank, sent_at, recipients)
SELECT t.league_id, 'turn', t.id, t.priority_rank, NOW(), 0
FROM teams t
JOIN leagues l ON l.id = t.league_id
WHERE l.draft_type = 'open'
  AND l.status IN ('active', 'paused')
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
ON CONFLICT DO NOTHING;

INSERT INTO open_notifications (league_id, kind, open_bid_id, sent_at, recipients)
SELECT a.league_id, 'bid', b.id, NOW(), 0
FROM open_auctions a
JOIN leagues l ON l.id = a.league_id
JOIN LATERAL (
  SELECT ob.id
  FROM open_bids ob
  WHERE ob.open_auction_id = a.id
  ORDER BY ob.created_at DESC, ob.id DESC
  LIMIT 1
) b ON TRUE
WHERE l.draft_type = 'open'
  AND a.status = 'open'
ON CONFLICT DO NOTHING;

-- Verify (changes nothing). Both must come back empty right after applying:
--   SELECT * FROM open_notify_turn_candidates();
--   SELECT * FROM open_notify_bid_events();
--   SELECT kind, count(*) FROM open_notifications GROUP BY kind;
