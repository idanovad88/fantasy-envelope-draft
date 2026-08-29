import { createClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'
import { cookies } from 'next/headers'
import PlayerSearch from '@/components/PlayerSearch'
import PlayerPicker from '@/components/PlayerPicker'
import SnakeDraftBoard from '@/components/SnakeDraftBoard'
import RealtimeRefresher from '@/components/RealtimeRefresher'
import type { Player, League, Team, SnakePick } from '@/types'
import {
  formatTime,
  formatTimeSince,
  getCurrentSnakePicker,
  buildPickOverridesMap,
  getOpenNominationOrder,
  isWithinDraftHours,
} from '@/lib/utils'
import { myTeamOr } from '@/lib/team'
import { activateOverdueSnakeDraft } from '@/lib/activateDraft'
import { settleOpenDraft } from '@/lib/openDraft'

export const dynamic = 'force-dynamic'
export const revalidate = 0

type PlayerWithTeam = Player & { drafting_team: { id: string; name: string } | null }

export default async function PlayersPage() {
  const supabase = await createClient()
  const user = await getAuthUser(supabase)

  const cookieStore = await cookies()
  const selectedLeagueId = cookieStore.get('selected_league_id')?.value

  const { data: myTeam } = selectedLeagueId
    ? await supabase.from('teams').select('*').or(myTeamOr(user!.id)).eq('league_id', selectedLeagueId).limit(1).maybeSingle()
    : await supabase.from('teams').select('*').or(myTeamOr(user!.id)).order('created_at', { ascending: false }).limit(1).maybeSingle()

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

  // ── OPEN OUTCRY DRAFT ────────────────────────────────────────────────────────
  if (typedLeague?.draft_type === 'open') {
    return <OpenDraftPlayersPage league={typedLeague} myTeam={myTeam as Team | null} />
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
  const drafted = typedPlayers.filter(p => p.status === 'drafted')

  // Order on-auction players by when they go up: the active auction first,
  // then pending auctions by their scheduled start time — not by ranking.
  const auctionOrder = new Map<string, number>()
  if (activeAuctionPlayerId) auctionOrder.set(activeAuctionPlayerId, 0)
  ;(pendingAuctions || []).forEach((a: { player_id: string }, i: number) =>
    auctionOrder.set(a.player_id, i + 1)
  )
  const onAuction = typedPlayers
    .filter(p => p.status === 'on_auction')
    .sort((a, b) => (auctionOrder.get(a.id) ?? Infinity) - (auctionOrder.get(b.id) ?? Infinity))

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

  const [{ data: players }, { data: teams }, { data: snakePicks }, { data: overrideRows }] = await Promise.all([
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
    supabase.from('pick_overrides')
      .select('overall_pick_number, owner_team_id')
      .eq('league_id', league.id),
  ])

  const typedTeams = (teams || []) as Team[]
  const overridesMap = buildPickOverridesMap(overrideRows as { overall_pick_number: number; owner_team_id: string }[] | null)
  const overridesObj = Object.fromEntries(overridesMap)
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
    : getCurrentSnakePicker(completedCount, league.num_teams, typedTeams, league.snake_round_config as boolean[] | null, overridesMap)

  // A user may only pick for their own team (as owner or assistant), and only on their own turn.
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
          <PlayerPicker
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
            overrides={overridesObj}
          />
        </div>
      )}
    </div>
  )
}

// ── Open outcry players page (server component) ──────────────────────────────

async function OpenDraftPlayersPage({
  league,
  myTeam,
}: {
  league: League
  myTeam: Team | null
}) {
  const supabase = await createClient()

  await settleOpenDraft(league.id)

  const [{ data: players }, { data: teams }, { data: openRows }] = await Promise.all([
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
    supabase.from('open_auctions')
      .select('id, current_price, leader_team_id, player:players(name, position, nba_team)')
      .eq('league_id', league.id)
      .eq('status', 'open')
      .order('created_at', { ascending: true }),
  ])

  const typedPlayers = (players || []) as PlayerWithTeam[]
  const typedTeams = (teams || []) as Team[]
  const board = (openRows ?? []) as unknown as {
    id: string
    current_price: number
    leader_team_id: string | null
    player: { name: string; position: string | null; nba_team: string | null } | null
  }[]

  const available = typedPlayers.filter(p => p.status === 'available')
  const drafted = typedPlayers.filter(p => p.status === 'drafted')

  // Money a team has tied up in auctions it is currently leading — the same
  // input the nomination eligibility check uses in SQL.
  const leadingByTeam = new Map<string, { sum: number; count: number }>()
  for (const a of board) {
    if (!a.leader_team_id) continue
    const cur = leadingByTeam.get(a.leader_team_id) ?? { sum: 0, count: 0 }
    leadingByTeam.set(a.leader_team_id, {
      sum: cur.sum + a.current_price,
      count: cur.count + 1,
    })
  }

  const order = getOpenNominationOrder(
    typedTeams,
    board.length,
    league.open_board_size,
    league.players_per_team,
    leadingByTeam
  )

  const running =
    league.status === 'active' &&
    isWithinDraftHours(league.draft_start_hour, league.draft_end_hour)
  const myTurn = !!myTeam && !!order.find(o => o.team.id === myTeam.id)?.canNominateNow
  const canNominate = running && myTurn

  const upNext = order.filter(o => o.canNominateNow)

  return (
    <div className="max-w-4xl mx-auto">
      <RealtimeRefresher leagueId={league.id} openBoard />

      <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
        <h1 className="text-2xl font-bold">שחקנים</h1>
        <div className="flex gap-2 text-sm">
          <span className="badge badge-green">{available.length} זמינים</span>
          {board.length > 0 && <span className="badge badge-yellow">{board.length} במכרז</span>}
          <span className="badge badge-gray">{drafted.length} נרכשו</span>
        </div>
      </div>

      {/* Whose turn it is to put a player up */}
      <div className="card mb-4" style={canNominate ? { borderColor: 'var(--primary)', borderWidth: 2 } : undefined}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="text-xs font-medium mb-1" style={{ color: 'var(--muted)' }}>
              {board.length}/{league.open_board_size} שחקנים על הלוח
            </p>
            <p className="font-bold">
              {!running
                ? league.status === 'paused'
                  ? 'הדראפט מושהה'
                  : league.status === 'active'
                    ? 'מחוץ לשעות הפעילות'
                    : 'הדראפט טרם החל'
                : canNominate
                  ? 'תורך להעלות שחקן!'
                  : upNext.length > 0
                    // Only the head of the queue, to match the dashboard card.
                    // More teams may be eligible when the board has several free
                    // slots; the free-slot count above already says so.
                    ? `תור: ${upNext[0].team.name}`
                    : 'הלוח מלא — אין העלאות כרגע'}
            </p>
          </div>
        </div>
      </div>

      {/* On the board now */}
      {board.map(a => (
        <div key={a.id} className="card mb-3" style={{ borderColor: 'var(--warning)', borderWidth: 2 }}>
          <span className="badge badge-yellow mb-2">במכרז עכשיו · ${a.current_price}</span>
          <p className="font-bold text-xl">{a.player?.name}</p>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            {[a.player?.position, a.player?.nba_team].filter(Boolean).join(' · ')}
          </p>
        </div>
      ))}

      <PlayerPicker
        players={available.map(p => ({ id: p.id, name: p.name, position: p.position, nba_team: p.nba_team, ranking: p.ranking }))}
        leagueId={league.id}
        canPick={canNominate}
        endpoint="/api/open/nominate"
        actionLabel="העלה"
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
                    <td className="py-2 font-bold" style={{ color: 'var(--danger)' }}>${p.draft_price}</td>
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
