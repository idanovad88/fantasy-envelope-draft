import { createClient } from '@/lib/supabase/server'
import { cookies } from 'next/headers'
import { activateOverduePendingAuctions } from '@/lib/auctions'
import { formatTime, formatDateTime, REVEAL_WINDOW_MS } from '@/lib/utils'
import BidForm from '@/components/BidForm'
import Countdown from '@/components/Countdown'
import AuctionHistory from '@/components/AuctionHistory'
import RealtimeRefresher from '@/components/RealtimeRefresher'
import BidRevealOverlay from '@/components/BidRevealOverlay'
import { myTeamOr } from '@/lib/team'
import type { Auction, Team, League } from '@/types'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function AuctionPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
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
