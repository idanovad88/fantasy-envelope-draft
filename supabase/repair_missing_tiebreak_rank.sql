-- Repair: put "אדם" back into the tiebreak order of
-- "דראפט המעטפות הרשמי של ישראל" (league b882107d-721b-4101-a934-ea31c1072253).
--
-- WHY THIS IS NEEDED
-- ------------------
-- migration_completed_teams_keep_rank.sql backfilled priority_rank for teams the
-- old helper had removed, but it assumed tiebreak_rank was never NULLed. In this
-- league it was: אדם filled its roster and ended up with tiebreak_rank IS NULL,
-- so the migration's renumber (which only touches rows WHERE tiebreak_rank IS
-- NOT NULL) skipped it and it is still missing from "סדר פריוריטי".
--
-- WHERE IT BELONGS — derived from priority_log, not guessed
-- ---------------------------------------------------------
-- Last tiebreak value of every team before the migration renumbered the league
-- (from each team's most recent 'tiebreak_demotion' row; teams never demoted
-- kept their lottery rank and sorted above all of them):
--
--     אמיתי  Zabary Keves          (never demoted)
--     20  Shai-Me the Money
--     21  Shpitzer
--     25  Mr. Crossover
--     26  אדם            <-- 2026-08-09 07:00, '15 -> 26'
--     27  שלוקלוקר
--     28  גולדסטאר ג'ון
--     29  Talmon
--     30  עובדיה
--     31  Embid MVP
--     32  Dikman's Father
--
-- Renumbered that is 1..12 with אדם at 6 — and positions 1-5 and 7-12 match the
-- league's current 1..11 exactly, which is what confirms the reconstruction.
-- So: everything from 6 down shifts one place, אדם takes 6.
--
-- Idempotent: if אדם already has a tiebreak_rank the CTE is empty, the shift
-- matches league_id = NULL, and nothing is updated.

WITH target AS (
  SELECT t.id, t.league_id
  FROM teams t
  WHERE t.league_id = 'b882107d-721b-4101-a934-ea31c1072253'
    AND t.name = 'אדם'
    AND t.tiebreak_rank IS NULL
),
shifted AS (
  UPDATE teams
  SET tiebreak_rank = tiebreak_rank + 1, updated_at = NOW()
  WHERE league_id = (SELECT league_id FROM target)
    AND tiebreak_rank >= 6
  RETURNING id
)
UPDATE teams
SET tiebreak_rank = 6, updated_at = NOW()
WHERE id = (SELECT id FROM target);

-- Verify — expect a gap-free 1..12 with אדם at 6 and is_complete = true:
--   SELECT name, tiebreak_rank, is_complete
--   FROM teams
--   WHERE league_id = 'b882107d-721b-4101-a934-ea31c1072253' AND approved
--   ORDER BY tiebreak_rank;
