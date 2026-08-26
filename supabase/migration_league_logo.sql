-- League logo migration
-- Adds logo_url to leagues: a public URL in the `draft-media` storage bucket
-- (path `league-logos/<leagueId>`), uploaded from Admin → הגדרות ליגה.
-- Shown in the "my leagues" list and at the top of the sidebar navbar.
-- Run in the Supabase SQL Editor. Additive only — safe on a live DB.
-- Apply BEFORE deploying: /api/admin/upload-league-logo writes this column,
-- and a missing column makes PostgREST reject the write.

ALTER TABLE leagues
  ADD COLUMN IF NOT EXISTS logo_url TEXT;
