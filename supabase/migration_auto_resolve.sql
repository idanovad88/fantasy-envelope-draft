-- Auto-resolve expired auctions via pg_cron
-- Run this in your Supabase SQL Editor

-- Enable pg_cron extension (requires Supabase Pro or enabling via Dashboard → Extensions)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Grant usage to postgres role (required by pg_cron)
GRANT USAGE ON SCHEMA cron TO postgres;

-- Function: resolve all active auctions whose reveal_time has passed
CREATE OR REPLACE FUNCTION auto_resolve_expired_auctions()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_auction_id UUID;
BEGIN
  FOR v_auction_id IN
    SELECT id
    FROM auctions
    WHERE status = 'active'
      AND reveal_time <= NOW()
  LOOP
    BEGIN
      PERFORM resolve_auction(v_auction_id);
    EXCEPTION WHEN OTHERS THEN
      -- Log error but continue processing remaining auctions
      RAISE WARNING 'auto_resolve_expired_auctions: failed for auction % — %', v_auction_id, SQLERRM;
    END;
  END LOOP;
END;
$$;

-- Schedule: run every minute
SELECT cron.schedule(
  'auto-resolve-expired-auctions',   -- job name (unique)
  '* * * * *',                        -- every minute
  'SELECT auto_resolve_expired_auctions()'
);
