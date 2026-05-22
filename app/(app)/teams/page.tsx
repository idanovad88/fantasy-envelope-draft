import { createClient } from '@/lib/supabase/server'
import type { Team, Player } from '@/types'
import TeamsView from '@/components/TeamsView'

export const dynamic = 'force-dynamic'

export default async function TeamsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const [{ data: league }, { data: teams }, { data: players }] = await Promise.all([
    supabase.from('leagues').select('*').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('teams').select('*').order('priority_rank', { ascending: true, nullsFirst: false }),
    supabase.from('players').select('*').eq('status', 'drafted'),
  ])

  const typedTeams = (teams || []) as Team[]
  const typedPlayers = (players || []) as Player[]

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
        budgetPerTeam={(league as { budget_per_team?: number })?.budget_per_team ?? 200}
        playersPerTeam={(league as { players_per_team?: number })?.players_per_team ?? 13}
      />
    </div>
  )
}
