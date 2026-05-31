-- Migration: Auto-insert $1 bid for nominating team via trigger
-- The AdminPanel inserts auctions directly (bypassing /api/nominate),
-- so the auto-bid must be handled at the DB level to work for all insertion paths.

CREATE OR REPLACE FUNCTION auto_bid_nominating_team()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.nominating_team_id IS NOT NULL THEN
    INSERT INTO bids (auction_id, team_id, amount)
    VALUES (NEW.id, NEW.nominating_team_id, 1)
    ON CONFLICT (auction_id, team_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_bid_nominating_team ON auctions;
CREATE TRIGGER trg_auto_bid_nominating_team
  AFTER INSERT ON auctions
  FOR EACH ROW EXECUTE FUNCTION auto_bid_nominating_team();
