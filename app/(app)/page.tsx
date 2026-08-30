import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import {
  formatTime,
  formatDateTime,
  formatTimeSince,
  getCurrentSnakePicker,
  buildPickOverridesMap,
  getEnvelopeNominationOrder,
  getMaxBid,
  getOpenMaxBid,
  getOpenNominationOrder,
  isWithinDraftHours,
} from '@/lib/utils'
import { myTeamOr } from '@/lib/team'
import type { League, Team, Auction, SnakePick } from '@/types'
import DraftCountdown from '@/components/DraftCountdown'
import BidForm from '@/components/BidForm'
import RealtimeRefresher from '@/components/RealtimeRefresher'
import JoinLeagueForm from '@/components/JoinLeagueForm'
import AssistantManager from '@/components/AssistantManager'
import PushSubscribe from '@/components/PushSubscribe'
import { activateOverdueSnakeDraft } from '@/lib/activateDraft'
import { settleOpenDraft } from '@/lib/openDraft'

// Subtle horizontal progress row: a thin dark track that blends into the card,
// with a muted fill showing the portion of the draft/budget already used up.
// Deliberately understated so it reads as a hint, not a headline.
function ProgressRow({ label, pct }: { label: string; pct: number }) {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)))
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs flex-shrink-0" style={{ color: 'var(--muted)', width: '3rem' }}>{label}</span>
      <div className="flex-1 rounded-full overflow-hidden" style={{ height: 6, background: 'var(--background)' }}>
        <div style={{ height: '100%', width: `${clamped}%`, background: 'var(--muted)', borderRadius: 9999, transition: 'width 0.4s ease' }} />
      </div>
      <span className="text-xs font-medium flex-shrink-0 text-left" style={{ color: 'var(--muted)', width: '2.25rem' }}>{clamped}%</span>
    </div>
  )
}

export default async function DashboardPage() {
  const supabase = await createClient()
  const user = await getAuthUser(supabase)
  const cookieStore = await cookies()
  const selectedLeagueId = cookieStore.get('selected_league_id')?.value

  if (!selectedLeagueId) redirect('/leagues')

  const { data: myTeam } = await supabase
    .from('teams').select('*').or(myTeamOr(user!.id)).eq('league_id', selectedLeagueId).limit(1).maybeSingle()

  const { data: createdLeague } = !myTeam
    ? await supabase.from('leagues').select('*').eq('created_by', user!.id).eq('id', selectedLeagueId).maybeSingle()
    : { data: null }

  const { data: whitelistRow } = !myTeam && !createdLeague
    ? await supabase.from('league_creator_whitelist').select('email').eq('email', user!.email ?? '').maybeSingle()
    : { data: null }
  const isWhitelisted = !!whitelistRow

  // Auto-start the snake draft if its scheduled start time has passed.
  await activateOverdueSnakeDraft(selectedLeagueId)

  const { data: league } = await supabase.from('leagues').select('*').eq('id', selectedLeagueId).maybeSingle()
  const typedLeague = league as League | null
  const typedMyTeam = myTeam as Team | null

  // Team-assistant manager card — the owner invites/removes, the assistant may step down.
  const isTeamOwner = !!typedMyTeam && typedMyTeam.user_id === user!.id
  const isTeamAssistant = !!typedMyTeam && typedMyTeam.assistant_user_id === user!.id
  let assistantEmail: string | null = null
  if (isTeamOwner && typedMyTeam!.assistant_user_id) {
    const adminDb = createAdminClient()
    const { data: assistantUser } = await adminDb.auth.admin.getUserById(typedMyTeam!.assistant_user_id)
    assistantEmail = assistantUser.user?.email ?? null
  }

  // ── SNAKE DRAFT DASHBOARD ─────────────────────────────────────────────────────
  if (typedLeague?.draft_type === 'snake') {
    const [{ data: teams }, { data: snakePicks }, { data: overrideRows }] = await Promise.all([
      supabase.from('teams').select('*').eq('league_id', selectedLeagueId).eq('approved', true).not('priority_rank', 'is', null).order('priority_rank', { ascending: true }),
      supabase.from('snake_picks').select('*, player:players(name, position), team:teams(name)').eq('league_id', selectedLeagueId).order('overall_pick_number', { ascending: true }),
      supabase.from('pick_overrides').select('overall_pick_number, owner_team_id').eq('league_id', selectedLeagueId),
    ])

    const typedTeams = (teams || []) as Team[]
    const overridesMap = buildPickOverridesMap(overrideRows as { overall_pick_number: number; owner_team_id: string }[] | null)
    const typedPicks = (snakePicks || []) as (SnakePick & { player: { name: string; position: string | null } | null; team: { name: string } | null })[]

    const completedCount = typedPicks.length
    const totalPicks = typedLeague.num_teams * typedLeague.players_per_team
    const isDraftComplete = typedLeague.status === 'completed' || completedCount >= totalPicks
    const currentPickNumber = completedCount + 1

    const currentTeam = isDraftComplete
      ? null
      : getCurrentSnakePicker(completedCount, typedLeague.num_teams, typedTeams, typedLeague.snake_round_config as boolean[] | null, overridesMap)
    const isMyTurn = !!currentTeam && !!typedMyTeam && currentTeam.id === typedMyTeam.id
    const lastPick = typedPicks[typedPicks.length - 1]
    const timeSinceLast = lastPick ? formatTimeSince(lastPick.picked_at) : null

    return (
      <div className="max-w-4xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold mb-1">{typedLeague.name}</h1>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            <span>דראפט סנייק · {typedTeams.length}/{typedLeague.num_teams} קבוצות</span>
            {typedTeams.filter(t => t.is_complete).length > 0 && (
              <span> · {typedTeams.filter(t => t.is_complete).length} השלימו</span>
            )}
          </p>
        </div>

        <RealtimeRefresher leagueId={typedLeague.id} />

        {/* Draft progress — snake has no budget, only picks made vs remaining */}
        <div className="card mb-4">
          <h2 className="font-bold mb-1">מצב הדראפט</h2>
          <p className="text-xs mb-3" style={{ color: 'var(--muted)' }}>
            שחקנים שנבחרו בכל הליגה
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="text-center p-3 rounded-lg" style={{ background: 'var(--background)' }}>
              <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>שחקנים שנבחרו</p>
              <p className="font-bold text-xl">
                {completedCount}
                <span className="text-sm font-normal" style={{ color: 'var(--muted)' }}>/{totalPicks}</span>
              </p>
            </div>
            <div className="text-center p-3 rounded-lg" style={{ background: 'var(--background)' }}>
              <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>שחקנים שנותרו</p>
              <p className="font-bold text-xl">{Math.max(0, totalPicks - completedCount)}</p>
            </div>
          </div>
          <div className="flex flex-col gap-2.5 mt-4 pt-4" style={{ borderTop: '1px solid var(--border)' }}>
            <ProgressRow label="דראפט" pct={totalPicks > 0 ? (completedCount / totalPicks) * 100 : 0} />
          </div>
        </div>

        {/* Countdown before draft starts */}
        {typedLeague.draft_start_time && ['setup', 'lottery'].includes(typedLeague.status) && (
          <DraftCountdown targetDate={typedLeague.draft_start_time} />
        )}

        {/* Status */}
        {typedLeague.status !== 'active' && !isDraftComplete && (
          <div className="card mb-4" style={{ borderColor: 'var(--border)' }}>
            <p className="text-sm" style={{ color: 'var(--muted)' }}>הדראפט טרם החל.</p>
          </div>
        )}

        {isDraftComplete && (
          <div className="card mb-4" style={{ borderColor: 'var(--success)', borderWidth: 2 }}>
            <p className="font-bold" style={{ color: 'var(--success)' }}>הדראפט הסתיים!</p>
          </div>
        )}

        {/* On the clock */}
        {typedLeague.status === 'active' && !isDraftComplete && currentTeam && (
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
              <div className="text-left">
                <p className="text-xs" style={{ color: 'var(--muted)' }}>
                  סיבוב {Math.ceil(currentPickNumber / typedLeague.num_teams)} / {typedLeague.players_per_team}
                </p>
                {isMyTurn && (
                  <Link href="/players" className="btn btn-primary mt-2 text-sm">בחר שחקן</Link>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* My team card */}
          <div className="card">
            <h2 className="font-bold mb-3">הקבוצה שלי</h2>
            {typedMyTeam ? (
              <div>
                <p className="font-bold text-xl mb-1">{typedMyTeam.name}</p>
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <div className="text-center p-3 rounded-lg" style={{ background: 'var(--background)' }}>
                    <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>שחקנים</p>
                    <p className="font-bold text-lg">
                      {typedMyTeam.player_count}/{typedLeague.players_per_team}
                    </p>
                  </div>
                  <div className="text-center p-3 rounded-lg" style={{ background: 'var(--background)' }}>
                    <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>מיקום בחירה</p>
                    <p className="font-bold text-lg">
                      {typedMyTeam.priority_rank ?? '—'}
                    </p>
                  </div>
                </div>
                <Link href="/teams" className="btn btn-outline w-full mt-3 text-sm">צפה בקבוצה</Link>
                {(isTeamOwner || isTeamAssistant) && (
                  <AssistantManager
                    teamId={typedMyTeam.id}
                    hasAssistant={!!typedMyTeam.assistant_user_id}
                    assistantEmail={assistantEmail}
                    role={isTeamOwner ? 'owner' : 'assistant'}
                  />
                )}
              </div>
            ) : createdLeague ? (
              <div>
                <p className="font-bold text-xl mb-1">מנהל הליגה</p>
                <p className="text-sm mb-3" style={{ color: 'var(--muted)' }}>{createdLeague.name}</p>
                <Link href="/admin" className="btn btn-primary w-full mt-3 text-sm">פאנל ניהול</Link>
              </div>
            ) : (
              <div className="py-2">
                <p className="font-medium mb-4">ברוך הבא! הצטרף לליגה קיימת:</p>
                <JoinLeagueForm />
              </div>
            )}
          </div>

          {/* Recent picks */}
          <div className="card">
            <h2 className="font-bold mb-3">בחירות אחרונות</h2>
            {typedPicks.length === 0 ? (
              <p className="text-sm" style={{ color: 'var(--muted)' }}>עדיין לא בוצעו בחירות</p>
            ) : (
              <div className="flex flex-col gap-2">
                {[...typedPicks].reverse().slice(0, 6).map(pick => (
                  <div key={pick.id} className="flex items-center gap-2 text-sm">
                    <span className="badge badge-gray text-xs w-6 text-center flex-shrink-0">#{pick.overall_pick_number}</span>
                    <span className="font-medium flex-1" dir="ltr">{pick.player?.name ?? '—'}</span>
                    <span style={{ color: 'var(--muted)' }}>{pick.team?.name ?? '—'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Full draft board — prominent entry point */}
        <Link
          href="/draft-board"
          className="card mt-4 flex items-center justify-between gap-3 transition-colors"
          style={{ borderColor: 'var(--primary)', borderWidth: 2, background: 'rgba(99,102,241,0.06)' }}
        >
          <div className="flex items-center gap-3">
            <span className="text-2xl" aria-hidden>🗂️</span>
            <div>
              <p className="font-bold">לוח הדראפט המלא</p>
              <p className="text-xs" style={{ color: 'var(--muted)' }}>
                כל הבחירות — שבוצעו והעתידיות
              </p>
            </div>
          </div>
          <span className="text-xl" style={{ color: 'var(--primary)' }} aria-hidden>←</span>
        </Link>
      </div>
    )
  }

  // ── OPEN OUTCRY DASHBOARD ────────────────────────────────────────────────────
  if (typedLeague?.draft_type === 'open') {
    await settleOpenDraft(selectedLeagueId)

    const [{ data: teams }, { data: openRows }, { data: recentRows }] = await Promise.all([
      supabase.from('teams').select('*').eq('league_id', selectedLeagueId).eq('approved', true)
        .not('priority_rank', 'is', null).order('priority_rank', { ascending: true }),
      supabase.from('open_auctions')
        .select('id, current_price, leader_team_id, deadline_at, player:players(name), leader_team:teams!leader_team_id(name)')
        .eq('league_id', selectedLeagueId).eq('status', 'open')
        .order('created_at', { ascending: true }),
      // Winners only, straight off the auction row — the bid ledger is never
      // read league-wide (it would cross the 1000-row cap mid-draft).
      supabase.from('open_auctions')
        .select('id, updated_at, winning_bid, player:players(name), winning_team:teams!winning_team_id(name)')
        .eq('league_id', selectedLeagueId).eq('status', 'completed')
        .order('updated_at', { ascending: false }).limit(6),
    ])

    const typedTeams = (teams || []) as Team[]
    const board = (openRows ?? []) as unknown as {
      id: string
      current_price: number
      leader_team_id: string | null
      deadline_at: string
      player: { name: string } | null
      leader_team: { name: string } | null
    }[]
    const recent = (recentRows ?? []) as unknown as {
      id: string
      winning_bid: number | null
      player: { name: string } | null
      winning_team: { name: string } | null
    }[]

    const leadingByTeam = new Map<string, { sum: number; count: number }>()
    for (const a of board) {
      if (!a.leader_team_id) continue
      const cur = leadingByTeam.get(a.leader_team_id) ?? { sum: 0, count: 0 }
      leadingByTeam.set(a.leader_team_id, { sum: cur.sum + a.current_price, count: cur.count + 1 })
    }

    const order = getOpenNominationOrder(
      typedTeams, board.length, typedLeague.open_board_size, typedLeague.players_per_team, leadingByTeam
    )

    const running = typedLeague.status === 'active' &&
      isWithinDraftHours(typedLeague.draft_start_hour, typedLeague.draft_end_hour)
    const myLeading = typedMyTeam ? leadingByTeam.get(typedMyTeam.id) ?? { sum: 0, count: 0 } : { sum: 0, count: 0 }
    const myMaxBid = typedMyTeam
      ? getOpenMaxBid(typedMyTeam.budget_remaining, typedMyTeam.player_count, typedLeague.players_per_team, myLeading.sum, myLeading.count)
      : 0
    const myTurn = !!typedMyTeam && !!order.find(o => o.team.id === typedMyTeam.id)?.canNominateNow

    const totalPicks = typedLeague.num_teams * typedLeague.players_per_team
    const draftedCount = typedTeams.reduce((s, t) => s + t.player_count, 0)

    return (
      <div className="max-w-4xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold mb-1">{typedLeague.name}</h1>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            מכרז פתוח · {typedTeams.length}/{typedLeague.num_teams} קבוצות
            {typedTeams.filter(t => t.is_complete).length > 0 &&
              ` · ${typedTeams.filter(t => t.is_complete).length} השלימו`}
          </p>
        </div>

        <RealtimeRefresher leagueId={typedLeague.id} openBoard />

        {typedLeague.draft_start_time && ['setup', 'lottery'].includes(typedLeague.status) && (
          <DraftCountdown targetDate={typedLeague.draft_start_time} />
        )}

        {!running && typedLeague.status !== 'completed' && (
          <div className="card mb-4" style={{ borderColor: 'var(--warning)' }}>
            <p className="font-bold" style={{ color: 'var(--warning)' }}>
              {typedLeague.status === 'paused'
                ? '⏸ הדראפט מושהה'
                : typedLeague.status === 'active'
                  ? '🌙 מחוץ לשעות הפעילות'
                  : 'הדראפט טרם החל'}
            </p>
            {typedLeague.status === 'active' && (
              <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
                המכרזים יתחדשו ב-{String(typedLeague.draft_start_hour).padStart(2, '0')}:00 · השעונים עצורים
              </p>
            )}
          </div>
        )}

        {typedLeague.status === 'completed' && (
          <div className="card mb-4" style={{ borderColor: 'var(--success)', borderWidth: 2 }}>
            <p className="font-bold" style={{ color: 'var(--success)' }}>הדראפט הסתיים!</p>
          </div>
        )}

        {/* Board summary */}
        <div className="card mb-4">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
            <h2 className="font-bold">הלוח ({board.length}/{typedLeague.open_board_size})</h2>
            <Link href="/auction" className="btn btn-primary text-sm">לוח המכרזים</Link>
          </div>
          {board.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--muted)' }}>אין שחקנים על הלוח כרגע</p>
          ) : (
            <div className="flex flex-col gap-2">
              {board.map(a => (
                <div key={a.id} className="flex items-center gap-2 text-sm">
                  <span className="font-medium flex-1 truncate" dir="ltr">{a.player?.name ?? '—'}</span>
                  <span className="font-bold" style={{ color: 'var(--warning)' }}>${a.current_price}</span>
                  <span
                    className="truncate"
                    style={{
                      color: a.leader_team_id === typedMyTeam?.id ? 'var(--success)' : 'var(--muted)',
                      maxWidth: '8rem',
                    }}
                  >
                    {a.leader_team_id === typedMyTeam?.id ? 'אתה מוביל' : a.leader_team?.name ?? '—'}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-col gap-2.5 mt-4 pt-4" style={{ borderTop: '1px solid var(--border)' }}>
            <ProgressRow label="דראפט" pct={totalPicks > 0 ? (draftedCount / totalPicks) * 100 : 0} />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* My team */}
          <div className="card">
            <h2 className="font-bold mb-3">הקבוצה שלי</h2>
            {typedMyTeam ? (
              <div>
                <p className="font-bold text-xl mb-1">{typedMyTeam.name}</p>
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <div className="text-center p-3 rounded-lg" style={{ background: 'var(--background)' }}>
                    <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>שחקנים</p>
                    <p className="font-bold text-lg">
                      {typedMyTeam.player_count}/{typedLeague.players_per_team}
                      {myLeading.count > 0 && (
                        <span className="text-sm font-normal" style={{ color: 'var(--warning)' }}> +{myLeading.count}</span>
                      )}
                    </p>
                  </div>
                  <div className="text-center p-3 rounded-lg" style={{ background: 'var(--background)' }}>
                    <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>תקציב</p>
                    <p className="font-bold text-lg" style={{ color: 'var(--success)' }}>
                      ${typedMyTeam.budget_remaining}
                    </p>
                  </div>
                </div>
                {/* The two numbers that actually govern a bid: what is already
                    committed to auctions this team leads, and what is left. */}
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <div className="text-center p-3 rounded-lg" style={{ background: 'var(--background)' }}>
                    <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>מחויב במכרזים</p>
                    <p className="font-bold text-lg" style={{ color: 'var(--warning)' }}>${myLeading.sum}</p>
                  </div>
                  <div className="text-center p-3 rounded-lg" style={{ background: 'var(--background)' }}>
                    <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>הצעה מקסימלית</p>
                    <p className="font-bold text-lg">${Math.max(myMaxBid, 0)}</p>
                  </div>
                </div>
                <Link href="/teams" className="btn btn-outline w-full mt-3 text-sm">צפה בקבוצה</Link>
                {(isTeamOwner || isTeamAssistant) && (
                  <AssistantManager
                    teamId={typedMyTeam.id}
                    hasAssistant={!!typedMyTeam.assistant_user_id}
                    assistantEmail={assistantEmail}
                    role={isTeamOwner ? 'owner' : 'assistant'}
                  />
                )}
              </div>
            ) : createdLeague ? (
              <div>
                <p className="font-bold text-xl mb-1">מנהל הליגה</p>
                <p className="text-sm mb-3" style={{ color: 'var(--muted)' }}>{createdLeague.name}</p>
                <Link href="/admin" className="btn btn-primary w-full mt-3 text-sm">פאנל ניהול</Link>
              </div>
            ) : (
              <div className="py-2">
                <p className="font-medium mb-4">ברוך הבא! הצטרף לליגה קיימת:</p>
                <JoinLeagueForm />
              </div>
            )}
          </div>

          {/* Recent wins */}
          <div className="card">
            <h2 className="font-bold mb-3">נסגרו לאחרונה</h2>
            {recent.length === 0 ? (
              <p className="text-sm" style={{ color: 'var(--muted)' }}>עדיין לא נסגרו מכרזים</p>
            ) : (
              <div className="flex flex-col gap-2">
                {recent.map(r => (
                  <div key={r.id} className="flex items-center gap-2 text-sm">
                    <span className="font-medium flex-1 truncate" dir="ltr">{r.player?.name ?? '—'}</span>
                    <span className="font-bold" style={{ color: 'var(--danger)' }}>${r.winning_bid ?? 0}</span>
                    <span className="truncate" style={{ color: 'var(--muted)', maxWidth: '7rem' }}>
                      {r.winning_team?.name ?? '—'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Nomination order. The turn rotates the moment a player goes up, so
            the teams marked here are exactly the ones who may nominate now. */}
        <div className="card mt-4">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
            <h2 className="font-bold">סדר העלאות</h2>
            {myTurn && <Link href="/players" className="btn btn-primary text-sm">העלה שחקן</Link>}
          </div>
          <p className="text-xs mb-3" style={{ color: 'var(--muted)' }}>
            {typedLeague.open_board_size - board.length > 0
              ? `${typedLeague.open_board_size - board.length} מקומות פנויים על הלוח`
              : 'הלוח מלא — ההעלאה הבאה תיפתח כשמכרז ייסגר'}
          </p>
          <div className="flex flex-col gap-2">
            {order.map(({ team, canNominate, canNominateNow, position }) => {
              return (
                <div
                  key={team.id}
                  className="flex items-center gap-2 text-sm"
                  style={{ opacity: canNominate ? 1 : 0.45 }}
                >
                  {/* The green number is the whole marker — no label, since the
                      card's heading already says what the list is. Every team
                      that may nominate right now is marked, not just the head of
                      the queue: with several free board slots they all have a
                      real turn, and marking one of them made the rest look
                      blocked. */}
                  <span className={`badge text-xs w-6 text-center flex-shrink-0 ${canNominateNow ? 'badge-green' : 'badge-gray'}`}>
                    {position}
                  </span>
                  <span className={`flex-1 truncate ${canNominateNow ? 'font-bold' : 'font-medium'}`}>{team.name}</span>
                  {team.is_complete && <span className="badge badge-gray text-xs">הושלם</span>}
                  <span style={{ color: 'var(--muted)' }}>${team.budget_remaining}</span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  // ── ENVELOPE DRAFT DASHBOARD (unchanged) ─────────────────────────────────────

  const [{ data: featuredAuction }, { data: teams }, { data: openAuctions }] =
    await Promise.all([
      league
        ? supabase.from('auctions')
            .select('*, player:players(*), nominating_team:teams!nominating_team_id(name)')
            .eq('league_id', league.id)
            .in('status', ['active', 'pending'])
            .order('scheduled_start', { ascending: true })
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      league
        ? supabase.from('teams').select('*').eq('league_id', league.id).order('priority_rank', { ascending: true, nullsFirst: false })
        : Promise.resolve({ data: [] }),
      // Every nomination already made this cycle — active or merely scheduled.
      league
        ? supabase.from('auctions')
            .select('nominating_team_id')
            .eq('league_id', league.id)
            .in('status', ['active', 'pending'])
        : Promise.resolve({ data: [] }),
    ])

  const myTeamId = typedMyTeam?.id
  const typedFeatured = featuredAuction as (Auction & { player: { name: string }; nominating_team: { name: string } | null }) | null
  const isActive = typedFeatured?.status === 'active'

  const { data: myActiveBid } = myTeamId && isActive && typedFeatured?.id
    ? await supabase.from('bids').select('amount').eq('auction_id', typedFeatured.id).eq('team_id', myTeamId).maybeSingle()
    : { data: null }

  const typedTeams = (teams || []) as Team[]

  const nominationOrder = getEnvelopeNominationOrder(
    typedTeams,
    ((openAuctions || []) as { nominating_team_id: string | null }[]).map(a => a.nominating_team_id),
    typedLeague?.players_per_team
  )
  // Completed teams stay in the list but can never be "next", so the waiting
  // notice has to key off the teams that are still eligible for a turn.
  const allTeamsNominated = nominationOrder.some(n => n.canNominate) && !nominationOrder.some(n => n.isNext)

  // Overpayment is aggregated in Postgres (league_overpayment, see
  // supabase/migration_overpayment_rpc.sql) rather than in this render.
  // It used to fetch every bid of every completed auction — past 1000 rows in
  // the live league, so it needed paginating around the PostgREST row cap —
  // and re-derive the second-highest bid in JS, on every dashboard load, for
  // every viewer. The RPC returns one row per winning team.
  const { data: overpayRows } = league
    ? await supabase.rpc('league_overpayment', { p_league_id: league.id })
    : { data: [] }

  const prairScore: Record<string, number> = {}
  for (const row of (overpayRows ?? []) as { team_id: string; overpay: number }[]) {
    prairScore[row.team_id] = row.overpay
  }

  // A team that finished its roster with money still in the bank never used that
  // budget on anyone — it counts as overpayment on everything it did buy.
  const prairRanking = typedTeams
    .map(t => {
      const overpay = prairScore[t.id] ?? 0
      const leftover = t.is_complete ? Math.max(0, t.budget_remaining) : 0
      return { team: t, overpay, leftover, score: overpay + leftover }
    })
    .sort((a, b) => b.score - a.score)

  // Summary table — one row per approved team, sorted by the money that still
  // matters: the most it can put on the next player. getMaxBid already reserves
  // $1 for every slot after this one, so a full roster reads 0.
  const summaryRows = typedTeams
    .filter(t => t.approved)
    .map(t => ({
      team: t,
      maxBid: getMaxBid(t.budget_remaining, t.player_count, typedLeague?.players_per_team ?? 0),
    }))
    .sort((a, b) => b.maxBid - a.maxBid || b.team.budget_remaining - a.team.budget_remaining)

  // League-wide draft progress: players bought/left and budget spent/remaining.
  // Totals derive from the actual teams so spent + remaining always add up.
  const perTeamBudget = typedLeague?.budget_per_team ?? 0
  const totalSlots = typedTeams.length * (typedLeague?.players_per_team ?? 0)
  const playersBought = typedTeams.reduce((sum, t) => sum + t.player_count, 0)
  const playersLeft = Math.max(0, totalSlots - playersBought)
  const totalBudget = typedTeams.length * perTeamBudget
  const budgetRemaining = typedTeams.reduce((sum, t) => sum + t.budget_remaining, 0)
  const budgetSpent = Math.max(0, totalBudget - budgetRemaining)
  const draftPct = totalSlots > 0 ? (playersBought / totalSlots) * 100 : 0
  const budgetPct = totalBudget > 0 ? (budgetSpent / totalBudget) * 100 : 0

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1">
          {typedLeague ? typedLeague.name : 'פנטזי דראפט מעטפות 🏀'}
        </h1>
        {typedLeague && (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            <span>{typedTeams.length}/{typedLeague.num_teams} הצטרפו</span>
            {typedTeams.filter(t => t.is_complete).length > 0 && (
              <span> · {typedTeams.filter(t => t.is_complete).length} השלימו דראפט</span>
            )}
          </p>
        )}
      </div>

      {typedLeague && (
        <div className="card mb-4">
          <h2 className="font-bold mb-1">מצב הדראפט</h2>
          <p className="text-xs mb-3" style={{ color: 'var(--muted)' }}>
            שחקנים שנקנו ותקציב שנוצל בכל הליגה
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="text-center p-3 rounded-lg" style={{ background: 'var(--background)' }}>
              <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>שחקנים שנקנו</p>
              <p className="font-bold text-xl">
                {playersBought}
                <span className="text-sm font-normal" style={{ color: 'var(--muted)' }}>/{totalSlots}</span>
              </p>
            </div>
            <div className="text-center p-3 rounded-lg" style={{ background: 'var(--background)' }}>
              <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>שחקנים שנותרו</p>
              <p className="font-bold text-xl">{playersLeft}</p>
            </div>
            <div className="text-center p-3 rounded-lg" style={{ background: 'var(--background)' }}>
              <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>תקציב שבוזבז</p>
              <p className="font-bold text-xl" style={{ color: 'var(--danger)' }}>${budgetSpent}</p>
            </div>
            <div className="text-center p-3 rounded-lg" style={{ background: 'var(--background)' }}>
              <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>תקציב שנותר</p>
              <p className="font-bold text-xl" style={{ color: 'var(--success)' }}>${budgetRemaining}</p>
            </div>
          </div>
          <div className="flex flex-col gap-2.5 mt-4 pt-4" style={{ borderTop: '1px solid var(--border)' }}>
            <ProgressRow label="דראפט" pct={draftPct} />
            <ProgressRow label="תקציב" pct={budgetPct} />
          </div>
        </div>
      )}

      <div className={`grid gap-4 ${typedFeatured && isActive ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-2'}`}>
        <div className="card">
          <h2 className="font-bold mb-3">מכרז נוכחי</h2>
          {typedFeatured ? (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="font-bold text-2xl">{typedFeatured.player?.name}</span>
                {isActive
                  ? <span className="badge badge-green">פעיל</span>
                  : <span className="badge badge-gray">⏰ מתוזמן</span>
                }
              </div>
              {isActive ? (
                <p className="text-sm mb-3" style={{ color: 'var(--muted)' }}>
                  חשיפה: {formatTime(typedFeatured.reveal_time)}
                </p>
              ) : (
                <p className="text-sm mb-3" style={{ color: 'var(--muted)' }}>
                  פתיחת הגשות: {formatDateTime(typedFeatured.scheduled_start)}
                </p>
              )}
              {isActive && typedMyTeam && typedLeague && !typedMyTeam.is_complete ? (
                <BidForm
                  auctionId={typedFeatured.id}
                  team={typedMyTeam}
                  league={typedLeague}
                  existingBid={myActiveBid?.amount}
                  revealTime={typedFeatured.reveal_time}
                  isNominator={typedFeatured.nominating_team_id === typedMyTeam.id}
                />
              ) : (
                <Link href="/auction" className="btn btn-outline w-full text-sm">
                  לוח המכרזים
                </Link>
              )}
            </div>
          ) : (
            <div className="text-center py-6" style={{ color: 'var(--muted)' }}>
              <p className="text-3xl mb-2">🏀</p>
              <p>אין מכרז פעיל כרגע</p>
              <Link href="/auction" className="btn btn-outline mt-3 text-sm">
                לוח המכרזים
              </Link>
            </div>
          )}
        </div>

        <div className="card">
          <h2 className="font-bold mb-3">הקבוצה שלי</h2>
          {typedMyTeam ? (
            <div>
              <p className="font-bold text-xl mb-1">{typedMyTeam.name}</p>
              <div className="grid grid-cols-2 gap-3 mt-3">
                <div className="text-center p-3 rounded-lg" style={{ background: 'var(--background)' }}>
                  <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>תקציב</p>
                  <p className="font-bold text-lg" style={{ color: 'var(--success)' }}>
                    ${typedMyTeam.budget_remaining}
                  </p>
                </div>
                <div className="text-center p-3 rounded-lg" style={{ background: 'var(--background)' }}>
                  <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>שחקנים</p>
                  <p className="font-bold text-lg">
                    {typedMyTeam.player_count}/{typedLeague?.players_per_team ?? '—'}
                  </p>
                </div>
              </div>
              <Link href="/teams" className="btn btn-outline w-full mt-3 text-sm">
                צפה בקבוצה
              </Link>
              {(isTeamOwner || isTeamAssistant) && (
                <AssistantManager
                  teamId={typedMyTeam.id}
                  hasAssistant={!!typedMyTeam.assistant_user_id}
                  assistantEmail={assistantEmail}
                  role={isTeamOwner ? 'owner' : 'assistant'}
                />
              )}
              {(isTeamOwner || isTeamAssistant) && <PushSubscribe />}
            </div>
          ) : createdLeague ? (
            <div>
              <p className="font-bold text-xl mb-1">מנהל הליגה</p>
              <p className="text-sm mb-3" style={{ color: 'var(--muted)' }}>{createdLeague.name}</p>
              <div className="grid grid-cols-2 gap-3 mt-3">
                <div className="text-center p-3 rounded-lg" style={{ background: 'var(--background)' }}>
                  <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>קבוצות</p>
                  <p className="font-bold text-lg">{typedTeams.length}/{createdLeague.num_teams}</p>
                </div>
                <div className="text-center p-3 rounded-lg" style={{ background: 'var(--background)' }}>
                  <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>סטטוס</p>
                  <p className="font-bold text-lg capitalize">{createdLeague.status}</p>
                </div>
              </div>
              <Link href="/admin" className="btn btn-primary w-full mt-3 text-sm">פאנל ניהול</Link>
            </div>
          ) : (
            <div className="py-2">
              <p className="font-medium mb-4">ברוך הבא! הצטרף לליגה קיימת:</p>
              <JoinLeagueForm />
              {isWhitelisted && (
                <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--border)' }}>
                  <p className="text-sm mb-2" style={{ color: 'var(--muted)' }}>או</p>
                  <Link href="/create-league" className="btn btn-outline w-full">הקם ליגה חדשה</Link>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {typedLeague?.draft_start_time && ['setup', 'lottery'].includes(typedLeague.status) && (
        <DraftCountdown targetDate={typedLeague.draft_start_time} />
      )}

      {typedLeague && <RealtimeRefresher leagueId={typedLeague.id} />}

      {/* Four cards in one grid so the desktop layout is טבלה מסכמת | סדר פריוריטי
          over סדר העלאות | פראייר, while the mobile (single column) order stays
          טבלה מסכמת → סדר העלאות → סדר פריוריטי → פראייר. Hence the md:order-*. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
        {typedLeague && (
          <div className="card md:order-1">
            <h2 className="font-bold mb-1">טבלה מסכמת</h2>
            <p className="text-xs mb-3" style={{ color: 'var(--muted)' }}>תקציב, שחקנים והצעה מקסימלית לכל קבוצה</p>
            {summaryRows.length === 0 ? (
              <p className="text-sm" style={{ color: 'var(--muted)' }}>אין קבוצות עדיין</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ color: 'var(--muted)' }}>
                      <th className="text-right font-normal text-xs pb-2">קבוצה</th>
                      <th className="text-center font-normal text-xs pb-2">תקציב</th>
                      <th className="text-center font-normal text-xs pb-2">שחקנים</th>
                      <th className="text-center font-normal text-xs pb-2">מקס׳ הצעה</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summaryRows.map(({ team, maxBid }) => {
                      const isMe = team.user_id === user?.id
                      return (
                        <tr key={team.id}
                          style={{
                            background: isMe ? 'rgba(99,102,241,0.1)' : undefined,
                            opacity: team.is_complete ? 0.6 : 1,
                          }}>
                          <td className="py-1.5 px-2 rounded-r-lg font-medium">
                            {team.name}
                            {isMe && <span className="badge badge-blue text-xs mr-1.5">אתה</span>}
                          </td>
                          <td className="py-1.5 px-2 text-center font-bold" style={{ color: 'var(--success)' }}>
                            ${team.budget_remaining}
                          </td>
                          <td className="py-1.5 px-2 text-center">
                            {team.player_count}
                            <span style={{ color: 'var(--muted)' }}>/{typedLeague.players_per_team}</span>
                          </td>
                          <td className="py-1.5 px-2 text-center font-bold rounded-l-lg">
                            {maxBid > 0 ? `$${maxBid}` : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <div className="card md:order-3">
          <h2 className="font-bold mb-1">סדר העלאות</h2>
          <p className="text-xs mb-3" style={{ color: 'var(--muted)' }}>מי מעלה שחקן למכרז עכשיו</p>
          {nominationOrder.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--muted)' }}>הגרלה טרם בוצעה</p>
          ) : (
            <div className="flex flex-col gap-1">
              {nominationOrder.map(({ team, hasNominated, isNext, canNominate }, i) => {
                const isMe = team.user_id === user?.id
                return (
                  <div key={team.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm"
                    style={{
                      background: isMe ? 'rgba(99,102,241,0.1)' : isNext ? 'rgba(234,179,8,0.08)' : 'var(--background)',
                      border: isMe ? '1px solid rgba(99,102,241,0.3)' : isNext ? '1px solid rgba(234,179,8,0.25)' : '1px solid transparent',
                      // Dimmed while its auction is open (no badge — "הבא" alone
                      // carries the turn), and for a team that keeps its slot in
                      // the rotation but can no longer take a turn.
                      opacity: hasNominated || !canNominate ? 0.6 : 1,
                    }}>
                    <span className="font-bold w-5 text-center" style={{ color: isNext ? 'var(--warning)' : 'var(--muted)' }}>{i + 1}</span>
                    <span className="font-medium flex-1">{team.name}</span>
                    {team.is_complete && <span className="badge badge-gray text-xs">הושלם</span>}
                    {isNext && <span className="badge badge-yellow text-xs">הבא</span>}
                    {isMe && <span className="badge badge-blue text-xs">אתה</span>}
                  </div>
                )
              })}
              {allTeamsNominated && (
                <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
                  ממתין לסגירת מכרזים
                </p>
              )}
            </div>
          )}
        </div>

        <div className="card md:order-2">
          <h2 className="font-bold mb-1">סדר פריוריטי</h2>
          <p className="text-xs mb-3" style={{ color: 'var(--muted)' }}>מי זוכה בהצעות שוות</p>
          {typedTeams.filter(t => t.tiebreak_rank !== null).length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--muted)' }}>הגרלה טרם בוצעה</p>
          ) : (
            (() => {
              const tiebreakOrder = typedTeams
                .filter(t => t.tiebreak_rank !== null)
                .sort((a, b) => (a.tiebreak_rank ?? 99) - (b.tiebreak_rank ?? 99))
              // A completed team keeps its slot and rises as the teams above it
              // are demoted, but it can no longer win a player — so the green
              // "wins equal bids" marker belongs to the first team that still can.
              const topEligibleId = tiebreakOrder.find(t => !t.is_complete)?.id
              return (
                <div className="flex flex-col gap-1">
                  {tiebreakOrder.map((team, i) => {
                    const isTopEligible = team.id === topEligibleId
                    const isMe = team.user_id === user?.id
                    return (
                      <div key={team.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm"
                        style={{
                          background: isMe ? 'rgba(99,102,241,0.1)' : 'var(--background)',
                          border: isMe ? '1px solid rgba(99,102,241,0.3)' : '1px solid transparent',
                          opacity: team.is_complete ? 0.6 : 1,
                        }}>
                        <span className="font-bold w-5 text-center" style={{ color: isTopEligible ? 'var(--success)' : 'var(--muted)' }}>{i + 1}</span>
                        <span className="font-medium flex-1">{team.name}</span>
                        {team.is_complete && <span className="badge badge-gray text-xs">הושלם</span>}
                        {isMe && <span className="badge badge-blue text-xs">אתה</span>}
                      </div>
                    )
                  })}
                </div>
              )
            })()
          )}
        </div>

        {typedLeague && (
        <div className="card md:order-4">
          <h2 className="font-bold mb-1">פראייר הדראפט 🤦</h2>
          <p className="text-xs mb-3" style={{ color: 'var(--muted)' }}>
            סה״כ עודף תשלום מעל ההצעה השנייה בכל מכרז · קבוצה שסיימה נספר לה גם הכסף שנשאר
          </p>
          {prairRanking.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--muted)' }}>אין נתונים עדיין</p>
          ) : (
            <div className="flex flex-col gap-1">
              {prairRanking.map(({ team, overpay, leftover, score }, i) => {
                const isMe = team.user_id === user?.id
                const isFirst = i === 0
                return (
                  <div key={team.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm"
                    style={{
                      background: isMe ? 'rgba(99,102,241,0.1)' : isFirst ? 'rgba(239,68,68,0.07)' : 'var(--background)',
                      border: isMe ? '1px solid rgba(99,102,241,0.3)' : isFirst ? '1px solid rgba(239,68,68,0.2)' : '1px solid transparent',
                    }}>
                    <span className="font-bold w-5 text-center" style={{ color: isFirst ? 'var(--danger)' : 'var(--muted)' }}>
                      {i + 1}
                    </span>
                    <span className="font-medium flex-1">
                      {team.name}
                      {leftover > 0 && (
                        <span className="text-xs font-normal mr-1.5" style={{ color: 'var(--muted)' }}>
                          (${overpay} + ${leftover} יתרה)
                        </span>
                      )}
                    </span>
                    <span className="font-bold" style={{ color: isFirst ? 'var(--danger)' : undefined }}>
                      ${score}
                    </span>
                    {isFirst && <span className="badge badge-red text-xs">פראייר 🤦</span>}
                    {isMe && <span className="badge badge-blue text-xs">אתה</span>}
                  </div>
                )
              })}
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  )
}
