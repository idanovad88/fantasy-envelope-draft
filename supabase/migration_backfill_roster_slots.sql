-- Backfill roster_slot for players drafted before assign_roster_slot was introduced.
-- Safe to run multiple times (only processes players where roster_slot IS NULL).
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT p.id, p.drafted_by_team_id, p.league_id
    FROM players p
    WHERE p.status = 'drafted'
      AND p.roster_slot IS NULL
      AND p.drafted_by_team_id IS NOT NULL
      AND p.league_id IS NOT NULL
  LOOP
    PERFORM assign_roster_slot(r.id, r.drafted_by_team_id, r.league_id);
  END LOOP;
END;
$$;
