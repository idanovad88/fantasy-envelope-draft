import { createClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'
import { cookies } from 'next/headers'
import { activateOverduePendingAuctions } from '@/lib/auctions'
import { settleOpenDraft } from '@/lib/openDraft'
import {
  formatTime,
  formatDateTime,
  formatCurrency,
  getOpenMaxBid,
  getOpenHardMaxBid,
  isWithinDraftHours,
  REVEAL_WINDOW_MS,
} from '@/lib/utils'
import BidForm from '@/components/BidForm'
import Countdown from '@/components/Countdown'
import AuctionHistory from '@/components/AuctionHistory'
import RealtimeRefresher from '@/components/RealtimeRefresher'
import BidRevealOverlay from '@/components/BidRevealOverlay'
import OpenAuctionBoard from '@/components/OpenAuctionBoard'
import { myTeamOr } from '@/lib/team'
import type { Auction, Team, League, OpenPassReason, OpenCloseReason } from '@/types'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function AuctionPage() {
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

  const leagueId = selectedLeagueId ?? myTeam?.league_id ?? adminRow?.league_id ?? createdLeague?.id ?? null

  const { data: league } = leagueId
    ? await supabase.from('leagues').select('*').eq('id', leagueId).maybeSingle()
    : { data: null }

  // The open board is a different page entirely — several auctions at once,
  // public bids, no reveal. Branch before any of the envelope fetching below.
  if ((league as League | null)?.draft_type === 'open') {
    return <OpenBoardPage league={league as League} myTeam={myTeam as Team | null} />
  }

  // Auto-activate any pending auction whose scheduled_start has passed
  if (leagueId) {
    await activateOverduePendingAuctions(leagueId)
  }

  const [{ data: auctions }, { data: myBids }, { data: recentCompleted }] =
    await Promise.all([
      league
        ? supabase.from('auctions')
            // Explicit column list, not `*` — with the whole draft's history now
            // fetched, the full player/bid rows doubled the payload for fields
            // nothing on this page renders.
            .select('id, status, scheduled_start, reveal_time, updated_at, winning_bid, winning_team_id, nominating_team_id, tie_broken_by_priority, player:players(name, position, nba_team), nominating_team:teams!nominating_team_id(name), winning_team:teams!winning_team_id(name), bids(id, team_id, amount, team:teams(name))')
            .eq('league_id', league.id)
            .in('status', ['pending', 'active', 'revealed', 'completed'])
            // No limit: the history must cover the whole draft. A limit of 50 hid
            // every auction past the 50th once a league grew (12 teams × 13 slots
            // = 156 auctions), so old picks showed on team pages but were missing
            // from here. Newest first; pending/past get re-sorted below for display.
            .order('scheduled_start', { ascending: false })
        : Promise.resolve({ data: [] }),
      myTeam
        ? supabase.from('bids').select('*').eq('team_id', myTeam.id)
        : Promise.resolve({ data: [] }),
      league
        ? supabase.from('auctions')
            .select('id, updated_at, winning_team_id, winning_bid, player:players(name)')
            .eq('league_id', league.id)
            .eq('status', 'completed')
            .order('updated_at', { ascending: false })
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ])

  const typedLeague = league as League | null
  const typedMyTeam = myTeam as Team | null

  const recentlyCompleted = recentCompleted && (
    Date.now() - new Date(recentCompleted.updated_at).getTime() < REVEAL_WINDOW_MS
  ) ? {
    id: recentCompleted.id,
    updatedAt: recentCompleted.updated_at,
    winningTeamId: recentCompleted.winning_team_id,
    winningBid: recentCompleted.winning_bid,
    playerName: (recentCompleted.player as unknown as { name: string } | null)?.name ?? 'שחקן',
  } : undefined

  // Shaped to the explicit select above rather than to the full `Auction` row.
  const typedAuctions = (auctions || []) as unknown as (Pick<Auction,
    'id' | 'status' | 'scheduled_start' | 'reveal_time' | 'updated_at' |
    'winning_bid' | 'winning_team_id' | 'nominating_team_id' | 'tie_broken_by_priority'
  > & {
    player: { name: string; position: string | null; nba_team: string | null }
    nominating_team: { name: string } | null
    winning_team: { name: string } | null
    bids: { id: string; team_id: string; amount: number; team: { name: string } | null }[]
  })[]
  const myBidMap = Object.fromEntries((myBids || []).map(b => [b.auction_id, b.amount]))

  const activeAuction = typedAuctions.find(a => a.status === 'active')
  // Pending auctions sorted ascending by scheduled_start (closest first) —
  // re-sorted here because the query now fetches descending.
  const pendingAuctions = typedAuctions.filter(a => a.status === 'pending')
    .sort((a, b) => new Date(a.scheduled_start).getTime() - new Date(b.scheduled_start).getTime())
  // Ordered by when the auction actually resolved (`updated_at`), not by
  // `reveal_time`. An admin closing an auction early leaves `reveal_time` in the
  // past — behind auctions that resolved before it — which buried the newest
  // results mid-list and made them look missing. For every normal auction the
  // two timestamps match to the second, so the usual order is unchanged.
  const resolvedAt = (a: { updated_at: string | null; reveal_time: string }) =>
    new Date(a.updated_at ?? a.reveal_time).getTime()
  const pastAuctions = typedAuctions.filter(a => a.status === 'revealed' || a.status === 'completed')
    .sort((a, b) => resolvedAt(b) - resolvedAt(a))

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">לוח המכרזים</h1>

      {/* Active auction */}
      {activeAuction ? (
        <div className="mb-6">
          <div className="card mb-4 pulse-glow" style={{ borderColor: 'var(--primary)' }}>
            <div className="flex items-start justify-between mb-3">
              <div>
                <span className="badge badge-green mb-2">🟢 מכרז פעיל</span>
                <h2 className="text-2xl font-bold">{activeAuction.player?.name}</h2>
                <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
                  {activeAuction.player?.position} · {activeAuction.player?.nba_team}
                </p>
              </div>
              <Countdown targetDate={activeAuction.reveal_time} label="לחשיפה" />
            </div>
            <p className="text-sm" style={{ color: 'var(--muted)' }}>
              הועלה על ידי: <strong style={{ color: 'var(--text)' }}>{activeAuction.nominating_team?.name ?? '—'}</strong>
              {' · '}חשיפה: <strong style={{ color: 'var(--text)' }}>{formatTime(activeAuction.reveal_time)}</strong>
            </p>
          </div>

          {typedMyTeam && typedLeague && !typedMyTeam.is_complete && (
            <BidForm
              auctionId={activeAuction.id}
              team={typedMyTeam}
              league={typedLeague}
              existingBid={myBidMap[activeAuction.id]}
              revealTime={activeAuction.reveal_time}
              isNominator={activeAuction.nominating_team_id === typedMyTeam.id}
            />
          )}
        </div>
      ) : (
        <div className="card mb-6 text-center py-8" style={{ color: 'var(--muted)' }}>
          <p className="text-4xl mb-2">🏀</p>
          <p>אין מכרז פעיל כרגע</p>
        </div>
      )}

      {/* Pending (upcoming) auctions — sorted by reveal_time ascending */}
      {pendingAuctions.map(auction => (
        <div key={auction.id} className="card mb-4" style={{ borderColor: 'var(--border)', opacity: 0.85 }}>
          <div className="flex items-start justify-between mb-3">
            <div>
              <span className="badge badge-gray mb-2">⏰ ממתין</span>
              <h2 className="text-xl font-bold">{auction.player?.name}</h2>
              <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
                {auction.player?.position} · {auction.player?.nba_team}
              </p>
            </div>
            <Countdown targetDate={auction.scheduled_start} label="לפתיחה" />
          </div>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            פתיחת הגשות: <strong style={{ color: 'var(--text)' }}>{formatDateTime(auction.scheduled_start)}</strong>
            {' · '}סגירה: <strong style={{ color: 'var(--text)' }}>{formatTime(auction.reveal_time)}</strong>
          </p>
          <p className="text-xs mt-2" style={{ color: 'var(--muted)' }}>
            הגשת הצעות תיפתח עם תחילת המכרז
          </p>
        </div>
      ))}

      {/* Past auctions */}
      {pastAuctions.length > 0 && (
        <AuctionHistory auctions={pastAuctions} />
      )}

      {typedLeague && <RealtimeRefresher leagueId={typedLeague.id} />}
      {typedLeague && (
        <BidRevealOverlay
          leagueId={typedLeague.id}
          activeAuctionId={activeAuction?.id ?? null}
          recentlyCompleted={recentlyCompleted}
          myTeamId={typedMyTeam?.id ?? null}
          revealMode={typedLeague.reveal_mode}
          varGifUrls={
            typedLeague.var_gif_urls && typedLeague.var_gif_urls.length > 0
              ? typedLeague.var_gif_urls
              : typedLeague.var_gif_url
                ? [typedLeague.var_gif_url]
                : []
          }
        />
      )}
    </div>
  )
}

// ── Open outcry board ────────────────────────────────────────────────────────
// A second server component in the same file, the same shape players/page.tsx
// already uses for its snake branch.

type OpenRow = {
  id: string
  current_price: number
  leader_team_id: string | null
  deadline_at: string
  player: { name: string; position: string | null; nba_team: string | null } | null
  nominating_team: { name: string } | null
  leader_team: { name: string } | null
  bids: { id: string; team_id: string; amount: number; is_auto: boolean; created_at: string; team: { name: string } | null }[]
  passes: { team_id: string; reason: OpenPassReason; team: { name: string } | null }[]
}

type OpenHistoryRow = {
  id: string
  status: 'completed' | 'cancelled'
  updated_at: string
  winning_bid: number | null
  closed_reason: OpenCloseReason | null
  player: { name: string } | null
  nominating_team: { name: string } | null
  winning_team: { name: string } | null
}

async function OpenBoardPage({ league, myTeam }: { league: League; myTeam: Team | null }) {
  const supabase = await createClient()

  // Freeze/thaw the clocks and close anything already out of time, so the board
  // never renders an auction that visibly expired a minute ago while the cron
  // catches up.
  await settleOpenDraft(league.id)

  const [{ data: openRows }, { data: historyRows }, { data: teams }] = await Promise.all([
    supabase
      .from('open_auctions')
      .select(
        'id, current_price, leader_team_id, deadline_at, player:players(name, position, nba_team), nominating_team:teams!nominating_team_id(name), leader_team:teams!leader_team_id(name), bids:open_bids(id, team_id, amount, is_auto, created_at, team:teams(name)), passes:open_passes(team_id, reason, team:teams(name))'
      )
      .eq('league_id', league.id)
      .eq('status', 'open')
      .order('created_at', { ascending: true }),
    // History deliberately never touches open_bids: the ledger grows with the
    // whole draft (roughly teams × players_per_team × raises) and a league-wide
    // read of it would cross PostgREST's 1000-row cap. Everything shown here is
    // already denormalised onto the auction row.
    supabase
      .from('open_auctions')
      .select(
        'id, status, updated_at, winning_bid, closed_reason, player:players(name), nominating_team:teams!nominating_team_id(name), winning_team:teams!winning_team_id(name)'
      )
      .eq('league_id', league.id)
      .in('status', ['completed', 'cancelled'])
      // No limit — this must be the complete history. Sorted by updated_at
      // rather than deadline_at: an admin closing early leaves the deadline in
      // the past, behind auctions that actually finished before it.
      .order('updated_at', { ascending: false }),
    supabase.from('teams').select('*').eq('league_id', league.id).eq('approved', true),
  ])

  const board = (openRows ?? []) as unknown as OpenRow[]
  const history = (historyRows ?? []) as unknown as OpenHistoryRow[]
  const approvedTeams = (teams ?? []) as Team[]

  // What this team currently has committed, across the whole board. Only
  // auctions it *leads* tie money up — a bid that has been outbid can never
  // turn into a purchase, so it is released at once.
  const myLeading = myTeam ? board.filter(a => a.leader_team_id === myTeam.id) : []
  const myCommitted = myLeading.reduce((sum, a) => sum + a.current_price, 0)
  const myMaxBid = myTeam
    ? getOpenMaxBid(
        myTeam.budget_remaining,
        myTeam.player_count,
        league.players_per_team,
        myCommitted,
        myLeading.length
      )
    : 0
  // The same ceiling with those commitments released. Where the two disagree
  // the team is not out of the auction, only short of cash this minute — the
  // board says so rather than showing a flat "no budget".
  const myHardMaxBid = myTeam
    ? getOpenHardMaxBid(myTeam.budget_remaining, myTeam.player_count, league.players_per_team)
    : 0
  // Slots left once the auctions this team leads are counted as won. At zero it
  // is the roster blocking a bid, not the budget — leading three auctions on a
  // three-slot roster can cost $3 and still block everything.
  const mySlotsLeft = myTeam
    ? league.players_per_team - myTeam.player_count - myLeading.length
    : 0

  const notStarted = league.status === 'setup' || league.status === 'lottery'
  const frozenReason: 'paused' | 'night' | null =
    league.status === 'paused'
      ? 'paused'
      : league.status === 'active' &&
          !isWithinDraftHours(league.draft_start_hour, league.draft_end_hour)
        ? 'night'
        : null

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
        <h1 className="text-2xl font-bold">לוח המכרזים</h1>
        <span className="text-sm" style={{ color: 'var(--muted)' }}>
          {board.length}/{league.open_board_size} שחקנים על הלוח
        </span>
      </div>

      {notStarted && (
        <div className="card mb-4 text-center py-6" style={{ color: 'var(--muted)' }}>
          <p className="font-bold">הדראפט טרם החל</p>
          <p className="text-sm mt-1">המנהל יפתח אותו לאחר הגרלת סדר ההעלאות</p>
        </div>
      )}

      {frozenReason && (
        <div className="card mb-4 text-center py-4" style={{ borderColor: 'var(--warning)' }}>
          <p className="font-bold" style={{ color: 'var(--warning)' }}>
            {frozenReason === 'paused' ? '⏸ הדראפט מושהה' : '🌙 מחוץ לשעות הפעילות'}
          </p>
          <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
            {frozenReason === 'paused'
              ? 'השעונים עצורים. הזמן שנותר לכל מכרז יישמר.'
              : `המכרזים יתחדשו ב-${String(league.draft_start_hour).padStart(2, '0')}:00. הזמן שנותר לכל מכרז יישמר.`}
          </p>
        </div>
      )}

      <OpenAuctionBoard
        auctions={board.map(a => ({
          id: a.id,
          playerName: a.player?.name ?? 'שחקן',
          playerPosition: a.player?.position ?? null,
          playerTeam: a.player?.nba_team ?? null,
          nominatorName: a.nominating_team?.name ?? null,
          currentPrice: a.current_price,
          leaderTeamId: a.leader_team_id,
          leaderName: a.leader_team?.name ?? null,
          deadlineAt: a.deadline_at,
          bids: [...a.bids]
            .sort((x, y) => new Date(y.created_at).getTime() - new Date(x.created_at).getTime())
            .map(b => ({
              id: b.id,
              teamId: b.team_id,
              teamName: b.team?.name ?? '—',
              amount: b.amount,
              isAuto: b.is_auto,
              createdAt: b.created_at,
            })),
          passes: a.passes.map(p => ({
            teamId: p.team_id,
            teamName: p.team?.name ?? '—',
            reason: p.reason,
          })),
        }))}
        myTeamId={myTeam?.id ?? null}
        myMaxBid={myMaxBid}
        hardMaxBid={myHardMaxBid}
        committed={myCommitted}
        slotsLeft={mySlotsLeft}
        extendShortMinutes={league.open_extend_short_minutes}
        extendLongMinutes={league.open_extend_long_minutes}
        approvedTeamCount={approvedTeams.length}
        frozenReason={frozenReason}
      />

      {history.length > 0 && (
        <div className="card">
          <h2 className="font-bold mb-3">היסטוריה ({history.length})</h2>
          <div className="flex flex-col">
            {history.map(h => (
              <div
                key={h.id}
                className="flex justify-between items-center gap-2 py-2 border-b text-sm"
                style={{ borderColor: 'var(--border)' }}
              >
                <div className="min-w-0">
                  <p className="font-medium truncate">{h.player?.name ?? 'שחקן'}</p>
                  <p className="text-xs" style={{ color: 'var(--muted)' }}>
                    {/* Everyone passing is how an auction is *supposed* to end, so
                        it goes unlabelled — only the two exceptions are named. */}
                    {h.status === 'cancelled'
                      ? 'בוטל'
                      : [
                          h.winning_team?.name ?? '—',
                          h.closed_reason === 'timeout'
                            ? 'נסגר בזמן'
                            : h.closed_reason === 'admin'
                              ? 'נסגר ע"י המנהל'
                              : null,
                        ].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <div className="text-left shrink-0">
                  {h.status === 'completed' && (
                    <p className="font-bold" style={{ color: 'var(--success)' }}>
                      {formatCurrency(h.winning_bid ?? 0)}
                    </p>
                  )}
                  <p className="text-xs" style={{ color: 'var(--muted)' }}>{formatDateTime(h.updated_at)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <RealtimeRefresher leagueId={league.id} openBoard />
    </div>
  )
}
