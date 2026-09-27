import type { SupabaseClient } from '@supabase/supabase-js'
import type { TradeStatus } from '@/types'

/** A stored auction trade, flattened for display. Players + cash, no picks. */
export type AuctionTradeView = {
  id: string
  status: TradeStatus
  note: string | null
  rejection_reason: string | null
  created_at: string
  updated_at: string
  proposingTeamId: string
  targetTeamId: string
  proposingName: string
  targetName: string
  proposingGives: string[]
  targetGives: string[]
  cashFromTeamId: string | null
  cashAmount: number
}

type Row = {
  id: string
  status: TradeStatus
  note: string | null
  rejection_reason: string | null
  created_at: string
  admin_responded_at: string | null
  target_responded_at: string | null
  proposing_team_id: string
  target_team_id: string
  cash_from_team_id: string | null
  cash_amount: number | null
  proposing_team: { name: string } | null
  target_team: { name: string } | null
  assets: { from_team_id: string; player: { name: string } | null }[] | null
}

const SELECT =
  'id, status, note, rejection_reason, created_at, admin_responded_at, target_responded_at, ' +
  'proposing_team_id, target_team_id, cash_from_team_id, cash_amount, ' +
  'proposing_team:teams!proposing_team_id(name), target_team:teams!target_team_id(name), ' +
  'assets:trade_assets(from_team_id, player:players(name))'

/**
 * Reads a league's trades as the given client sees them. With the cookie
 * client, RLS already limits this to approved trades plus the caller's own
 * (or every trade, for the league admin).
 */
export async function loadAuctionTradeViews(
  client: SupabaseClient,
  leagueId: string,
  filter?: { statuses?: TradeStatus[]; teamId?: string }
): Promise<AuctionTradeView[]> {
  let q = client.from('trades').select(SELECT).eq('league_id', leagueId)
  if (filter?.statuses) q = q.in('status', filter.statuses)
  if (filter?.teamId) q = q.or(`proposing_team_id.eq.${filter.teamId},target_team_id.eq.${filter.teamId}`)
  const { data } = await q.order('created_at', { ascending: false })

  return ((data ?? []) as unknown as Row[]).map(r => {
    const assets = r.assets ?? []
    const names = (teamId: string) =>
      assets.filter(a => a.from_team_id === teamId).map(a => a.player?.name ?? 'שחקן')
    return {
      id: r.id,
      status: r.status,
      note: r.note,
      rejection_reason: r.rejection_reason,
      created_at: r.created_at,
      updated_at: r.admin_responded_at ?? r.target_responded_at ?? r.created_at,
      proposingTeamId: r.proposing_team_id,
      targetTeamId: r.target_team_id,
      proposingName: r.proposing_team?.name ?? '—',
      targetName: r.target_team?.name ?? '—',
      proposingGives: names(r.proposing_team_id),
      targetGives: names(r.target_team_id),
      cashFromTeamId: r.cash_from_team_id,
      cashAmount: r.cash_amount ?? 0,
    }
  })
}

/** What one side hands over, as display text: players, then cash. */
export function sideSummary(trade: AuctionTradeView, teamId: string): string[] {
  const players = teamId === trade.proposingTeamId ? trade.proposingGives : trade.targetGives
  return trade.cashAmount > 0 && trade.cashFromTeamId === teamId
    ? [...players, `$${trade.cashAmount}`]
    : players
}
