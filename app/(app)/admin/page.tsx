import { createClient, createAdminClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import AdminPanel from './AdminPanel'
import type { League, Team, Auction } from '@/types'

export const dynamic = 'force-dynamic'

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab: tabParam } = await searchParams
  const validTabs = ['overview', 'teams', 'auction', 'players', 'lottery', 'league'] as const
  type TabId = typeof validTabs[number]
  const initialTab: TabId = validTabs.includes(tabParam as TabId) ? (tabParam as TabId) : 'overview'

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const cookieStore = await cookies()
  const selectedLeagueId = cookieStore.get('selected_league_id')?.value
  if (!selectedLeagueId) redirect('/leagues')

  const adminDb = createAdminClient()

  // Verify user is admin for the currently selected league
  const { data: adminRow } = await supabase
    .from('admin_users').select('*').eq('user_id', user.id).eq('league_id', selectedLeagueId).maybeSingle()
  const { data: ownedLeague } = !adminRow
    ? await supabase.from('leagues').select('id').eq('id', selectedLeagueId).eq('created_by', user.id).maybeSingle()
    : { data: null }
  if (!adminRow && !ownedLeague) redirect('/')

  const leagueId = selectedLeagueId

  const { data: league } = await supabase.from('leagues').select('*').eq('id', leagueId).maybeSingle()

  const lid = league?.id

  // Auto-activate any pending auction whose scheduled_start has passed
  if (lid) {
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

  const [{ data: teams }, { data: activeAuction }, { data: scheduledAuctions }, { data: players }, { data: pastAuctions }, { data: leagueCreators }, { data: leagueAdminUsers }] =
    await Promise.all([
      supabase.from('teams').select('*').eq('league_id', lid).order('priority_rank', { ascending: true, nullsFirst: false }),
      supabase.from('auctions').select('*, player:players(*), bids(id)').eq('league_id', lid).eq('status', 'active').order('scheduled_start', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('auctions').select('id, scheduled_start, reveal_time, player:players(name)').eq('league_id', lid).eq('status', 'pending').order('scheduled_start', { ascending: true }),
      supabase.from('players').select('id, name, status, ranking, position').eq('league_id', lid).order('ranking', { ascending: true }),
      supabase.from('auctions').select('id, scheduled_start, winning_bid, player:players(name), winning_team:teams!winning_team_id(name)').eq('league_id', lid).eq('status', 'completed').order('scheduled_start', { ascending: false }).limit(50),
      supabase.from('league_creator_whitelist').select('email').order('created_at', { ascending: true }),
      adminDb.from('admin_users').select('user_id').eq('league_id', lid),
    ])

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
      />
    </>
  )
}
