-- ============================================================
-- Minimum bid of $2 for every team except the nominator
-- ============================================================
-- The team that put the player up for auction can still win him at $1 (that is
-- exactly what its mandatory $1 auto-bid, trg_auto_bid_nominating_team, is).
-- Every other team must pay at least $2 to take a player it did not nominate.
--
-- Enforced with a trigger rather than a CHECK constraint because the rule
-- depends on auctions.nominating_team_id, not on the bid row alone. It has to
-- live in the DB: BidForm upserts into `bids` straight from the browser client
-- under RLS, so client-side validation alone is trivially bypassable.
--
-- Idempotent. Existing $1 bids are left untouched; they are only re-checked if
-- someone updates them.

CREATE OR REPLACE FUNCTION enforce_min_bid()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_nominating_team_id UUID;
BEGIN
  IF NEW.amount < 1 THEN
    RAISE EXCEPTION 'הצעה חייבת להיות לפחות $1';
  END IF;

  IF NEW.amount = 1 THEN
    SELECT nominating_team_id INTO v_nominating_team_id
    FROM auctions WHERE id = NEW.auction_id;

    IF v_nominating_team_id IS DISTINCT FROM NEW.team_id THEN
      RAISE EXCEPTION 'המינימום הוא $2 — רק הקבוצה שהעלתה את השחקן יכולה לזכות בו ב-$1';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_min_bid ON bids;
CREATE TRIGGER trg_enforce_min_bid
  BEFORE INSERT OR UPDATE ON bids
  FOR EACH ROW EXECUTE FUNCTION enforce_min_bid();
