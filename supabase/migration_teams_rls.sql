-- Fix: allow authenticated users to insert their own team when joining a league
-- Run in Supabase SQL Editor

CREATE POLICY "teams_user_join" ON teams FOR INSERT
  WITH CHECK (auth.uid() = user_id);
