import { createClient } from '@/lib/supabase/server'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { formatTime, formatDateTime, formatTimeSince, getCurrentSnakePicker } from '@/lib/utils'
import type { League, Team, Auction, SnakePick } from '@/types'
import DraftCountdown from '@/components/DraftCountdown'
import BidForm from '@/components/BidForm'
import RealtimeRefresher from '@/components/RealtimeRefresher'
import JoinLeagueForm from '@/components/JoinLeagueForm'
import { activateOverdueSnakeDraft } from '@/lib/activateDraft'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const cookieStore = await cookies()
  const selectedLeagueId = cookieStore.get('selected_league_id')?.value

  if (!selectedLeagueId) redirect('/leagues')

  const { data: myTeam } = await supabase
    .from('teams').select('*').eq('user_id', user!.id).eq('league_id', selectedLeagueId).maybeSingle()

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

  // ── SNAKE DRAFT DASHBOARD ─────────────────────────────────────────────────────
  if (typedLeague?.draft_type === 'snake') {
    const [{ data: teams }, { data: snakePicks }] = await Promise.all([
      supabase.from('teams').select('*').eq('league_id', selectedLeagueId).eq('approved', true).not('priority_rank', 'is', null).order('priority_rank', { ascending: true }),
      supabase.from('snake_picks').select('*, player:players(name, position), team:teams(name)').eq('league_id', selectedLeagueId).order('overall_pick_number', { ascending: true }),
    ])

    const typedTeams = (teams || []) as Team[]
    const typedPicks = (snakePicks || []) as (SnakePick & { player: { name: string; position: string | null } | null; team: { name: string } | null })[]

    const completedCount = typedPicks.length
    const totalPicks = typedLeague.num_teams * typedLeague.players_per_team
    const isDraftComplete = typedLeague.status === 'completed' || completedCount >= totalPicks
    const currentPickNumber = completedCount + 1

    const currentTeam = isDraftComplete
      ? null
      : getCurrentSnakePicker(completedCount, typedLeague.num_teams, typedTeams, typedLeague.snake_round_config as boolean[] | null)
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
              <div className="flex flex-col gap-2">
                <p className="text-sm" style={{ color: 'var(--muted)' }}>עדיין לא בוצעו בחירות</p>
                <Link href="/draft-board" className="text-xs mt-1" style={{ color: 'var(--primary)' }}>
                  ראה לוח דראפט מלא ←
                </Link>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {[...typedPicks].reverse().slice(0, 6).map(pick => (
                  <div key={pick.id} className="flex items-center gap-2 text-sm">
                    <span className="badge badge-gray text-xs w-6 text-center flex-shrink-0">#{pick.overall_pick_number}</span>
                    <span className="font-medium flex-1" dir="ltr">{pick.player?.name ?? '—'}</span>
                    <span style={{ color: 'var(--muted)' }}>{pick.team?.name ?? '—'}</span>
                  </div>
                ))}
                <Link href="/draft-board" className="text-xs mt-1" style={{ color: 'var(--primary)' }}>
                  ראה לוח דראפט מלא ←
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ── ENVELOPE DRAFT DASHBOARD (unchanged) ─────────────────────────────────────

  const [{ data: featuredAuction }, { data: teams }] =
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
    ])

  const myTeamId = typedMyTeam?.id
  const typedFeatured = featuredAuction as (Auction & { player: { name: string }; nominating_team: { name: string } | null }) | null
  const isActive = typedFeatured?.status === 'active'

  const { data: myActiveBid } = myTeamId && isActive && typedFeatured?.id
    ? await supabase.from('bids').select('amount').eq('auction_id', typedFeatured.id).eq('team_id', myTeamId).maybeSingle()
    : { data: null }

  const typedTeams = (teams || []) as Team[]

  const { data: completedAuctions } = league
    ? await supabase
        .from('auctions')
        .select('id, winning_team_id, winning_bid')
        .eq('league_id', league.id)
        .eq('status', 'completed')
        .not('winning_team_id', 'is', null)
    : { data: [] }

  const completedAuctionIds = (completedAuctions ?? []).map((a: { id: string }) => a.id)
  const { data: completedBids } = completedAuctionIds.length > 0
    ? await supabase
        .from('bids')
        .select('auction_id, team_id, amount')
        .in('auction_id', completedAuctionIds)
    : { data: [] }

  const prairScore: Record<string, number> = {}
  for (const auction of completedAuctions ?? []) {
    const a = auction as { id: string; winning_team_id: string | null; winning_bid: number | null }
    if (!a.winning_team_id || !a.winning_bid) continue
    const auctionBids = (completedBids ?? []) as { auction_id: string; team_id: string; amount: number }[]
    const forThisAuction = auctionBids.filter(b => b.auction_id === a.id)
    const otherBids = forThisAuction.filter(b => b.team_id !== a.winning_team_id)
    const secondHighest = otherBids.length > 0 ? Math.max(...otherBids.map(b => b.amount)) : 0
    const diff = a.winning_bid - secondHighest
    if (diff > 0) {
      prairScore[a.winning_team_id] = (prairScore[a.winning_team_id] ?? 0) + diff
    }
  }

  const prairRanking = typedTeams
    .map(t => ({ team: t, score: prairScore[t.id] ?? 0 }))
    .sort((a, b) => b.score - a.score)

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

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
        <div className="card">
          <h2 className="font-bold mb-1">סדר העלאות</h2>
          <p className="text-xs mb-3" style={{ color: 'var(--muted)' }}>מי מעלה שחקן למכרז עכשיו</p>
          {typedTeams.filter(t => !t.is_complete && t.priority_rank !== null).length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--muted)' }}>הגרלה טרם בוצעה</p>
          ) : (
            <div className="flex flex-col gap-1">
              {typedTeams
                .filter(t => !t.is_complete && t.priority_rank !== null)
                .sort((a, b) => (a.priority_rank ?? 99) - (b.priority_rank ?? 99))
                .map((team, i) => {
                  const isFirst = i === 0
                  const isMe = team.user_id === user?.id
                  return (
                    <div key={team.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm"
                      style={{
                        background: isMe ? 'rgba(99,102,241,0.1)' : isFirst ? 'rgba(234,179,8,0.08)' : 'var(--background)',
                        border: isMe ? '1px solid rgba(99,102,241,0.3)' : isFirst ? '1px solid rgba(234,179,8,0.25)' : '1px solid transparent',
                      }}>
                      <span className="font-bold w-5 text-center" style={{ color: isFirst ? 'var(--warning)' : 'var(--muted)' }}>{i + 1}</span>
                      <span className="font-medium flex-1">{team.name}</span>
                      {isFirst && <span className="badge badge-yellow text-xs">הבא</span>}
                      {isMe && <span className="badge badge-blue text-xs">אתה</span>}
                    </div>
                  )
                })}
            </div>
          )}
        </div>

        <div className="card">
          <h2 className="font-bold mb-1">סדר פריוריטי</h2>
          <p className="text-xs mb-3" style={{ color: 'var(--muted)' }}>מי זוכה בהצעות שוות</p>
          {typedTeams.filter(t => t.tiebreak_rank !== null).length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--muted)' }}>הגרלה טרם בוצעה</p>
          ) : (
            <div className="flex flex-col gap-1">
              {typedTeams
                .filter(t => t.tiebreak_rank !== null)
                .sort((a, b) => (a.tiebreak_rank ?? 99) - (b.tiebreak_rank ?? 99))
                .map((team, i) => {
                  const isFirst = i === 0
                  const isMe = team.user_id === user?.id
                  return (
                    <div key={team.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm"
                      style={{
                        background: isMe ? 'rgba(99,102,241,0.1)' : 'var(--background)',
                        border: isMe ? '1px solid rgba(99,102,241,0.3)' : '1px solid transparent',
                      }}>
                      <span className="font-bold w-5 text-center" style={{ color: isFirst ? 'var(--success)' : 'var(--muted)' }}>{i + 1}</span>
                      <span className="font-medium flex-1">{team.name}</span>
                      {team.is_complete && <span className="badge badge-gray text-xs">הושלם</span>}
                      {isMe && <span className="badge badge-blue text-xs">אתה</span>}
                    </div>
                  )
                })}
            </div>
          )}
        </div>
      </div>

      {typedLeague && (
        <div className="card mt-4">
          <h2 className="font-bold mb-1">פראייר הדראפט 🤦</h2>
          <p className="text-xs mb-3" style={{ color: 'var(--muted)' }}>
            סה״כ עודף תשלום מעל ההצעה השנייה בכל מכרז
          </p>
          {prairRanking.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--muted)' }}>אין נתונים עדיין</p>
          ) : (
            <div className="flex flex-col gap-1">
              {prairRanking.map(({ team, score }, i) => {
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
                    <span className="font-medium flex-1">{team.name}</span>
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
  )
}
