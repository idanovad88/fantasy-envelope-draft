import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import AdminPanel from './AdminPanel'
import type { League, Team, Auction } from '@/types'

export const dynamic = 'force-dynamic'

export default async function AdminPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: adminRow } = await supabase.from('admin_users').select('*').eq('user_id', user.id).maybeSingle()
  if (!adminRow) redirect('/')

  const leagueId = adminRow?.league_id

  // Resolve the league first so all subsequent queries use a consistent id
  const { data: league } = leagueId
    ? await supabase.from('leagues').select('*').eq('id', leagueId).maybeSingle()
    : await supabase.from('leagues').select('*').order('created_at', { ascending: false }).limit(1).maybeSingle()

  const lid = league?.id

  const [{ data: teams }, { data: activeAuction }, { data: scheduledAuctions }, { data: players }, { data: pastAuctions }, { data: leagueCreators }, { data: leagueAdminUsers }] =
    await Promise.all([
      lid
        ? supabase.from('teams').select('*').eq('league_id', lid).order('priority_rank', { ascending: true, nullsFirst: false })
        : supabase.from('teams').select('*').order('priority_rank', { ascending: true, nullsFirst: false }),
      lid
        ? supabase.from('auctions').select('*, player:players(*), bids(id)').eq('league_id', lid).eq('status', 'active').order('scheduled_start', { ascending: false }).limit(1).maybeSingle()
        : supabase.from('auctions').select('*, player:players(*), bids(id)').eq('status', 'active').order('scheduled_start', { ascending: false }).limit(1).maybeSingle(),
      lid
        ? supabase.from('auctions').select('id, scheduled_start, reveal_time, player:players(name)').eq('league_id', lid).eq('status', 'pending').order('scheduled_start', { ascending: true })
        : supabase.from('auctions').select('id, scheduled_start, reveal_time, player:players(name)').eq('status', 'pending').order('scheduled_start', { ascending: true }),
      lid
        ? supabase.from('players').select('id, name, status, ranking, position').eq('league_id', lid).order('ranking', { ascending: true })
        : supabase.from('players').select('id, name, status, ranking, position').order('ranking', { ascending: true }),
      lid
        ? supabase.from('auctions').select('id, scheduled_start, winning_bid, player:players(name), winning_team:teams!winning_team_id(name)').eq('league_id', lid).eq('status', 'completed').order('scheduled_start', { ascending: false }).limit(50)
        : supabase.from('auctions').select('id, scheduled_start, winning_bid, player:players(name), winning_team:teams!winning_team_id(name)').eq('status', 'completed').order('scheduled_start', { ascending: false }).limit(50),
      supabase.from('league_creator_whitelist').select('email').order('created_at', { ascending: true }),
      lid
        ? supabase.from('admin_users').select('user_id').eq('league_id', lid)
        : supabase.from('admin_users').select('user_id'),
    ])

  return (
    <>
      <AdminPanel
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
