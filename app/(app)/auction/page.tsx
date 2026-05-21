import { createClient } from '@/lib/supabase/server'
import { formatTime } from '@/lib/utils'
import BidForm from '@/components/BidForm'
import Countdown from '@/components/Countdown'
import AuctionHistory from '@/components/AuctionHistory'
import RealtimeRefresher from '@/components/RealtimeRefresher'
import BidRevealOverlay from '@/components/BidRevealOverlay'
import type { Auction, Team, League } from '@/types'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function AuctionPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const [{ data: league }, { data: myTeam }, { data: auctions }, { data: myBids }, { data: recentCompleted }] =
    await Promise.all([
      supabase.from('leagues').select('*').order('created_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('teams').select('*').eq('user_id', user!.id).maybeSingle(),
      supabase.from('auctions')
        .select('*, player:players(*), nominating_team:teams!nominating_team_id(name), winning_team:teams!winning_team_id(name), bids(*, team:teams(name))')
        .in('status', ['active', 'revealed', 'completed'])
        .order('scheduled_start', { ascending: false })
        .limit(20),
      supabase.from('bids').select('*').eq('team_id', (await supabase.from('teams').select('id').eq('user_id', user!.id).maybeSingle()).data?.id ?? ''),
      supabase.from('auctions')
        .select('id, updated_at, winning_team_id, winning_bid, player:players(name)')
        .eq('status', 'completed')
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])

  const typedLeague = league as League | null
  const typedMyTeam = myTeam as Team | null

  const REVEAL_WINDOW_MS = 60000
  const recentlyCompleted = recentCompleted && (
    Date.now() - new Date(recentCompleted.updated_at).getTime() < REVEAL_WINDOW_MS
  ) ? {
    id: recentCompleted.id,
    updatedAt: recentCompleted.updated_at,
    winningTeamId: recentCompleted.winning_team_id,
    winningBid: recentCompleted.winning_bid,
    playerName: (recentCompleted.player as unknown as { name: string } | null)?.name ?? 'שחקן',
  } : undefined
  const typedAuctions = (auctions || []) as (Auction & { player: { name: string; position: string | null; nba_team: string | null }; nominating_team: { name: string } | null; winning_team: { name: string } | null; bids: { id: string; team_id: string; amount: number; team: { name: string } | null }[] })[]
  const myBidMap = Object.fromEntries((myBids || []).map(b => [b.auction_id, b.amount]))

  const activeAuction = typedAuctions.find(a => a.status === 'active')
  const pastAuctions = typedAuctions.filter(a => a.status === 'revealed' || a.status === 'completed')

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
            />
          )}
        </div>
      ) : (
        <div className="card mb-6 text-center py-8" style={{ color: 'var(--muted)' }}>
          <p className="text-4xl mb-2">🏀</p>
          <p>אין מכרז פעיל כרגע</p>
        </div>
      )}

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
        />
      )}
    </div>
  )
}
