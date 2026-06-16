import { createClient } from '@/lib/supabase/server'
import { cookies } from 'next/headers'
import PlayerSearch from '@/components/PlayerSearch'
import SnakePlayerPicker from '@/components/SnakePlayerPicker'
import SnakeDraftBoard from '@/components/SnakeDraftBoard'
import RealtimeRefresher from '@/components/RealtimeRefresher'
import type { Player, League, Team, SnakePick } from '@/types'
import { formatTime, formatTimeSince, getCurrentSnakePicker } from '@/lib/utils'
import { activateOverdueSnakeDraft } from '@/lib/activateDraft'

export const dynamic = 'force-dynamic'
export const revalidate = 0

type PlayerWithTeam = Player & { drafting_team: { id: string; name: string } | null }

export default async function PlayersPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const cookieStore = await cookies()
  const selectedLeagueId = cookieStore.get('selected_league_id')?.value

  const { data: myTeam } = selectedLeagueId
    ? await supabase.from('teams').select('*').eq('user_id', user!.id).eq('league_id', selectedLeagueId).maybeSingle()
    : await supabase.from('teams').select('*').eq('user_id', user!.id).order('created_at', { ascending: false }).limit(1).maybeSingle()

  const [{ data: adminRow }, { data: createdLeague }] = await Promise.all([
    supabase.from('admin_users').select('league_id').eq('user_id', user!.id).maybeSingle(),
    supabase.from('leagues').select('id').eq('created_by', user!.id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ])

  const leagueId = selectedLeagueId ?? (myTeam as Team | null)?.league_id ?? adminRow?.league_id ?? createdLeague?.id ?? null

  // Auto-start the snake draft if its scheduled start time has passed.
  if (leagueId) await activateOverdueSnakeDraft(leagueId)

  const { data: league } = leagueId
    ? await supabase.from('leagues').select('*').eq('id', leagueId).maybeSingle()
    : { data: null }

  const typedLeague = league as League | null

  // ── SNAKE DRAFT ──────────────────────────────────────────────────────────────
  if (typedLeague?.draft_type === 'snake') {
    return <SnakeDraftPage league={typedLeague} myTeam={myTeam as Team | null} />
  }

  // ── ENVELOPE DRAFT (unchanged) ───────────────────────────────────────────────
  const [{ data: players }, { data: activeAuction }, { data: pendingAuctions }] =
    await Promise.all([
      league
        ? supabase.from('players')
            .select('*, drafting_team:teams!drafted_by_team_id(id, name)')
            .eq('league_id', league.id)
            .order('ranking', { ascending: true, nullsFirst: false })
        : Promise.resolve({ data: [] }),
      league
        ? supabase.from('auctions').select('id, player_id').eq('league_id', league.id).eq('status', 'active').maybeSingle()
        : Promise.resolve({ data: null }),
      league
        ? supabase.from('auctions').select('id, player_id, scheduled_start').eq('league_id', league.id).eq('status', 'pending').order('scheduled_start', { ascending: true })
        : Promise.resolve({ data: [] }),
    ])

  const typedPlayers = (players || []) as PlayerWithTeam[]
  const activeAuctionPlayerId = (activeAuction as { player_id?: string } | null)?.player_id ?? null
  const pendingPlayerIds = new Set((pendingAuctions || []).map((a: { player_id: string }) => a.player_id))
  const pendingStartByPlayerId = Object.fromEntries(
    (pendingAuctions || []).map((a: { player_id: string; scheduled_start: string }) => [a.player_id, a.scheduled_start])
  )

  const available = typedPlayers.filter(p => p.status === 'available')
  const onAuction = typedPlayers.filter(p => p.status === 'on_auction')
  const drafted = typedPlayers.filter(p => p.status === 'drafted')

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">שחקנים</h1>
        <div className="flex gap-2 text-sm">
          <span className="badge badge-green">{available.length} זמינים</span>
          {onAuction.filter(p => p.id === activeAuctionPlayerId).length > 0 && (
            <span className="badge badge-yellow">{onAuction.filter(p => p.id === activeAuctionPlayerId).length} במכרז</span>
          )}
          {onAuction.filter(p => pendingPlayerIds.has(p.id)).length > 0 && (
            <span className="badge badge-gray">{onAuction.filter(p => pendingPlayerIds.has(p.id)).length} מתוזמן</span>
          )}
          <span className="badge badge-gray">{drafted.length} נרכשו</span>
        </div>
      </div>

      {typedLeague && typedLeague.status !== 'active' && (
        <div className="card mb-4" style={{ borderColor: 'var(--border)' }}>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            הדראפט טרם החל — כפתורי ההעלאה יופיעו כשהדראפט יהיה פעיל.
          </p>
        </div>
      )}

      {onAuction.map(p => {
        const isPending = pendingPlayerIds.has(p.id)
        const pendingStart = pendingStartByPlayerId[p.id]
        return (
          <div key={p.id} className="card mb-4" style={{ borderColor: isPending ? 'var(--muted)' : 'var(--warning)', borderWidth: 2 }}>
            <span className={`badge ${isPending ? 'badge-gray' : 'badge-yellow'} mb-2`}>
              {isPending && pendingStart
                ? `מתוזמן — יפתח ב-${formatTime(pendingStart)}`
                : 'במכרז עכשיו'}
            </span>
            <p className="font-bold text-xl">{p.name}</p>
            <p className="text-sm" style={{ color: 'var(--muted)' }}>{p.position} · {p.nba_team}</p>
          </div>
        )
      })}

      <PlayerSearch
        players={available.map(p => ({ id: p.id, name: p.name, position: p.position, nba_team: p.nba_team, ranking: p.ranking }))}
      />

      {drafted.length > 0 && (
        <div className="card mt-4">
          <h2 className="font-bold mb-3" style={{ color: 'var(--muted)' }}>נרכשו ({drafted.length})</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
                  <th className="text-right pb-2">שחקן</th>
                  <th className="text-right pb-2 w-14">מחיר</th>
                  <th className="text-right pb-2">קבוצה</th>
                </tr>
              </thead>
              <tbody>
                {drafted.map(p => (
                  <tr key={p.id} className="border-t" style={{ borderColor: 'var(--border)', opacity: 0.65 }}>
                    <td className="py-2">
                      <div className="flex items-center gap-2">
                        {p.position && (
                          <span className="badge badge-gray text-xs w-8 text-center flex-shrink-0">{p.position}</span>
                        )}
                        <span className="font-medium" dir="ltr">{p.name}</span>
                      </div>
                    </td>
                    <td className="py-2 font-bold" style={{ color: 'var(--danger)' }}>
                      ${p.draft_price}
                    </td>
                    <td className="py-2 font-medium" style={{ color: 'var(--success)' }}>
                      {p.drafting_team?.name ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Snake Draft page (server component) ──────────────────────────────────────

async function SnakeDraftPage({
  league,
  myTeam,
}: {
  league: League
  myTeam: Team | null
}) {
  const supabase = await createClient()
  const adminClient = (await import('@/lib/supabase/server')).createAdminClient()

  const [{ data: players }, { data: teams }, { data: snakePicks }] = await Promise.all([
    supabase.from('players')
      .select('*, drafting_team:teams!drafted_by_team_id(id, name)')
      .eq('league_id', league.id)
      .order('ranking', { ascending: true, nullsFirst: false }),
    supabase.from('teams')
      .select('*')
      .eq('league_id', league.id)
      .eq('approved', true)
      .not('priority_rank', 'is', null)
      .order('priority_rank', { ascending: true }),
    supabase.from('snake_picks')
      .select('*, player:players(name, position), team:teams(name)')
      .eq('league_id', league.id)
      .order('overall_pick_number', { ascending: true }),
  ])

  const typedTeams = (teams || []) as Team[]
  const typedPicks = (snakePicks || []) as (SnakePick & { player: { name: string; position: string | null } | null })[]
  const typedPlayers = (players || []) as PlayerWithTeam[]

  const available = typedPlayers.filter(p => p.status === 'available')
  const drafted = typedPlayers.filter(p => p.status === 'drafted')

  const totalPicks = league.num_teams * league.players_per_team
  const completedCount = typedPicks.length
  const currentPickNumber = completedCount + 1
  const isDraftComplete = league.status === 'completed' || completedCount >= totalPicks

  const currentTeam = isDraftComplete
    ? null
    : getCurrentSnakePicker(completedCount, league.num_teams, typedTeams, league.snake_round_config as boolean[] | null)

  // A user may only pick for their own team, and only on their own turn.
  // Admins pick on behalf of a team from the dedicated admin-panel tool.
  const isMyTurn = !!currentTeam && !!myTeam && currentTeam.id === myTeam.id
  const canPick = league.status === 'active' && !isDraftComplete && isMyTurn

  const lastPick = typedPicks[typedPicks.length - 1]
  const timeSinceLast = lastPick ? formatTimeSince(lastPick.picked_at) : null

  return (
    <div className="max-w-5xl mx-auto">
      <RealtimeRefresher leagueId={league.id} />

      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">דראפט סנייק</h1>
        <div className="flex gap-2 text-sm">
          <span className="badge badge-green">{available.length} זמינים</span>
          <span className="badge badge-gray">{drafted.length} נבחרו</span>
        </div>
      </div>

      {/* Status banner */}
      {league.status !== 'active' && !isDraftComplete && (
        <div className="card mb-4" style={{ borderColor: 'var(--border)' }}>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            הדראפט טרם החל.
          </p>
        </div>
      )}

      {isDraftComplete && (
        <div className="card mb-4" style={{ borderColor: 'var(--success)', borderWidth: 2 }}>
          <p className="font-bold" style={{ color: 'var(--success)' }}>הדראפט הסתיים!</p>
        </div>
      )}

      {/* On the clock card */}
      {league.status === 'active' && !isDraftComplete && currentTeam && (
        <div
          className="card mb-4"
          style={{
            borderColor: isMyTurn ? 'var(--primary)' : 'var(--warning)',
            borderWidth: 2,
            background: isMyTurn ? 'rgba(99,102,241,0.06)' : 'rgba(234,179,8,0.06)',
          }}
        >
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <p className="text-xs font-medium mb-1" style={{ color: 'var(--muted)' }}>
                בחירה #{currentPickNumber} מתוך {totalPicks}
              </p>
              <p className="font-bold text-lg">
                {isMyTurn ? 'התור שלך!' : `תור: ${currentTeam.name}`}
              </p>
              {timeSinceLast && (
                <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
                  הבחירה הקודמת לפני {timeSinceLast}
                </p>
              )}
            </div>
            <div className="text-right">
              <p className="text-xs" style={{ color: 'var(--muted)' }}>
                סיבוב {Math.ceil(currentPickNumber / league.num_teams)} מתוך {league.players_per_team}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Player picker */}
      {league.status === 'active' && !isDraftComplete && (
        <div className="mb-4">
          <SnakePlayerPicker
            players={available.map(p => ({ id: p.id, name: p.name, position: p.position, nba_team: p.nba_team, ranking: p.ranking }))}
            leagueId={league.id}
            canPick={canPick}
          />
        </div>
      )}

      {/* Draft board */}
      {typedTeams.length > 0 && (
        <div className="card mb-4">
          <h2 className="font-bold mb-3">לוח הדראפט</h2>
          <SnakeDraftBoard
            teams={typedTeams}
            snakePicks={typedPicks}
            numTeams={league.num_teams}
            playersPerTeam={league.players_per_team}
            snakeRoundConfig={league.snake_round_config as boolean[] | null}
            currentPickNumber={isDraftComplete ? totalPicks + 1 : currentPickNumber}
            myTeamId={myTeam?.id ?? null}
          />
        </div>
      )}
    </div>
  )
}
