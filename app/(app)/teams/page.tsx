import { createClient } from '@/lib/supabase/server'
import type { Team, Player } from '@/types'

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

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {typedTeams.map(team => {
          const roster = playersByTeam[team.id] || []
          const isMyTeam = team.user_id === user?.id
          const budgetPerTeam = (league as { budget_per_team?: number })?.budget_per_team ?? 200
          const playersPerTeam = (league as { players_per_team?: number })?.players_per_team ?? 13

          return (
            <div
              key={team.id}
              className="card"
              style={isMyTeam ? { borderColor: 'var(--primary)', borderWidth: 2 } : {}}
            >
              {/* Header */}
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="font-bold text-lg">{team.name}</h2>
                    {isMyTeam && <span className="badge badge-blue text-xs">אתה</span>}
                    {team.is_complete && <span className="badge badge-green text-xs">✅ שלם</span>}
                    {!team.approved && <span className="badge badge-yellow text-xs">ממתין לאישור</span>}
                  </div>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
                    פריוריטי: {team.priority_rank ?? (team.is_complete ? 'הסתיים' : '—')}
                  </p>
                </div>
                <div className="text-left">
                  <p className="font-bold text-xl" style={{ color: team.budget_remaining < 20 ? 'var(--danger)' : 'var(--success)' }}>
                    ${team.budget_remaining}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--muted)' }}>
                    {team.player_count}/{playersPerTeam} שחקנים
                  </p>
                </div>
              </div>

              {/* Budget bar */}
              <div className="w-full h-1.5 rounded-full mb-3" style={{ background: 'var(--border)' }}>
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${(team.budget_remaining / budgetPerTeam) * 100}%`,
                    background: team.budget_remaining < 20 ? 'var(--danger)' : 'var(--success)',
                  }}
                />
              </div>

              {/* Roster */}
              {roster.length > 0 ? (
                <div className="flex flex-col gap-1">
                  {roster.map(p => (
                    <div key={p.id} className="flex items-center justify-between text-sm py-1 px-2 rounded" style={{ background: 'var(--background)' }}>
                      <div>
                        <span className="font-medium">{p.name}</span>
                        <span className="text-xs mr-2" style={{ color: 'var(--muted)' }}>{p.position}</span>
                      </div>
                      <span className="font-bold" style={{ color: 'var(--warning)' }}>${p.draft_price}</span>
                    </div>
                  ))}
                  {Array.from({ length: playersPerTeam - roster.length }).map((_, i) => (
                    <div key={i} className="flex items-center justify-between text-sm py-1 px-2 rounded" style={{ background: 'var(--background)', opacity: 0.3 }}>
                      <span style={{ color: 'var(--muted)' }}>— ריק —</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-center py-4" style={{ color: 'var(--muted)' }}>
                  אין שחקנים עדיין
                </p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
