import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import AdminPanel from './AdminPanel'
import ImportPlayers from './ImportPlayers'
import type { League, Team, Auction } from '@/types'

export const dynamic = 'force-dynamic'

export default async function AdminPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: adminRow } = await supabase.from('admin_users').select('*').eq('user_id', user.id).maybeSingle()
  if (!adminRow) redirect('/')

  const leagueId = adminRow?.league_id

  const [{ data: league }, { data: teams }, { data: pendingTeams }, { data: activeAuction }, { data: scheduledAuctions }, { data: players }, { data: pastAuctions }, { data: leagueCreators }] =
    await Promise.all([
      leagueId
        ? supabase.from('leagues').select('*').eq('id', leagueId).maybeSingle()
        : supabase.from('leagues').select('*').order('created_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('teams').select('*').order('priority_rank', { ascending: true, nullsFirst: false }),
      supabase.from('teams').select('*').eq('approved', false),
      supabase.from('auctions').select('*, player:players(*), bids(id)').eq('status', 'active').order('scheduled_start', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('auctions').select('id, scheduled_start, reveal_time, player:players(name)').eq('status', 'pending').order('scheduled_start', { ascending: true }),
      leagueId
        ? supabase.from('players').select('id, name, status, ranking, position').eq('league_id', leagueId).order('ranking', { ascending: true })
        : supabase.from('players').select('id, name, status, ranking, position').order('ranking', { ascending: true }),
      supabase.from('auctions')
        .select('id, scheduled_start, winning_bid, player:players(name), winning_team:teams!winning_team_id(name)')
        .eq('status', 'completed')
        .order('scheduled_start', { ascending: false })
        .limit(50),
      supabase.from('league_creator_whitelist').select('email').order('created_at', { ascending: true }),
    ])

  return (
    <>
      <AdminPanel
        league={league as League | null}
        teams={(teams || []) as Team[]}
        pendingTeams={(pendingTeams || []) as Team[]}
        activeAuction={activeAuction as (Auction & { player: { name: string }; bids: { id: string }[] }) | null}
        scheduledAuctions={(scheduledAuctions || []) as unknown as { id: string; scheduled_start: string; reveal_time: string; player: { name: string } | null }[]}
        players={players || []}
        pastAuctions={(pastAuctions || []) as unknown as { id: string; scheduled_start: string; winning_bid: number | null; player: { name: string } | null; winning_team: { name: string } | null }[]}
        leagueCreators={(leagueCreators || []).map(r => r.email)}
      />
      {league && <ImportPlayers leagueId={league.id} />}
    </>
  )
}
