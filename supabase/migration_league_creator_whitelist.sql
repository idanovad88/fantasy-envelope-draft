-- Migration: League Creator Whitelist
-- Run this in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS league_creator_whitelist (
  email TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE league_creator_whitelist ENABLE ROW LEVEL SECURITY;

-- Admins can manage all rows
CREATE POLICY "lcw_admin_all" ON league_creator_whitelist
  FOR ALL
  USING (auth.uid() IN (SELECT user_id FROM admin_users))
  WITH CHECK (auth.uid() IN (SELECT user_id FROM admin_users));

-- Users can check if their own email is whitelisted
CREATE POLICY "lcw_own_read" ON league_creator_whitelist
  FOR SELECT
  USING (email = auth.email());
