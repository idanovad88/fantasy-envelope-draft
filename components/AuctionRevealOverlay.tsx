'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import type { Auction } from '@/types'

type BidEntry = {
  teamName: string
  amount: number
  isWinner: boolean
}

type RevealData = {
  playerName: string
  playerPosition: string | null
  playerNbaTeam: string | null
  winningTeamName: string | null
  winningBid: number | null
  tieBroken: boolean
  bids: BidEntry[]
  noBids: boolean
}

type Phase = 'idle' | 'suspense' | 'bids' | 'highlight' | 'celebration'

export default function AuctionRevealOverlay({ leagueId }: { leagueId: string }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [data, setData] = useState<RevealData | null>(null)
  const [visibleBids, setVisibleBids] = useState(0)
  const timerRefs = useRef<ReturnType<typeof setTimeout>[]>([])
  const router = useRouter()
  const supabase = createClient()

  const clearTimers = () => {
    timerRefs.current.forEach(clearTimeout)
    timerRefs.current = []
  }

  const dismiss = useCallback(() => {
    clearTimers()
    setPhase('idle')
    setData(null)
    setVisibleBids(0)
    router.refresh()
  }, [router])

  const addTimer = (fn: () => void, ms: number) => {
    const id = setTimeout(fn, ms)
    timerRefs.current.push(id)
    return id
  }

  const triggerReveal = useCallback(async (auctionId: string) => {
    const supabaseClient = createClient()

    const [{ data: auction }, { data: bidsRaw }] = await Promise.all([
      supabaseClient
        .from('auctions')
        .select('*, player:players(*), winning_team:teams!winning_team_id(name)')
        .eq('id', auctionId)
        .single(),
      supabaseClient
        .from('bids')
        .select('amount, team:teams(name)')
        .eq('auction_id', auctionId)
        .gt('amount', 0)
        .order('amount', { ascending: true }),
    ])

    if (!auction) return

    const winnerName = (auction as any).winning_team?.name ?? null

    const bids: BidEntry[] = (bidsRaw ?? []).map((b: any) => ({
      teamName: b.team?.name ?? '?',
      amount: b.amount,
      isWinner: b.team?.name === winnerName && b.amount === auction.winning_bid,
    }))

    setData({
      playerName: (auction as any).player?.name ?? '?',
      playerPosition: (auction as any).player?.position ?? null,
      playerNbaTeam: (auction as any).player?.nba_team ?? null,
      winningTeamName: winnerName,
      winningBid: auction.winning_bid,
      tieBroken: auction.tie_broken_by_priority,
      bids,
      noBids: bids.length === 0,
    })

    setVisibleBids(0)
    setPhase('suspense')

    const BID_INTERVAL = 600
    const suspenseDuration = 2000

    addTimer(() => {
      setPhase('bids')
      // Reveal bids one by one
      bids.forEach((_, i) => {
        addTimer(() => setVisibleBids(i + 1), i * BID_INTERVAL)
      })
      // After all bids shown, move to highlight
      const allBidsDuration = bids.length * BID_INTERVAL + 400
      addTimer(() => setPhase('highlight'), allBidsDuration)
      addTimer(() => setPhase('celebration'), allBidsDuration + 1200)
      addTimer(dismiss, allBidsDuration + 1200 + 6000)
    }, suspenseDuration)
  }, [dismiss])

  useEffect(() => {
    if (!leagueId) return

    const channel = supabase
      .channel('reveal-overlay')
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'auctions',
        filter: `league_id=eq.${leagueId}`,
      }, (payload) => {
        const updated = payload.new as Auction
        if (updated.status === 'completed') {
          triggerReveal(updated.id)
        }
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
      clearTimers()
    }
  }, [leagueId, triggerReveal, supabase])

  if (phase === 'idle') return null

  return (
    <div className="reveal-overlay" onClick={dismiss}>
      {phase === 'celebration' && <Confetti />}

      <div className="reveal-modal" onClick={(e) => e.stopPropagation()}>
        <button className="reveal-close" onClick={dismiss}>✕</button>

        {/* Header — player info */}
        {phase !== 'suspense' && data && (
          <div className="reveal-header">
            <p className="reveal-tag">🏀 תוצאות המכרז</p>
            <h2 className="reveal-player-name">{data.playerName}</h2>
            {data.playerPosition && (
              <p className="reveal-player-sub">
                {data.playerPosition}{data.playerNbaTeam ? ` · ${data.playerNbaTeam}` : ''}
              </p>
            )}
          </div>
        )}

        {/* Suspense phase */}
        {phase === 'suspense' && (
          <div className="reveal-suspense">
            <div className="reveal-spinner" />
            <p className="reveal-suspense-text">חושף הצעות...</p>
          </div>
        )}

        {/* Bids list */}
        {(phase === 'bids' || phase === 'highlight' || phase === 'celebration') && data && (
          <div className="reveal-bids-section">
            {data.noBids ? (
              <p className="reveal-no-bids">אף קבוצה לא הגישה הצעה</p>
            ) : (
              <div className="reveal-bids-list">
                {data.bids.slice(0, visibleBids).map((bid, i) => (
                  <div
                    key={i}
                    className={`reveal-bid-row ${
                      (phase === 'highlight' || phase === 'celebration') && bid.isWinner
                        ? 'reveal-bid-winner'
                        : (phase === 'highlight' || phase === 'celebration') && !bid.isWinner
                        ? 'reveal-bid-dimmed'
                        : ''
                    }`}
                    style={{ animationDelay: '0ms' }}
                  >
                    <span className="reveal-bid-team">{bid.teamName}</span>
                    <span className="reveal-bid-amount">${bid.amount}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Winner banner */}
        {(phase === 'highlight' || phase === 'celebration') && data && !data.noBids && data.winningTeamName && (
          <div className="reveal-winner-banner">
            <p className="reveal-winner-label">🏆 הקבוצה הזוכה</p>
            <p className="reveal-winner-name">{data.winningTeamName}</p>
            <p className="reveal-winner-bid">${data.winningBid}</p>
            {data.tieBroken && (
              <span className="badge badge-yellow" style={{ marginTop: '0.5rem', fontSize: '0.7rem' }}>
                נקבע בפריוריטי
              </span>
            )}
          </div>
        )}

        {/* No bids result */}
        {(phase === 'highlight' || phase === 'celebration') && data?.noBids && (
          <div className="reveal-winner-banner reveal-no-winner">
            <p className="reveal-winner-label">😶 השחקן לא נרכש</p>
            <p style={{ color: 'var(--muted)', fontSize: '0.9rem', marginTop: '0.25rem' }}>
              חוזר לשוק הפנוי
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function Confetti() {
  const colors = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#f472b6', '#a78bfa']
  const pieces = Array.from({ length: 70 }, (_, i) => ({
    id: i,
    left: Math.random() * 100,
    delay: Math.random() * 0.6,
    duration: 1.8 + Math.random() * 1.4,
    color: colors[Math.floor(Math.random() * colors.length)],
    size: 7 + Math.random() * 7,
    rotation: Math.random() * 360,
    isRect: Math.random() > 0.5,
  }))

  return (
    <div className="confetti-container" aria-hidden>
      {pieces.map((p) => (
        <div
          key={p.id}
          className="confetti-piece"
          style={{
            left: `${p.left}%`,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.duration}s`,
            backgroundColor: p.color,
            width: p.isRect ? p.size * 0.5 : p.size,
            height: p.size,
            borderRadius: p.isRect ? '1px' : '50%',
            transform: `rotate(${p.rotation}deg)`,
          }}
        />
      ))}
    </div>
  )
}
