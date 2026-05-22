-- Add auction_duration_hours to leagues
-- Replaces the implicit duration (nomination_interval_hours - reveal_before_minutes)
-- with an explicit configurable field. Default 1.5 hours = 90 minutes.

ALTER TABLE leagues
  ADD COLUMN IF NOT EXISTS auction_duration_hours DECIMAL(4,2) NOT NULL DEFAULT 1.5;
