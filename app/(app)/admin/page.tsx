import { createClient, createAdminClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import AdminPanel, { type AdminTradeView } from './AdminPanel'
import type { League, Team, Auction, SnakePick, Trade, TradeAsset } from '@/types'
import { describePick } from '@/lib/utils'

export const dynamic = 'force-dynamic'

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab: tabParam } = await searchParams
  const validTabs = ['overview', 'teams', 'auction', 'players', 'lottery', 'league', 'draft', 'trades'] as const
  type TabId = typeof validTabs[number]
  const initialTab: TabId = validTabs.includes(tabParam as TabId) ? (tabParam as TabId) : 'overview'

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const cookieStore = await cookies()
  const selectedLeagueId = cookieStore.get('selected_league_id')?.value
  if (!selectedLeagueId) redirect('/leagues')

  const adminDb = createAdminClient()

  const { data: adminRow } = await supabase
    .from('admin_users').select('*').eq('user_id', user.id).eq('league_id', selectedLeagueId).maybeSingle()
  const { data: ownedLeague } = !adminRow
    ? await supabase.from('leagues').select('id').eq('id', selectedLeagueId).eq('created_by', user.id).maybeSingle()
    : { data: null }
  if (!adminRow && !ownedLeague) redirect('/')

  const leagueId = selectedLeagueId
  const { data: league } = await supabase.from('leagues').select('*').eq('id', leagueId).maybeSingle()
  const lid = league?.id
  const isSnake = league?.draft_type === 'snake'

  // Auto-activate any pending auction whose scheduled_start has passed (envelope only)
  if (lid && !isSnake) {
    const nowIso = new Date().toISOString()
    const [{ data: alreadyActive }, { data: overdue }] = await Promise.all([
      adminDb.from('auctions').select('id').eq('league_id', lid).eq('status', 'active').maybeSingle(),
      adminDb.from('auctions').select('id, player_id').eq('league_id', lid).eq('status', 'pending')
        .lte('scheduled_start', nowIso).order('scheduled_start', { ascending: true }).limit(1).maybeSingle(),
    ])
    if (!alreadyActive && overdue) {
      await Promise.all([
        adminDb.from('auctions').update({ status: 'active' }).eq('id', overdue.id),
        adminDb.from('players').update({ status: 'on_auction' }).eq('id', overdue.player_id),
      ])
    }
  }

  const [{ data: teams }, { data: activeAuction }, { data: scheduledAuctions }, { data: players }, { data: pastAuctions }, { data: leagueCreators }, { data: leagueAdminUsers }, { data: snakePicks }, { data: tradeRows }] =
    await Promise.all([
      supabase.from('teams').select('*').eq('league_id', lid).order('priority_rank', { ascending: true, nullsFirst: false }),
      !isSnake ? supabase.from('auctions').select('*, player:players(*), bids(id)').eq('league_id', lid).eq('status', 'active').order('scheduled_start', { ascending: false }).limit(1).maybeSingle() : Promise.resolve({ data: null }),
      !isSnake ? supabase.from('auctions').select('id, scheduled_start, reveal_time, player:players(name)').eq('league_id', lid).eq('status', 'pending').order('scheduled_start', { ascending: true }) : Promise.resolve({ data: [] }),
      supabase.from('players').select('id, name, status, ranking, position').eq('league_id', lid).order('ranking', { ascending: true }),
      !isSnake ? supabase.from('auctions').select('id, scheduled_start, winning_bid, player:players(name), winning_team:teams!winning_team_id(name)').eq('league_id', lid).eq('status', 'completed').order('scheduled_start', { ascending: false }).limit(50) : Promise.resolve({ data: [] }),
      supabase.from('league_creator_whitelist').select('email').order('created_at', { ascending: true }),
      adminDb.from('admin_users').select('user_id').eq('league_id', lid),
      isSnake ? supabase.from('snake_picks').select('*, player:players(name, position), team:teams(name)').eq('league_id', lid).order('overall_pick_number', { ascending: true }) : Promise.resolve({ data: [] }),
      isSnake ? supabase.from('trades').select('*, assets:trade_assets(*)').eq('league_id', lid).order('created_at', { ascending: false }) : Promise.resolve({ data: [] }),
    ])

  // Build admin trade views (resolve team + player names and pick labels).
  const typedTeams = (teams || []) as Team[]
  const teamNameById = new Map(typedTeams.map(t => [t.id, t.name]))
  const playerNameById = new Map(((players || []) as { id: string; name: string }[]).map(p => [p.id, p.name]))
  const numTeams = league?.num_teams ?? 0
  const labelFor = (a: TradeAsset): { type: 'pick' | 'player'; label: string } => {
    if (a.asset_type === 'pick' && a.overall_pick_number != null) {
      const { round, pickInRound } = describePick(a.overall_pick_number, numTeams)
      return { type: 'pick', label: `סיבוב ${round}, בחירה ${pickInRound} (#${a.overall_pick_number})` }
    }
    return { type: 'player', label: a.player_id ? (playerNameById.get(a.player_id) ?? 'שחקן') : 'שחקן' }
  }
  const tradeViews: AdminTradeView[] = ((tradeRows || []) as (Trade & { assets: TradeAsset[] })[]).map(tr => {
    const assets = tr.assets ?? []
    return {
      id: tr.id,
      status: tr.status,
      note: tr.note,
      rejection_reason: tr.rejection_reason,
      proposingName: teamNameById.get(tr.proposing_team_id) ?? '—',
      targetName: teamNameById.get(tr.target_team_id) ?? '—',
      proposingGives: assets.filter(a => a.from_team_id === tr.proposing_team_id).map(labelFor),
      targetGives: assets.filter(a => a.from_team_id === tr.target_team_id).map(labelFor),
    }
  })

  return (
    <>
      <AdminPanel
        initialTab={initialTab}
        league={league as League | null}
        teams={(teams || []) as Team[]}
        activeAuction={activeAuction as (Auction & { player: { name: string }; bids: { id: string }[] }) | null}
        scheduledAuctions={(scheduledAuctions || []) as unknown as { id: string; scheduled_start: string; reveal_time: string; player: { name: string } | null }[]}
        players={players || []}
        pastAuctions={(pastAuctions || []) as unknown as { id: string; scheduled_start: string; winning_bid: number | null; player: { name: string } | null; winning_team: { name: string } | null }[]}
        leagueCreators={(leagueCreators || []).map(r => r.email)}
        adminUserIds={(leagueAdminUsers || []).map(r => r.user_id)}
        currentUserId={user.id}
        snakePicks={(snakePicks || []) as unknown as (SnakePick & { player: { name: string; position: string | null } | null; team: { name: string } | null })[]}
        trades={tradeViews}
      />
    </>
  )
}
