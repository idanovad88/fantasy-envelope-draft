-- Fantasy Draft App - Database Schema
-- Run this in your Supabase SQL Editor

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- LEAGUES
-- ============================================================
CREATE TABLE leagues (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  num_teams INTEGER NOT NULL DEFAULT 12,
  players_per_team INTEGER NOT NULL DEFAULT 13,
  budget_per_team INTEGER NOT NULL DEFAULT 200,
  min_bid INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'setup'
    CHECK (status IN ('setup', 'lottery', 'active', 'paused', 'completed')),
  draft_start_hour INTEGER NOT NULL DEFAULT 8,
  draft_end_hour INTEGER NOT NULL DEFAULT 22,
  nomination_interval_hours INTEGER NOT NULL DEFAULT 2,
  reveal_before_minutes INTEGER NOT NULL DEFAULT 30,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- ADMIN USERS
-- ============================================================
CREATE TABLE admin_users (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id),
  league_id UUID REFERENCES leagues(id),
  role TEXT NOT NULL DEFAULT 'admin'
    CHECK (role IN ('superadmin', 'admin')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TEAMS
-- ============================================================
CREATE TABLE teams (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  league_id UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  user_id UUID REFERENCES auth.users(id),
  budget_remaining INTEGER NOT NULL DEFAULT 200,
  player_count INTEGER NOT NULL DEFAULT 0,
  is_complete BOOLEAN NOT NULL DEFAULT FALSE,
  priority_rank INTEGER,
  tiebreak_rank INTEGER,
  approved BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(league_id, name)
);

-- ============================================================
-- NBA PLAYERS
-- ============================================================
CREATE TABLE players (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  league_id UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  nba_team TEXT,
  position TEXT,
  ranking INTEGER,
  stats JSONB DEFAULT '{}',
  auction_value NUMERIC(8,2),
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'on_auction', 'drafted')),
  drafted_by_team_id UUID REFERENCES teams(id),
  draft_price INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- AUCTIONS
-- ============================================================
CREATE TABLE auctions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  league_id UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id),
  nominating_team_id UUID REFERENCES teams(id),
  slot_number INTEGER NOT NULL,
  scheduled_start TIMESTAMPTZ NOT NULL,
  reveal_time TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'revealed', 'completed')),
  winning_team_id UUID REFERENCES teams(id),
  winning_bid INTEGER,
  tie_broken_by_priority BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- BIDS (sealed until reveal_time)
-- ============================================================
CREATE TABLE bids (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES teams(id),
  amount INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(auction_id, team_id)
);

-- ============================================================
-- PRIORITY LOG (audit)
-- ============================================================
CREATE TABLE priority_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  league_id UUID NOT NULL REFERENCES leagues(id),
  team_id UUID NOT NULL REFERENCES teams(id),
  old_rank INTEGER,
  new_rank INTEGER,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

-- Leagues: public read, admin write
ALTER TABLE leagues ENABLE ROW LEVEL SECURITY;
CREATE POLICY "leagues_read" ON leagues FOR SELECT USING (true);
CREATE POLICY "leagues_admin_write" ON leagues FOR ALL
  USING (auth.uid() IN (SELECT user_id FROM admin_users));

-- Admin users: admin only
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_read" ON admin_users FOR SELECT
  USING (auth.uid() = user_id OR auth.uid() IN (SELECT user_id FROM admin_users WHERE role = 'superadmin'));

-- Teams: public read, admin write
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
CREATE POLICY "teams_read" ON teams FOR SELECT USING (true);
CREATE POLICY "teams_admin_write" ON teams FOR ALL
  USING (auth.uid() IN (SELECT user_id FROM admin_users));

-- Players: public read, admin write
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
CREATE POLICY "players_read" ON players FOR SELECT USING (true);
CREATE POLICY "players_admin_write" ON players FOR ALL
  USING (auth.uid() IN (SELECT user_id FROM admin_users));

-- Auctions: public read, admin write
ALTER TABLE auctions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auctions_read" ON auctions FOR SELECT USING (true);
CREATE POLICY "auctions_admin_write" ON auctions FOR ALL
  USING (auth.uid() IN (SELECT user_id FROM admin_users));

-- Bids: SEALED - team sees own bids OR revealed/completed auctions
ALTER TABLE bids ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bids_own_or_revealed" ON bids FOR SELECT
  USING (
    team_id IN (SELECT id FROM teams WHERE user_id = auth.uid())
    OR (SELECT status FROM auctions WHERE id = auction_id) IN ('revealed', 'completed')
    OR auth.uid() IN (SELECT user_id FROM admin_users)
  );
CREATE POLICY "bids_team_insert" ON bids FOR INSERT
  WITH CHECK (
    team_id IN (SELECT id FROM teams WHERE user_id = auth.uid() AND is_complete = FALSE)
    AND (SELECT status FROM auctions WHERE id = auction_id) = 'active'
  );
CREATE POLICY "bids_team_update" ON bids FOR UPDATE
  USING (
    team_id IN (SELECT id FROM teams WHERE user_id = auth.uid())
    AND (SELECT status FROM auctions WHERE id = auction_id) = 'active'
  );

-- Priority log: public read
ALTER TABLE priority_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "priority_log_read" ON priority_log FOR SELECT USING (true);

-- ============================================================
-- HELPER FUNCTIONS
-- ============================================================

-- Recalculate team budget and player count
CREATE OR REPLACE FUNCTION refresh_team_stats(p_team_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_league_id UUID;
  v_players_per_team INTEGER;
  v_budget_per_team INTEGER;
  v_spent INTEGER;
  v_count INTEGER;
BEGIN
  SELECT t.league_id, l.players_per_team, l.budget_per_team
  INTO v_league_id, v_players_per_team, v_budget_per_team
  FROM teams t JOIN leagues l ON l.id = t.league_id
  WHERE t.id = p_team_id;

  SELECT COALESCE(SUM(draft_price), 0), COUNT(*)
  INTO v_spent, v_count
  FROM players
  WHERE drafted_by_team_id = p_team_id AND status = 'drafted';

  UPDATE teams SET
    budget_remaining = v_budget_per_team - v_spent,
    player_count = v_count,
    is_complete = (v_count >= v_players_per_team),
    updated_at = NOW()
  WHERE id = p_team_id;
END;
$$;

-- Resolve auction: determine winner, handle priority tie-break
CREATE OR REPLACE FUNCTION resolve_auction(p_auction_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_league_id UUID;
  v_player_id UUID;
  v_max_bid INTEGER;
  v_winning_team_id UUID;
  v_tie_count INTEGER;
  v_tie_broken BOOLEAN := FALSE;
  v_best_priority INTEGER;
BEGIN
  SELECT league_id, player_id INTO v_league_id, v_player_id
  FROM auctions WHERE id = p_auction_id;

  -- Find max bid >= min_bid(1)
  SELECT MAX(amount) INTO v_max_bid
  FROM bids WHERE auction_id = p_auction_id AND amount >= 1;

  IF v_max_bid IS NULL THEN
    -- No valid bids — auction goes unclaimed, return player to pool
    UPDATE auctions SET status = 'completed', updated_at = NOW() WHERE id = p_auction_id;
    UPDATE players SET status = 'available' WHERE id = v_player_id;
    RETURN;
  END IF;

  -- Check for ties
  SELECT COUNT(*) INTO v_tie_count
  FROM bids b
  JOIN teams t ON t.id = b.team_id
  WHERE b.auction_id = p_auction_id AND b.amount = v_max_bid AND t.is_complete = FALSE;

  IF v_tie_count = 1 THEN
    SELECT b.team_id INTO v_winning_team_id
    FROM bids b JOIN teams t ON t.id = b.team_id
    WHERE b.auction_id = p_auction_id AND b.amount = v_max_bid AND t.is_complete = FALSE;
  ELSE
    -- Tie: winner is team with best (lowest) tiebreak_rank
    v_tie_broken := TRUE;
    SELECT b.team_id, t.tiebreak_rank INTO v_winning_team_id, v_best_priority
    FROM bids b JOIN teams t ON t.id = b.team_id
    WHERE b.auction_id = p_auction_id AND b.amount = v_max_bid
      AND t.is_complete = FALSE AND t.tiebreak_rank IS NOT NULL
    ORDER BY t.tiebreak_rank ASC
    LIMIT 1;

    -- Push winner to bottom of tiebreak order (nomination order is unaffected)
    PERFORM demote_priority(v_winning_team_id, v_league_id);
  END IF;

  -- Check team can afford
  DECLARE v_budget INTEGER;
  BEGIN
    SELECT budget_remaining INTO v_budget FROM teams WHERE id = v_winning_team_id;
    IF v_budget < v_max_bid THEN
      -- Team can't afford — find next valid bidder (skip for now, admin handles edge case)
      NULL;
    END IF;
  END;

  -- Assign player to team
  UPDATE players SET
    status = 'drafted',
    drafted_by_team_id = v_winning_team_id,
    draft_price = v_max_bid
  WHERE id = v_player_id;

  -- Mark auction complete
  UPDATE auctions SET
    status = 'completed',
    winning_team_id = v_winning_team_id,
    winning_bid = v_max_bid,
    tie_broken_by_priority = v_tie_broken,
    updated_at = NOW()
  WHERE id = p_auction_id;

  -- Refresh team stats
  PERFORM refresh_team_stats(v_winning_team_id);

  -- Remove complete team from priority
  PERFORM remove_complete_team_from_priority(v_winning_team_id, v_league_id);
END;
$$;

-- Demote a team to bottom of tiebreak order (nomination order is unaffected)
CREATE OR REPLACE FUNCTION demote_priority(p_team_id UUID, p_league_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_max_rank INTEGER;
BEGIN
  SELECT MAX(tiebreak_rank) INTO v_max_rank
  FROM teams WHERE league_id = p_league_id AND is_complete = FALSE AND tiebreak_rank IS NOT NULL;

  INSERT INTO priority_log(league_id, team_id, old_rank, new_rank, reason)
  SELECT p_league_id, p_team_id, tiebreak_rank, v_max_rank + 1, 'tie_break_demotion'
  FROM teams WHERE id = p_team_id;

  UPDATE teams SET tiebreak_rank = v_max_rank + 1, updated_at = NOW() WHERE id = p_team_id;
END;
$$;

-- Remove completed team from priority
CREATE OR REPLACE FUNCTION remove_complete_team_from_priority(p_team_id UUID, p_league_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE teams SET priority_rank = NULL, updated_at = NOW()
  WHERE id = p_team_id AND is_complete = TRUE;
END;
$$;

-- Enable realtime for live updates
ALTER PUBLICATION supabase_realtime ADD TABLE auctions;
ALTER PUBLICATION supabase_realtime ADD TABLE bids;
ALTER PUBLICATION supabase_realtime ADD TABLE teams;
ALTER PUBLICATION supabase_realtime ADD TABLE players;
