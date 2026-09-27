-- Trades during an auction draft (envelope + open outcry).
--
-- Player-for-player trades, count-neutral, with an optional cash component
-- from either side. Flow is the snake one: propose → target accepts →
-- league admin approves → execute_auction_trade().
--
-- Run BEFORE deploying: save-league sends auction_trades_enabled, and a
-- missing column makes PostgREST reject the whole league-settings save.
-- Idempotent.

-- ── Columns ──────────────────────────────────────────────────────────────
ALTER TABLE leagues
  ADD COLUMN IF NOT EXISTS auction_trades_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS cash_from_team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS cash_amount INTEGER NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE trades ADD CONSTRAINT trades_cash_check
    CHECK (cash_amount >= 0 AND (cash_amount = 0 OR cash_from_team_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- What was paid at auction stays paid: a traded player's draft_price moves
-- with his row, so refresh_team_stats() would otherwise charge the receiving
-- team for him. budget_adjustment absorbs that difference, plus any cash.
ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS budget_adjustment INTEGER NOT NULL DEFAULT 0;

-- ── refresh_team_stats: honour budget_adjustment ─────────────────────────
CREATE OR REPLACE FUNCTION public.refresh_team_stats(p_team_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_league_id UUID;
  v_players_per_team INTEGER;
  v_budget_per_team INTEGER;
  v_adjustment INTEGER;
  v_spent INTEGER;
  v_count INTEGER;
BEGIN
  SELECT t.league_id, l.players_per_team, l.budget_per_team, t.budget_adjustment
  INTO v_league_id, v_players_per_team, v_budget_per_team, v_adjustment
  FROM teams t JOIN leagues l ON l.id = t.league_id
  WHERE t.id = p_team_id;

  SELECT COALESCE(SUM(draft_price), 0), COUNT(*)
  INTO v_spent, v_count
  FROM players
  WHERE drafted_by_team_id = p_team_id AND status = 'drafted';

  UPDATE teams SET
    budget_remaining = v_budget_per_team + COALESCE(v_adjustment, 0) - v_spent,
    player_count = v_count,
    is_complete = (v_count >= v_players_per_team),
    updated_at = NOW()
  WHERE id = p_team_id;
END;
$function$;

-- ── The budget a team must keep after a trade ────────────────────────────
-- $1 per empty roster slot, plus what its live bids already commit.
--   envelope: its highest bid on an active/pending auction must stay biddable
--   open:     every auction it leads, at the current price
-- p_include_sealed = FALSE skips sealed envelope bids, so checking the OTHER
-- team at proposal time cannot be used to probe its bid.
CREATE OR REPLACE FUNCTION public.auction_trade_budget_floor(p_team_id uuid, p_include_sealed boolean DEFAULT TRUE)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  v_league_id UUID; v_type TEXT; v_ppt INTEGER; v_count INTEGER;
  v_slots INTEGER; v_live INTEGER; v_sum INTEGER; v_leading INTEGER;
BEGIN
  SELECT t.league_id, l.draft_type, l.players_per_team, t.player_count
  INTO v_league_id, v_type, v_ppt, v_count
  FROM teams t JOIN leagues l ON l.id = t.league_id WHERE t.id = p_team_id;
  IF v_league_id IS NULL THEN RETURN 0; END IF;

  v_slots := GREATEST(v_ppt - COALESCE(v_count, 0), 0);
  IF v_slots = 0 THEN RETURN 0; END IF;

  IF v_type = 'open' THEN
    SELECT COALESCE(SUM(current_price), 0), COUNT(*) INTO v_sum, v_leading
    FROM open_auctions
    WHERE leader_team_id = p_team_id AND league_id = v_league_id AND status = 'open';
    RETURN v_sum + GREATEST(v_slots - v_leading, 0);
  END IF;

  IF v_type = 'envelope' AND p_include_sealed THEN
    SELECT COALESCE(MAX(b.amount), 0) INTO v_live
    FROM bids b JOIN auctions a ON a.id = b.auction_id
    WHERE b.team_id = p_team_id AND a.league_id = v_league_id
      AND a.status IN ('active', 'pending');
    IF v_live > 0 THEN RETURN GREATEST(v_slots, v_slots - 1 + v_live); END IF;
  END IF;

  RETURN v_slots;
END;
$function$;

-- ── Execute an approved auction trade ────────────────────────────────────
-- The authoritative check. Everything the API validated is re-checked here
-- under row locks, since state can move between accept and approve.
CREATE OR REPLACE FUNCTION public.execute_auction_trade(p_trade_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_trade   RECORD;
  v_league  RECORD;
  v_asset   RECORD;
  v_team    UUID;
  v_other   UUID;
  v_given   INTEGER;
  v_recv    INTEGER;
  v_cash    INTEGER;
  v_budget  INTEGER;
  v_floor   INTEGER;
  v_name    TEXT;
  v_from_p  INTEGER;
  v_from_t  INTEGER;
  v_player_ids UUID[];
BEGIN
  SELECT * INTO v_trade FROM trades WHERE id = p_trade_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'הטרייד לא נמצא'; END IF;
  IF v_trade.status <> 'pending_admin' THEN
    RAISE EXCEPTION 'הטרייד אינו ממתין לאישור מנהל';
  END IF;

  SELECT * INTO v_league FROM leagues WHERE id = v_trade.league_id;
  IF v_league.draft_type NOT IN ('envelope', 'open') THEN
    RAISE EXCEPTION 'ליגה זו אינה דראפט אוקשן';
  END IF;
  IF NOT v_league.auction_trades_enabled THEN
    RAISE EXCEPTION 'טריידים כבויים בליגה זו';
  END IF;
  IF v_league.status NOT IN ('active', 'paused') THEN
    RAISE EXCEPTION 'טריידים אפשריים רק בזמן הדראפט';
  END IF;

  -- Lock both teams in a fixed order so two trades cannot deadlock.
  PERFORM 1 FROM teams
  WHERE id IN (v_trade.proposing_team_id, v_trade.target_team_id)
  ORDER BY id FOR UPDATE;

  IF EXISTS (SELECT 1 FROM trade_assets WHERE trade_id = p_trade_id AND asset_type <> 'player') THEN
    RAISE EXCEPTION 'בטרייד אוקשן אפשר להעביר רק שחקנים';
  END IF;

  SELECT COUNT(*) FILTER (WHERE from_team_id = v_trade.proposing_team_id),
         COUNT(*) FILTER (WHERE from_team_id = v_trade.target_team_id)
  INTO v_from_p, v_from_t
  FROM trade_assets WHERE trade_id = p_trade_id;
  IF v_from_p = 0 OR v_from_p <> v_from_t THEN
    RAISE EXCEPTION 'כל צד חייב לתת אותו מספר שחקנים';
  END IF;

  -- Every player must still be drafted by the team giving him.
  FOR v_asset IN
    SELECT ta.player_id, ta.from_team_id, p.name, p.status, p.drafted_by_team_id
    FROM trade_assets ta JOIN players p ON p.id = ta.player_id
    WHERE ta.trade_id = p_trade_id
    FOR UPDATE OF p
  LOOP
    IF v_asset.status <> 'drafted' OR v_asset.drafted_by_team_id IS DISTINCT FROM v_asset.from_team_id THEN
      RAISE EXCEPTION '% כבר אינו שייך לקבוצה שמוסרת אותו', v_asset.name;
    END IF;
  END LOOP;

  -- Budget check for each side, before anything moves. Players move
  -- count-neutral and budget-neutral, so only the cash changes a budget.
  FOREACH v_team IN ARRAY ARRAY[v_trade.proposing_team_id, v_trade.target_team_id] LOOP
    v_cash := CASE
      WHEN v_trade.cash_amount = 0 THEN 0
      WHEN v_trade.cash_from_team_id = v_team THEN -v_trade.cash_amount
      ELSE v_trade.cash_amount END;
    SELECT budget_remaining, name INTO v_budget, v_name FROM teams WHERE id = v_team;
    v_floor := auction_trade_budget_floor(v_team, TRUE);
    IF v_budget + v_cash < v_floor THEN
      RAISE EXCEPTION 'לקבוצה % לא יישאר מספיק תקציב ($% אחרי הטרייד, צריך לפחות $%)',
        v_name, v_budget + v_cash, v_floor;
    END IF;
  END LOOP;

  -- Budget bookkeeping: keep each team's spend where it was, then apply cash.
  FOREACH v_team IN ARRAY ARRAY[v_trade.proposing_team_id, v_trade.target_team_id] LOOP
    SELECT COALESCE(SUM(p.draft_price) FILTER (WHERE ta.from_team_id = v_team), 0),
           COALESCE(SUM(p.draft_price) FILTER (WHERE ta.from_team_id <> v_team), 0)
    INTO v_given, v_recv
    FROM trade_assets ta JOIN players p ON p.id = ta.player_id
    WHERE ta.trade_id = p_trade_id;

    v_cash := CASE
      WHEN v_trade.cash_amount = 0 THEN 0
      WHEN v_trade.cash_from_team_id = v_team THEN -v_trade.cash_amount
      ELSE v_trade.cash_amount END;

    UPDATE teams
    SET budget_adjustment = budget_adjustment + (v_recv - v_given) + v_cash
    WHERE id = v_team;
  END LOOP;

  -- Phase 1: move every player and clear his slot, so departures free slots first.
  FOR v_asset IN SELECT * FROM trade_assets WHERE trade_id = p_trade_id LOOP
    v_other := CASE WHEN v_asset.from_team_id = v_trade.proposing_team_id
                    THEN v_trade.target_team_id ELSE v_trade.proposing_team_id END;
    UPDATE players SET drafted_by_team_id = v_other, roster_slot = NULL
    WHERE id = v_asset.player_id;
  END LOOP;

  -- Phase 2: best available slot on the new team.
  FOR v_asset IN SELECT * FROM trade_assets WHERE trade_id = p_trade_id LOOP
    v_other := CASE WHEN v_asset.from_team_id = v_trade.proposing_team_id
                    THEN v_trade.target_team_id ELSE v_trade.proposing_team_id END;
    PERFORM assign_roster_slot(v_asset.player_id, v_other, v_trade.league_id);
  END LOOP;

  PERFORM refresh_team_stats(v_trade.proposing_team_id);
  PERFORM refresh_team_stats(v_trade.target_team_id);

  UPDATE trades SET status = 'approved', admin_responded_at = NOW()
  WHERE id = p_trade_id;

  -- Any other open offer that includes one of these players is now void.
  SELECT array_agg(player_id) INTO v_player_ids FROM trade_assets WHERE trade_id = p_trade_id;
  UPDATE trades SET status = 'cancelled',
                    rejection_reason = 'אחד השחקנים כבר הועבר בטרייד אחר'
  WHERE league_id = v_trade.league_id
    AND id <> p_trade_id
    AND status IN ('pending_target', 'pending_admin')
    AND EXISTS (SELECT 1 FROM trade_assets ta
                WHERE ta.trade_id = trades.id AND ta.player_id = ANY (v_player_ids));
END;
$function$;

-- ── Undo must not refund a player that has since been traded ─────────────
-- With the player on another team, refresh_team_stats() would hand his
-- price back to the team that holds him, not the one that paid.
CREATE OR REPLACE FUNCTION public.open_undo_auction(p_auction_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_league_id UUID; v_player_id UUID; v_winner UUID; v_status TEXT;
  v_holder UUID; r RECORD;
  v_approved INTEGER; v_complete INTEGER;
BEGIN
  SELECT league_id, player_id, winning_team_id, status
  INTO v_league_id, v_player_id, v_winner, v_status
  FROM open_auctions WHERE id = p_auction_id FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'המכרז לא נמצא'; END IF;
  IF v_status = 'cancelled' THEN RAISE EXCEPTION 'המכרז כבר בוטל'; END IF;
  IF v_status <> 'completed' THEN
    RAISE EXCEPTION 'המכרז עדיין פתוח — השתמש בביטול מכרז פתוח';
  END IF;

  SELECT drafted_by_team_id INTO v_holder FROM players WHERE id = v_player_id;

  IF v_holder IS NOT NULL AND v_winner IS NOT NULL AND v_holder <> v_winner THEN
    RAISE EXCEPTION 'השחקן הועבר בטרייד — לא ניתן לבטל את המכרז';
  END IF;

  UPDATE players SET
    status = 'available',
    drafted_by_team_id = NULL,
    draft_price = NULL,
    roster_slot = NULL
  WHERE id = v_player_id;

  DELETE FROM open_bids   WHERE open_auction_id = p_auction_id;
  DELETE FROM open_passes WHERE open_auction_id = p_auction_id;

  UPDATE open_auctions SET
    status = 'cancelled',
    closed_reason = 'cancelled',
    leader_team_id = NULL,
    winning_team_id = NULL,
    winning_bid = NULL,
    updated_at = NOW()
  WHERE id = p_auction_id;

  IF v_winner IS NOT NULL THEN PERFORM refresh_team_stats(v_winner); END IF;
  IF v_holder IS NOT NULL AND v_holder IS DISTINCT FROM v_winner THEN
    PERFORM refresh_team_stats(v_holder);
  END IF;

  FOR r IN
    SELECT DISTINCT p.open_auction_id AS id
    FROM open_passes p
    JOIN open_auctions a ON a.id = p.open_auction_id
    WHERE p.team_id IN (v_winner, v_holder)
      AND p.reason IN ('complete', 'no_budget')
      AND a.status = 'open'
      AND a.league_id = v_league_id
  LOOP
    DELETE FROM open_passes
    WHERE open_auction_id = r.id
      AND team_id IN (v_winner, v_holder)
      AND reason IN ('complete', 'no_budget');

    UPDATE open_auctions SET updated_at = NOW() WHERE id = r.id;
    PERFORM open_settle_auction(r.id);
  END LOOP;

  SELECT COUNT(*) FILTER (WHERE approved),
         COUNT(*) FILTER (WHERE approved AND is_complete)
  INTO v_approved, v_complete
  FROM teams WHERE league_id = v_league_id;

  IF v_complete < v_approved THEN
    UPDATE leagues SET status = 'active', updated_at = NOW()
    WHERE id = v_league_id AND status = 'completed';
  END IF;
END;
$function$;

-- ── Grants ───────────────────────────────────────────────────────────────
-- SECURITY DEFINER functions: revoke from anon/authenticated BY NAME —
-- Supabase's default privileges grant them directly, so PUBLIC is not enough.
-- execute_trade (snake) was callable with the anon key until now, which let
-- anyone execute a trade still awaiting the admin.
REVOKE EXECUTE ON FUNCTION public.execute_auction_trade(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.execute_trade(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.refresh_team_stats(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.auction_trade_budget_floor(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.open_undo_auction(uuid) FROM PUBLIC, anon, authenticated;

-- ── RLS: open offers are private ─────────────────────────────────────────
-- An approved trade is public; anything else is visible only to the two
-- teams (owner or assistant) and the league's admins. Applies to snake too.
DROP POLICY IF EXISTS trades_select ON trades;
CREATE POLICY trades_select ON trades FOR SELECT USING (
  status = 'approved'
  OR EXISTS (SELECT 1 FROM teams t
             WHERE t.id IN (trades.proposing_team_id, trades.target_team_id)
               AND auth.uid() IN (t.user_id, t.assistant_user_id))
  OR EXISTS (SELECT 1 FROM admin_users a
             WHERE a.user_id = auth.uid() AND a.league_id = trades.league_id)
  OR EXISTS (SELECT 1 FROM leagues l
             WHERE l.id = trades.league_id AND l.created_by = auth.uid())
);

DROP POLICY IF EXISTS trade_assets_select ON trade_assets;
CREATE POLICY trade_assets_select ON trade_assets FOR SELECT USING (
  EXISTS (SELECT 1 FROM trades tr WHERE tr.id = trade_assets.trade_id)
);
