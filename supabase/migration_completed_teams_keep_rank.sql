-- Migration: a completed team keeps its place in BOTH envelope orders
--
-- Requested behaviour (envelope drafts):
--   * A team that filled its roster is no longer removed from the tiebreak
--     priority order OR from the nomination order. It stays in the list and
--     rises as the teams above it are demoted — even though it can no longer
--     win a player or take a nomination turn.
--   * The one exception is its final act: a team that wins on the tiebreak and
--     completes its roster in that same auction still pays for that win and
--     drops to the bottom one last time. It starts climbing from there.
--
-- WHAT WAS WRONG
-- --------------
-- 1. remove_complete_team_from_priority() NULLed priority_rank on completion,
--    which deleted the team from the nomination order outright.
-- 2. Both demotion helpers sent a team to
--
--      MAX(rank) + 1 ... WHERE is_complete = FALSE
--
--    i.e. one past the last *incomplete* team, ignoring completed teams. With
--    completed teams now staying in the order, a demotion could land on the
--    exact rank a completed team already held — a collision. Two teams sharing
--    a rank order arbitrarily (in resolve_auction's ORDER BY, on the dashboard
--    cards, and in TeamsView), so the completed team got passed by the team
--    that was just demoted below it.
-- 3. resolve_auction() skipped the tiebreak demotion when the winner had just
--    become complete (`AND is_complete = FALSE`), so a team could win its last
--    player on the tiebreak and pay nothing for it.
--
-- Idempotent: CREATE OR REPLACE throughout, plus one-time backfills that are
-- no-ops once the orders are already restored and gap-free.
-- Snake leagues are untouched — priority_rank is their stored pick order.

-- ── 1. Nomination rotation — bottom of the order, completed teams included ───
CREATE OR REPLACE FUNCTION demote_nomination_rank(p_team_id UUID, p_league_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_max_rank INTEGER;
BEGIN
  -- No is_complete filter: completed teams stay in the order, so the demoted
  -- team has to go below them as well or the two collide on the same rank.
  SELECT MAX(priority_rank) INTO v_max_rank
  FROM teams WHERE league_id = p_league_id AND priority_rank IS NOT NULL;

  INSERT INTO priority_log(league_id, team_id, old_rank, new_rank, reason)
  SELECT p_league_id, p_team_id, priority_rank, v_max_rank + 1, 'nomination_rotation'
  FROM teams WHERE id = p_team_id;

  UPDATE teams SET priority_rank = v_max_rank + 1, updated_at = NOW() WHERE id = p_team_id;
END;
$$;

-- ── 2. Tiebreak demotion — same rule ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION demote_tiebreak_rank(p_team_id UUID, p_league_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_max_rank INTEGER;
BEGIN
  SELECT MAX(tiebreak_rank) INTO v_max_rank
  FROM teams WHERE league_id = p_league_id AND tiebreak_rank IS NOT NULL;

  INSERT INTO priority_log(league_id, team_id, old_rank, new_rank, reason)
  SELECT p_league_id, p_team_id, tiebreak_rank, v_max_rank + 1, 'tiebreak_demotion'
  FROM teams WHERE id = p_team_id;

  UPDATE teams SET tiebreak_rank = v_max_rank + 1, updated_at = NOW() WHERE id = p_team_id;
END;
$$;

-- ── 3. Completing a roster no longer drops the team out of the order ─────────
-- Neutered rather than deleted: resolve_auction() bodies in the wild still call
-- it, and the app's nomination order now filters ineligible teams itself.
CREATE OR REPLACE FUNCTION remove_complete_team_from_priority(p_team_id UUID, p_league_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- Intentionally does nothing. A completed team keeps its priority_rank so it
  -- stays visible in the nomination order and rises as others are demoted;
  -- getEnvelopeNominationOrder() in lib/utils.ts is what stops it taking a turn.
  RETURN;
END;
$$;

-- ── 4. resolve_auction ───────────────────────────────────────────────────────
-- Identical to migration_fix_nomination_rotation.sql except: the two
-- remove_complete_team_from_priority() calls are gone, and the tiebreak penalty
-- no longer exempts a winner that completed its roster on that same win.
CREATE OR REPLACE FUNCTION resolve_auction(p_auction_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_league_id          UUID;
  v_player_id          UUID;
  v_nominating_team_id UUID;
  v_max_bid            INTEGER;
  v_winning_team_id    UUID;
  v_tie_count          INTEGER;
  v_tie_broken         BOOLEAN := FALSE;
BEGIN
  SELECT league_id, player_id, nominating_team_id
  INTO   v_league_id, v_player_id, v_nominating_team_id
  FROM   auctions WHERE id = p_auction_id;

  -- Highest bid among teams still eligible to draft. Completed teams are
  -- excluded here exactly as in the winner selection below — the two filters
  -- must agree or the winner comes out NULL.
  SELECT MAX(b.amount) INTO v_max_bid
  FROM   bids b JOIN teams t ON t.id = b.team_id
  WHERE  b.auction_id = p_auction_id AND b.amount >= 1 AND t.is_complete = FALSE;

  IF v_max_bid IS NULL THEN
    -- No valid bids — player returns to the pool, nomination turn still rotates
    UPDATE auctions SET status = 'completed', updated_at = NOW() WHERE id = p_auction_id;
    UPDATE players  SET status = 'available'                         WHERE id = v_player_id;
    IF v_nominating_team_id IS NOT NULL THEN
      PERFORM demote_nomination_rank(v_nominating_team_id, v_league_id);
    END IF;
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_tie_count
  FROM bids b JOIN teams t ON t.id = b.team_id
  WHERE b.auction_id = p_auction_id AND b.amount = v_max_bid AND t.is_complete = FALSE;

  IF v_tie_count = 1 THEN
    SELECT b.team_id INTO v_winning_team_id
    FROM bids b JOIN teams t ON t.id = b.team_id
    WHERE b.auction_id = p_auction_id AND b.amount = v_max_bid AND t.is_complete = FALSE;
  ELSE
    -- Tie: team with the lowest tiebreak_rank (= highest priority) wins.
    -- tiebreak_rank ONLY — never fall back to priority_rank; the two orders
    -- must stay completely independent.
    v_tie_broken := TRUE;
    SELECT b.team_id INTO v_winning_team_id
    FROM bids b JOIN teams t ON t.id = b.team_id
    WHERE b.auction_id = p_auction_id AND b.amount = v_max_bid
      AND t.is_complete = FALSE
    ORDER BY t.tiebreak_rank ASC NULLS LAST
    LIMIT 1;
  END IF;

  -- Guard: never mark a player drafted without an owner.
  IF v_winning_team_id IS NULL THEN
    UPDATE auctions SET status = 'completed', updated_at = NOW() WHERE id = p_auction_id;
    UPDATE players  SET status = 'available'                         WHERE id = v_player_id;
    IF v_nominating_team_id IS NOT NULL THEN
      PERFORM demote_nomination_rank(v_nominating_team_id, v_league_id);
    END IF;
    RETURN;
  END IF;

  UPDATE players SET
    status             = 'drafted',
    drafted_by_team_id = v_winning_team_id,
    draft_price        = v_max_bid
  WHERE id = v_player_id;

  -- No-op for leagues with no roster_slots configured
  PERFORM assign_roster_slot(v_player_id, v_winning_team_id, v_league_id);

  UPDATE auctions SET
    status                 = 'completed',
    winning_team_id        = v_winning_team_id,
    winning_bid            = v_max_bid,
    tie_broken_by_priority = v_tie_broken,
    updated_at             = NOW()
  WHERE id = p_auction_id;

  PERFORM refresh_team_stats(v_winning_team_id);

  -- Nomination rotation: the nominating team goes to the bottom of
  -- priority_rank, win or lose, complete or not. Tiebreak order untouched here.
  IF v_nominating_team_id IS NOT NULL THEN
    PERFORM demote_nomination_rank(v_nominating_team_id, v_league_id);
  END IF;

  -- Tiebreak penalty: a team that won on the tiebreak drops to the bottom of
  -- tiebreak_rank. No is_complete exemption — a team that took its last player
  -- by winning a tie still pays for that win, then climbs back up from the
  -- bottom like everyone else. Nomination order untouched here.
  IF v_tie_broken THEN
    IF EXISTS (SELECT 1 FROM teams WHERE id = v_winning_team_id AND tiebreak_rank IS NOT NULL) THEN
      PERFORM demote_tiebreak_rank(v_winning_team_id, v_league_id);
    END IF;
  END IF;
END;
$$;

-- ── 5. One-time backfill: put already-removed teams back in the order ────────
-- Completed teams whose priority_rank was NULLed by the old helper. Their last
-- 'nomination_rotation' log row records the rank they held right before the
-- NULL, so they land back where they were; anything without a log row goes to
-- the bottom. Envelope leagues only — priority_rank is the stored pick order in
-- snake and must not be invented.
UPDATE teams t
SET priority_rank = COALESCE(
      (SELECT pl.new_rank FROM priority_log pl
       WHERE pl.team_id = t.id AND pl.new_rank IS NOT NULL
         AND pl.reason = 'nomination_rotation'   -- never a tiebreak row
       ORDER BY pl.created_at DESC LIMIT 1),
      (SELECT COALESCE(MAX(t2.priority_rank), 0) + 1 FROM teams t2 WHERE t2.league_id = t.league_id)
    ),
    updated_at = NOW()
FROM leagues l
WHERE l.id = t.league_id
  AND l.draft_type = 'envelope'
  AND t.approved
  AND t.is_complete
  AND t.priority_rank IS NULL
  -- only leagues whose order was actually drawn
  AND EXISTS (SELECT 1 FROM teams t3 WHERE t3.league_id = t.league_id AND t3.priority_rank IS NOT NULL);

-- ── 6. One-time renumber: gap-free 1..N, collisions resolved ─────────────────
-- On a tie the completed team keeps the better slot: it was never demoted, the
-- team sharing its rank was. Envelope leagues only.
WITH ranked AS (
  SELECT t.id,
         ROW_NUMBER() OVER (
           PARTITION BY t.league_id
           ORDER BY t.priority_rank ASC, t.is_complete DESC, t.created_at ASC
         ) AS new_rank
  FROM teams t JOIN leagues l ON l.id = t.league_id
  WHERE l.draft_type = 'envelope' AND t.priority_rank IS NOT NULL
)
UPDATE teams t SET priority_rank = r.new_rank, updated_at = NOW()
FROM ranked r WHERE t.id = r.id AND t.priority_rank IS DISTINCT FROM r.new_rank;

WITH ranked AS (
  SELECT t.id,
         ROW_NUMBER() OVER (
           PARTITION BY t.league_id
           ORDER BY t.tiebreak_rank ASC, t.is_complete DESC, t.created_at ASC
         ) AS new_rank
  FROM teams t JOIN leagues l ON l.id = t.league_id
  WHERE l.draft_type = 'envelope' AND t.tiebreak_rank IS NOT NULL
)
UPDATE teams t SET tiebreak_rank = r.new_rank, updated_at = NOW()
FROM ranked r WHERE t.id = r.id AND t.tiebreak_rank IS DISTINCT FROM r.new_rank;

-- Verify (changes nothing):
--   SELECT l.name AS league, t.name, t.priority_rank, t.tiebreak_rank, t.is_complete
--   FROM teams t JOIN leagues l ON l.id = t.league_id
--   WHERE l.draft_type = 'envelope' AND t.approved
--   ORDER BY l.name, t.priority_rank;
