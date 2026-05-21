-- Add join_code to leagues
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS join_code TEXT UNIQUE;

-- Allow anyone to read league name + join_code (for the join page)
-- Existing policy covers this already via "leagues_read"
