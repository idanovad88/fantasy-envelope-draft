import { createClient, createAdminClient } from '@/lib/supabase/server'
import type { League, Team } from '@/types'
import LeagueSelectButton from '@/components/LeagueSelectButton'
import JoinLeagueForm from '@/components/JoinLeagueForm'

export const dynamic = 'force-dynamic'

type LeagueEntry = {
  league: League
  myTeam: Team | null
  isAdmin: boolean
}

export default async function LeaguesPage() {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  // Fetch all teams for this user (across all leagues)
  const { data: myTeams } = await admin
    .from('teams')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  // Fetch admin memberships
  const { data: adminRows } = await admin
    .from('admin_users')
    .select('league_id')
    .eq('user_id', user.id)

  // Fetch created leagues (spectator-admin without a team)
  const { data: createdLeagues } = await admin
    .from('leagues')
    .select('*')
    .eq('created_by', user.id)
    .order('created_at', { ascending: false })

  // Collect all league IDs to fetch at once
  const teamLeagueIds = (myTeams ?? []).map(t => t.league_id).filter(Boolean)
  const adminLeagueIds = (adminRows ?? []).map(r => r.league_id).filter(Boolean)
  const allLeagueIds = [...new Set([...teamLeagueIds, ...adminLeagueIds])]

  const { data: fetchedLeagues } = allLeagueIds.length > 0
    ? await admin.from('leagues').select('*').in('id', allLeagueIds)
    : { data: [] }

  // Build deduped league map
  const leagueMap = new Map<string, LeagueEntry>()

  const allLeagues = [
    ...(fetchedLeagues ?? []),
    ...(createdLeagues ?? []).filter(l => !allLeagueIds.includes(l.id)),
  ] as League[]

  for (const league of allLeagues) {
    const myTeam = (myTeams ?? []).find(t => t.league_id === league.id) as Team | null
    const isAdmin = (adminRows ?? []).some(r => r.league_id === league.id) || league.created_by === user.id
    leagueMap.set(league.id, { league, myTeam, isAdmin })
  }

  const entries = Array.from(leagueMap.values())

  // Check whitelist for "create league" option
  const { data: whitelistRow } = await supabase
    .from('league_creator_whitelist')
    .select('email')
    .eq('email', user.email ?? '')
    .maybeSingle()
  const isWhitelisted = !!whitelistRow

  const statusLabel: Record<string, string> = {
    setup: 'הכנה',
    lottery: 'הגרלה',
    active: 'פעיל',
    paused: 'מושהה',
    completed: 'הסתיים',
  }

  return (
    <div className="max-w-lg mx-auto">
      <h1 className="text-2xl font-bold mb-6">הליגות שלי</h1>

      {entries.length === 0 ? (
        <div className="card text-center py-8" style={{ color: 'var(--muted)' }}>
          <p className="text-3xl mb-3">🏀</p>
          <p>עדיין לא הצטרפת לאף ליגה</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3 mb-6">
          {entries.map(({ league, myTeam, isAdmin }) => (
            <div key={league.id} className="card flex items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold">{league.name}</span>
                  {isAdmin && (
                    <span className="badge badge-yellow text-xs">מנהל</span>
                  )}
                  <span className={`badge text-xs ${league.status === 'active' ? 'badge-green' : 'badge-gray'}`}>
                    {statusLabel[league.status] ?? league.status}
                  </span>
                  <span className="badge badge-blue text-xs">
                    {league.draft_type === 'snake' ? 'סנייק' : 'מעטפות'}
                  </span>
                </div>
                {myTeam && (
                  <p className="text-sm mt-0.5" style={{ color: 'var(--muted)' }}>
                    קבוצה: {myTeam.name}
                  </p>
                )}
              </div>
              <LeagueSelectButton leagueId={league.id} />
            </div>
          ))}
        </div>
      )}

      {/* Join another league */}
      <div className="card">
        <h2 className="font-bold mb-4">הצטרף לליגה נוספת</h2>
        <JoinLeagueForm />
      </div>

      {/* Create league (whitelisted only) */}
      {isWhitelisted && (
        <div className="card mt-3">
          <h2 className="font-bold mb-2">הקם ליגה חדשה</h2>
          <p className="text-sm mb-3" style={{ color: 'var(--muted)' }}>יש לך הרשאה להקים ליגה חדשה</p>
          <a href="/create-league" className="btn btn-outline w-full text-center block">הקם ליגה חדשה</a>
        </div>
      )}
    </div>
  )
}
