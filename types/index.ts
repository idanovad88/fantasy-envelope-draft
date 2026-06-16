export type LeagueStatus = 'setup' | 'lottery' | 'active' | 'paused' | 'completed'
export type PlayerStatus = 'available' | 'on_auction' | 'drafted'
export type AuctionStatus = 'pending' | 'active' | 'revealed' | 'completed'
export type DraftType = 'envelope' | 'snake'

export interface League {
  id: string
  name: string
  num_teams: number
  players_per_team: number
  budget_per_team: number
  min_bid: number
  status: LeagueStatus
  draft_type: DraftType
  draft_start_hour: number
  draft_end_hour: number
  nomination_interval_hours: number
  reveal_before_minutes: number
  auction_duration_hours: number
  join_code: string | null
  draft_start_time: string | null
  roster_slots: Record<string, number> | null
  var_gif_url: string | null
  pick_timeout_minutes: number | null
  snake_round_config: boolean[] | null
  created_by: string
  created_at: string
  updated_at: string
}

export interface SnakePick {
  id: string
  league_id: string
  team_id: string
  player_id: string
  overall_pick_number: number
  round: number
  pick_in_round: number
  picked_at: string
  team?: Team
  player?: Player
}

export interface Team {
  id: string
  league_id: string
  name: string
  user_id: string | null
  budget_remaining: number
  player_count: number
  is_complete: boolean
  priority_rank: number | null
  tiebreak_rank: number | null
  approved: boolean
  avatar_url: string | null
  created_at: string
  updated_at: string
}

export interface Player {
  id: string
  league_id: string
  name: string
  nba_team: string | null
  position: string | null
  ranking: number | null
  stats: PlayerStats
  auction_value: number | null
  status: PlayerStatus
  drafted_by_team_id: string | null
  draft_price: number | null
  roster_slot: string | null
  created_at: string
}

export interface PlayerStats {
  ppg?: number
  rpg?: number
  apg?: number
  spg?: number
  bpg?: number
  fg_pct?: number
  ft_pct?: number
  tpg?: number
  threepg?: number
  [key: string]: number | undefined
}

export interface Auction {
  id: string
  league_id: string
  player_id: string
  nominating_team_id: string | null
  slot_number: number
  scheduled_start: string
  reveal_time: string
  status: AuctionStatus
  winning_team_id: string | null
  winning_bid: number | null
  tie_broken_by_priority: boolean
  created_at: string
  updated_at: string
  // joined
  player?: Player
  nominating_team?: Team
  winning_team?: Team
}

export interface Bid {
  id: string
  auction_id: string
  team_id: string
  amount: number
  created_at: string
  updated_at: string
  // joined
  team?: Team
}

export interface AdminUser {
  user_id: string
  league_id: string | null
  role: 'superadmin' | 'admin'
  created_at: string
}
