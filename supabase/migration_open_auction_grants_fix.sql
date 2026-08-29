-- Follow-up to migration_open_auction_draft.sql — SECURITY FIX.
--
-- Touches ONLY the open-outcry functions (every name below starts with open_).
-- It creates nothing, drops nothing, and does not reference `auctions`, `bids`,
-- `teams`, `players`, `resolve_auction` or any envelope/snake object.
--
-- WHY
-- ---
-- The mutating open_* functions are SECURITY DEFINER, so whoever may execute
-- them acts as the owner. The original migration revoked EXECUTE from PUBLIC,
-- which on Supabase is not enough: `anon` and `authenticated` hold a *direct*
-- grant on every new function in the public schema (Supabase ships an
-- ALTER DEFAULT PRIVILEGES that grants it), and revoking from PUBLIC leaves
-- that direct grant in place.
--
-- Verified against this database with the anon key: open_place_bid, open_pass,
-- open_nominate, open_close_auction, open_cancel_auction, open_set_pause and
-- open_draft_tick_all were all callable without a session — i.e. anyone could
-- bid as another team, pass on someone's behalf, or pause a draft.
--
-- Idempotent.

REVOKE ALL ON FUNCTION open_nominate(UUID, UUID, UUID)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION open_place_bid(UUID, UUID, INTEGER)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION open_pass(UUID, UUID, TEXT)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION open_close_auction(UUID, TEXT)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION open_settle_auction(UUID)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION open_cancel_auction(UUID)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION open_set_pause(UUID, BOOLEAN)        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION open_draft_tick(UUID)                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION open_draft_tick_all()                FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION open_nominate(UUID, UUID, UUID)      TO service_role;
GRANT EXECUTE ON FUNCTION open_place_bid(UUID, UUID, INTEGER)  TO service_role;
GRANT EXECUTE ON FUNCTION open_pass(UUID, UUID, TEXT)          TO service_role;
GRANT EXECUTE ON FUNCTION open_close_auction(UUID, TEXT)       TO service_role;
GRANT EXECUTE ON FUNCTION open_settle_auction(UUID)            TO service_role;
GRANT EXECUTE ON FUNCTION open_cancel_auction(UUID)            TO service_role;
GRANT EXECUTE ON FUNCTION open_set_pause(UUID, BOOLEAN)        TO service_role;
GRANT EXECUTE ON FUNCTION open_draft_tick(UUID)                TO service_role;
GRANT EXECUTE ON FUNCTION open_draft_tick_all()                TO service_role;

-- Verify (changes nothing) — every row should show only postgres/service_role:
--   SELECT p.proname, array_to_string(p.proacl, ', ') AS grants
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.proname LIKE 'open\_%' ORDER BY p.proname;
