-- Migration: add draft_start_time to leagues
-- Run in Supabase SQL Editor

ALTER TABLE leagues ADD COLUMN IF NOT EXISTS draft_start_time TIMESTAMPTZ;
