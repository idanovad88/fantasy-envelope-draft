import { createClient } from '@/lib/supabase/server'
import { cookies } from 'next/headers'
import type { Team, Player, League } from '@/types'
import TeamsView from '@/components/TeamsView'

export const dynamic = 'force-dynamic'

export default async function TeamsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const cookieStore = await cookies()
  const selectedLeagueId = cookieStore.get('selected_league_id')?.value

  const { data: myTeam } = selectedLeagueId
    ? await supabase.from('teams').select('league_id').eq('user_id', user!.id).eq('league_id', selectedLeagueId).maybeSingle()
    : await supabase.from('teams').select('league_id').eq('user_id', user!.id).order('created_at', { ascending: false }).limit(1).maybeSingle()

  const [{ data: adminRow }, { data: createdLeague }] = await Promise.all([
    supabase.from('admin_users').select('league_id').eq('user_id', user!.id).maybeSingle(),
    supabase.from('leagues').select('id').eq('created_by', user!.id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ])

  const leagueId = selectedLeagueId ?? myTeam?.league_id ?? adminRow?.league_id ?? createdLeague?.id ?? null

  const { data: league } = leagueId
    ? await supabase.from('leagues').select('*').eq('id', leagueId).maybeSingle()
    : { data: null }

  const isSnake = (league as League)?.draft_type === 'snake'

  const [{ data: teams }, { data: players }, { data: snakePicks }] = await Promise.all([
    league
      ? supabase.from('teams').select('*').eq('league_id', league.id).order('priority_rank', { ascending: true, nullsFirst: false })
      : Promise.resolve({ data: [] }),
    league
      ? supabase.from('players').select('*').eq('league_id', league.id).eq('status', 'drafted')
      : Promise.resolve({ data: [] }),
    isSnake && league
      ? supabase.from('snake_picks').select('player_id, overall_pick_number').eq('league_id', league.id)
      : Promise.resolve({ data: [] }),
  ])

  const typedTeams = (teams || []) as Team[]
  const typedPlayers = (players || []) as Player[]

  const pickNumbers = ((snakePicks || []) as { player_id: string; overall_pick_number: number }[])
    .reduce((acc, sp) => { acc[sp.player_id] = sp.overall_pick_number; return acc }, {} as Record<string, number>)

  const playersByTeam = typedPlayers.reduce((acc, p) => {
    if (p.drafted_by_team_id) {
      acc[p.drafted_by_team_id] = [...(acc[p.drafted_by_team_id] || []), p]
    }
    return acc
  }, {} as Record<string, Player[]>)

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">קבוצות</h1>
      <TeamsView
        teams={typedTeams}
        playersByTeam={playersByTeam}
        myUserId={user?.id ?? null}
        budgetPerTeam={(league as League)?.budget_per_team ?? 200}
        playersPerTeam={(league as League)?.players_per_team ?? 13}
        rosterSlots={(league as League)?.roster_slots ?? null}
        isSnake={isSnake}
        pickNumbers={pickNumbers}
      />
    </div>
  )
}
