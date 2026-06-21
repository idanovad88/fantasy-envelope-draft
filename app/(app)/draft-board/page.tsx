import { createClient } from '@/lib/supabase/server'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import RealtimeRefresher from '@/components/RealtimeRefresher'
import type { League, Team, SnakePick } from '@/types'
import { getSnakeTeamForPick } from '@/lib/utils'
import { activateOverdueSnakeDraft } from '@/lib/activateDraft'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function DraftBoardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const cookieStore = await cookies()
  const selectedLeagueId = cookieStore.get('selected_league_id')?.value

  if (!selectedLeagueId) redirect('/leagues')

  // Auto-start the snake draft if its scheduled start time has passed.
  await activateOverdueSnakeDraft(selectedLeagueId)

  const { data: league } = await supabase
    .from('leagues').select('*').eq('id', selectedLeagueId).maybeSingle()
  const typedLeague = league as League | null

  // The full draft board only applies to snake drafts.
  if (typedLeague?.draft_type !== 'snake') redirect('/')

  const { data: myTeam } = await supabase
    .from('teams').select('*').eq('user_id', user!.id).eq('league_id', selectedLeagueId).maybeSingle()

  const [{ data: teams }, { data: snakePicks }] = await Promise.all([
    supabase.from('teams')
      .select('*')
      .eq('league_id', selectedLeagueId)
      .eq('approved', true)
      .not('priority_rank', 'is', null)
      .order('priority_rank', { ascending: true }),
    supabase.from('snake_picks')
      .select('*, player:players(name, position), team:teams(name)')
      .eq('league_id', selectedLeagueId)
      .order('overall_pick_number', { ascending: true }),
  ])

  const typedTeams = (teams || []) as Team[]
  const typedPicks = (snakePicks || []) as (SnakePick & {
    player: { name: string; position: string | null } | null
    team: { name: string } | null
  })[]

  const numTeams = typedLeague.num_teams
  const totalPicks = numTeams * typedLeague.players_per_team
  const completedCount = typedPicks.length
  const currentPickNumber = completedCount + 1
  const isDraftComplete = typedLeague.status === 'completed' || completedCount >= totalPicks
  const config = typedLeague.snake_round_config as boolean[] | null

  // Map overall pick number → the recorded pick (if any).
  const pickByNumber = new Map<number, typeof typedPicks[0]>()
  for (const pick of typedPicks) {
    pickByNumber.set(pick.overall_pick_number, pick)
  }

  // Build every pick slot, past and future, in order.
  const rows = Array.from({ length: totalPicks }, (_, i) => {
    const pickNumber = i + 1
    const pick = pickByNumber.get(pickNumber)
    const team = getSnakeTeamForPick(pickNumber, numTeams, typedTeams, config)
    const teamName = pick?.team?.name ?? team?.name ?? '—'
    const teamId = pick?.team_id ?? team?.id ?? null
    return {
      pickNumber,
      round: Math.ceil(pickNumber / numTeams),
      teamName,
      teamId,
      playerName: pick?.player?.name ?? null,
      isCurrent: !isDraftComplete && pickNumber === currentPickNumber,
    }
  })

  return (
    <div className="max-w-3xl mx-auto">
      <RealtimeRefresher leagueId={typedLeague.id} />

      <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold mb-1">לוח הדראפט המלא</h1>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            {typedLeague.name} · {completedCount}/{totalPicks} בחירות בוצעו
          </p>
        </div>
        <Link href="/" className="btn btn-outline text-sm">← חזרה לדשבורד</Link>
      </div>

      <div className="card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
                <th className="text-right pb-2 w-16">בחירה</th>
                <th className="text-right pb-2">קבוצה</th>
                <th className="text-right pb-2">שחקן</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => {
                const isMyTeam = !!myTeam && row.teamId === (myTeam as Team).id
                return (
                  <tr
                    key={row.pickNumber}
                    style={{
                      borderBottom: '1px solid var(--border)',
                      background: row.isCurrent ? 'rgba(234,179,8,0.10)' : 'transparent',
                    }}
                  >
                    <td className="py-2">
                      <span className="badge badge-gray text-xs">#{row.pickNumber}</span>
                    </td>
                    <td className="py-2">
                      <span className="font-medium" style={isMyTeam ? { color: 'var(--primary)' } : undefined}>
                        {row.teamName}
                      </span>
                      {row.isCurrent && (
                        <span className="badge badge-yellow text-xs mr-2">על הדק</span>
                      )}
                    </td>
                    <td className="py-2">
                      {row.playerName ? (
                        <span className="font-medium" dir="ltr">{row.playerName}</span>
                      ) : (
                        <span style={{ color: 'var(--border)' }}>—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
