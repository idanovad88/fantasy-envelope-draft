-- Overpayment ("פראייר הדראפט") aggregation, moved into Postgres.
-- Run in the Supabase SQL Editor. Additive only — safe on a live DB.
--
-- Why: the dashboard used to fetch every bid of every completed auction and
-- re-derive the second-highest bid in JS, on every render, for every viewer.
-- The live league is past 1000 bids, so that read also had to be paginated
-- (PostgREST caps a response at 1000 rows) — several round trips and a
-- 1000+ row JSON parse per dashboard load. This returns one row per winning
-- team instead.
--
-- SECURITY INVOKER (the default) on purpose: RLS still applies, so the
-- function sees exactly the bids the caller could already read for itself.
-- Making it DEFINER would widen access to sealed bids on *open* auctions.

CREATE OR REPLACE FUNCTION league_overpayment(p_league_id UUID)
RETURNS TABLE (team_id UUID, overpay INTEGER)
LANGUAGE sql
STABLE
AS $$
  SELECT a.winning_team_id,
         SUM(a.winning_bid - COALESCE(o.second_highest, 0))::INTEGER
  FROM auctions a
  -- Second highest = the top bid from any team other than the winner, and 0
  -- when nobody else bid — matching what the dashboard computed in JS.
  LEFT JOIN LATERAL (
    SELECT MAX(b.amount) AS second_highest
    FROM bids b
    WHERE b.auction_id = a.id
      AND b.team_id <> a.winning_team_id
  ) o ON TRUE
  WHERE a.league_id = p_league_id
    AND a.status = 'completed'
    AND a.winning_team_id IS NOT NULL
    -- Only auctions the winner actually overpaid on contribute, exactly as
    -- the `diff > 0` guard did. A win at the second-highest bid scores 0.
    AND a.winning_bid > COALESCE(o.second_highest, 0)
  GROUP BY a.winning_team_id;
$$;

GRANT EXECUTE ON FUNCTION league_overpayment(UUID) TO anon, authenticated;

-- The lateral subquery keys on bids(auction_id), already covered by the
-- UNIQUE (auction_id, team_id) index. This one is for the outer scan.
CREATE INDEX IF NOT EXISTS idx_auctions_league_status ON auctions(league_id, status);
