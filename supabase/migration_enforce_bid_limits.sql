-- ============================================================
-- Server-side bid limits: budget ceiling + submission deadline
-- ============================================================
-- Replaces enforce_min_bid() (migration_min_bid_two.sql) with a version that
-- also enforces the two rules that until now existed ONLY in the browser:
--
--   1. Deadline — bids were accepted for up to a minute after reveal_time.
--      The `bids` RLS policies gate on `auctions.status = 'active'`, and an
--      auction stays 'active' until the every-minute `auto-resolve-expired-
--      auctions` pg_cron tick resolves it. So a scripted bid landed fine while
--      every real user's BidForm already read "המועד להגשת הצעות עבר".
--
--   2. Budget ceiling — getMaxBid() in lib/utils.ts is client-side JS. Nothing
--      in the DB compared a bid to the team's budget, and resolve_auction()
--      simply takes MAX(amount). A single request outside the UI could bid any
--      amount, win, and push budget_remaining negative.
--
-- Both have to live in the DB: BidForm upserts into `bids` straight from the
-- browser under RLS, so there is no API route to validate in. Anyone holding a
-- session token can POST to PostgREST directly.
--
-- The budget formula mirrors getMaxBid() exactly — keep the two in sync:
--   remaining_slots = players_per_team - player_count
--   max_bid = remaining_slots <= 0 ? 0 : budget_remaining - (remaining_slots - 1)
-- i.e. $1 is reserved per slot the team still has to fill after this one.
--
-- Idempotent. Existing rows are never re-checked; the trigger only fires on
-- write, so bids already over budget (if any) stay as they are — see the audit
-- query at the bottom.

CREATE OR REPLACE FUNCTION enforce_min_bid()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_nominating_team_id UUID;
  v_reveal_time        TIMESTAMPTZ;
  v_league_id          UUID;
  v_players_per_team   INTEGER;
  v_budget             INTEGER;
  v_player_count       INTEGER;
  v_remaining_slots    INTEGER;
  v_max_bid            INTEGER;
BEGIN
  SELECT nominating_team_id, reveal_time, league_id
  INTO   v_nominating_team_id, v_reveal_time, v_league_id
  FROM   auctions WHERE id = NEW.auction_id;

  -- The nominating team's mandatory $1 auto-bid (trg_auto_bid_nominating_team)
  -- is exempt: it is inserted by the DB as part of creating the auction, and
  -- getMaxBid() already reserves that dollar. Eligibility to nominate at all is
  -- checked by canNominate() and by /api/admin/queue-auction.
  --
  -- INSERT ONLY, deliberately. If UPDATE were exempt too, a nominator that had
  -- raised its bid to $50 could drop back to $1 after the deadline — a
  -- post-deadline retreat, which is exactly what rule 1 exists to prevent.
  IF TG_OP = 'INSERT' AND NEW.amount = 1 AND v_nominating_team_id = NEW.team_id THEN
    RETURN NEW;
  END IF;

  -- ── 1. Deadline ────────────────────────────────────────────────────────────
  IF v_reveal_time IS NOT NULL AND NOW() >= v_reveal_time THEN
    RAISE EXCEPTION 'המועד להגשת הצעות עבר';
  END IF;

  -- ── 2. Minimum: $1 for the nominator, $2 for everyone else ────────────────
  IF NEW.amount < 1 THEN
    RAISE EXCEPTION 'הצעה חייבת להיות לפחות $1';
  END IF;

  IF NEW.amount = 1 AND v_nominating_team_id IS DISTINCT FROM NEW.team_id THEN
    RAISE EXCEPTION 'המינימום הוא $2 — רק הקבוצה שהעלתה את השחקן יכולה לזכות בו ב-$1';
  END IF;

  -- ── 3. Budget ceiling (mirrors getMaxBid) ─────────────────────────────────
  SELECT players_per_team INTO v_players_per_team FROM leagues WHERE id = v_league_id;
  SELECT budget_remaining, player_count INTO v_budget, v_player_count
  FROM teams WHERE id = NEW.team_id;

  IF v_players_per_team IS NOT NULL AND v_budget IS NOT NULL THEN
    v_remaining_slots := v_players_per_team - v_player_count;

    IF v_remaining_slots <= 0 THEN
      v_max_bid := 0;
    ELSE
      v_max_bid := v_budget - (v_remaining_slots - 1);
    END IF;

    IF NEW.amount > v_max_bid THEN
      RAISE EXCEPTION 'הצעה מקסימלית: $%', v_max_bid;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_min_bid ON bids;
CREATE TRIGGER trg_enforce_min_bid
  BEFORE INSERT OR UPDATE ON bids
  FOR EACH ROW EXECUTE FUNCTION enforce_min_bid();

-- ── Afterwards: did anything already slip through? ──────────────────────────
-- Changes nothing. Any row returned is a bid that exceeds what the team could
-- have afforded at the time it is read (approximate for resolved auctions,
-- since budget_remaining has moved since).
--
-- SELECT b.auction_id, t.name, b.amount,
--        CASE WHEN l.players_per_team - t.player_count <= 0 THEN 0
--             ELSE t.budget_remaining - (l.players_per_team - t.player_count - 1) END AS max_bid
-- FROM bids b
-- JOIN teams t   ON t.id = b.team_id
-- JOIN auctions a ON a.id = b.auction_id
-- JOIN leagues l ON l.id = a.league_id
-- WHERE a.status = 'active'
--   AND b.amount > CASE WHEN l.players_per_team - t.player_count <= 0 THEN 0
--                       ELSE t.budget_remaining - (l.players_per_team - t.player_count - 1) END;
