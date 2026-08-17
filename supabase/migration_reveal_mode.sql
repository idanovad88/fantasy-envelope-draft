-- Reveal mode migration (envelope only)
-- Adds reveal_mode to leagues: order in which sealed bids animate in on reveal.
--   'random'   = uniform shuffle (existing behavior, default)
--   'weighted' = probability of being revealed last is proportional to amount^4
-- Run in the Supabase SQL Editor. Additive only — safe on a live DB.
-- Apply BEFORE deploying: saveLeague() sends reveal_mode, and a missing column
-- makes PostgREST reject the entire league-settings save.

ALTER TABLE leagues
  ADD COLUMN IF NOT EXISTS reveal_mode TEXT NOT NULL DEFAULT 'random'
    CHECK (reveal_mode IN ('random', 'weighted'));
