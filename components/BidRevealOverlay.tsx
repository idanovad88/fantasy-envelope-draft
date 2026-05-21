'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

type BidWithTeam = {
  id: string
  team_id: string
  amount: number
  team: { name: string } | null
}

type RecentlyCompleted = {
  id: string
  updatedAt: string
  winningTeamId: string | null
  winningBid: number | null
  playerName: string
}

type Phase = 'idle' | 'revealing' | 'winner'

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

interface Props {
  leagueId: string
  activeAuctionId: string | null
  recentlyCompleted?: RecentlyCompleted
}

export default function BidRevealOverlay({ leagueId, activeAuctionId, recentlyCompleted }: Props) {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('idle')
  const [bids, setBids] = useState<BidWithTeam[]>([])
  const [shownCount, setShownCount] = useState(0)
  const [winner, setWinner] = useState<{ teamName: string; amount: number } | null>(null)
  const [playerName, setPlayerName] = useState('')
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startedRef = useRef(false)

  const REVEAL_INTERVAL = 3000

  async function startReveal(auctionId: string, pName: string, winningTeamId: string | null, winningBid: number | null, startIndex = 0) {
    if (startedRef.current) return
    startedRef.current = true

    const supabase = createClient()
    const { data } = await supabase
      .from('bids')
      .select('id, team_id, amount, team:teams(name)')
      .eq('auction_id', auctionId)

    if (!data || data.length === 0) return

    const shuffled = shuffle(data as unknown as BidWithTeam[])
    const winnerBid = shuffled.find(b => b.team_id === winningTeamId) ?? null
    const winnerInfo = winnerBid
      ? { teamName: winnerBid.team?.name ?? '—', amount: winningBid ?? winnerBid.amount }
      : null

    setPlayerName(pName)
    setWinner(winnerInfo)
    setBids(shuffled)
    setShownCount(startIndex)
    setPhase('revealing')

    let count = startIndex
    intervalRef.current = setInterval(() => {
      count++
      if (count >= shuffled.length) {
        clearInterval(intervalRef.current!)
        setShownCount(shuffled.length)
        setTimeout(() => {
          setPhase('winner')
          setTimeout(() => {
            setPhase('idle')
            startedRef.current = false
            router.refresh()
          }, 4000)
        }, 500)
      } else {
        setShownCount(count)
      }
    }, REVEAL_INTERVAL)
  }

  // Handle late joiners — if recentlyCompleted auction was within 60s
  useEffect(() => {
    if (!recentlyCompleted || startedRef.current) return
    const elapsed = Date.now() - new Date(recentlyCompleted.updatedAt).getTime()
    if (elapsed > 60000) return
    const startIndex = Math.min(Math.floor(elapsed / REVEAL_INTERVAL), 20)
    startReveal(
      recentlyCompleted.id,
      recentlyCompleted.playerName,
      recentlyCompleted.winningTeamId,
      recentlyCompleted.winningBid,
      startIndex,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Subscribe to auction completions
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel('bid-reveal-' + leagueId)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'auctions', filter: `league_id=eq.${leagueId}` },
        async (payload) => {
          const updated = payload.new as { id: string; status: string; winning_team_id: string | null; winning_bid: number | null }
          if (updated.status !== 'completed') return

          // fetch player name
          const { data: auctionData } = await supabase
            .from('auctions')
            .select('player:players(name)')
            .eq('id', updated.id)
            .single()
          const pName = (auctionData?.player as unknown as { name: string } | null)?.name ?? 'שחקן'

          startReveal(updated.id, pName, updated.winning_team_id, updated.winning_bid)
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leagueId])

  if (phase === 'idle') return null

  const visibleBids = bids.slice(0, shownCount)

  return (
    <>
      <style>{`
        @keyframes slideInUp {
          from { opacity: 0; transform: translateY(24px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes winnerPop {
          0%   { transform: scale(0.7); opacity: 0; }
          70%  { transform: scale(1.06); }
          100% { transform: scale(1);   opacity: 1; }
        }
        @keyframes fadeIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
      `}</style>

      <div
        style={{
          position: 'fixed', inset: 0, zIndex: 50,
          background: 'rgba(0,0,0,0.85)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          padding: '24px',
          animation: 'fadeIn 0.3s ease',
        }}
      >
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <p style={{ color: 'var(--muted)', fontSize: '13px', marginBottom: '6px' }}>חשיפת הצעות</p>
          <h2 style={{ color: '#fff', fontSize: '26px', fontWeight: 800 }} dir="ltr">{playerName}</h2>
        </div>

        {/* Bids list */}
        {phase === 'revealing' && (
          <div style={{ width: '100%', maxWidth: '400px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {visibleBids.map((bid, i) => (
              <div
                key={bid.id}
                style={{
                  background: 'rgba(255,255,255,0.07)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: '12px',
                  padding: '14px 18px',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  animation: i === visibleBids.length - 1 ? 'slideInUp 0.4s ease' : 'none',
                }}
              >
                <span style={{ color: '#fff', fontWeight: 600, fontSize: '15px' }}>
                  {bid.team?.name ?? '—'}
                </span>
                <span style={{ color: 'var(--success)', fontWeight: 800, fontSize: '20px' }}>
                  ${bid.amount}
                </span>
              </div>
            ))}

            {shownCount < bids.length && (
              <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: '13px', marginTop: '8px' }}>
                {bids.length - shownCount} נותרו...
              </div>
            )}
          </div>
        )}

        {/* Winner reveal */}
        {phase === 'winner' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
            {/* All bids (dimmed) */}
            <div style={{ width: '100%', maxWidth: '400px', display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '8px' }}>
              {bids.filter(b => b.team_id !== winner?.teamName).map(bid => (
                bid.team?.name !== winner?.teamName && (
                  <div
                    key={bid.id}
                    style={{
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid rgba(255,255,255,0.07)',
                      borderRadius: '10px',
                      padding: '10px 16px',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      opacity: 0.45,
                    }}
                  >
                    <span style={{ color: '#ccc', fontSize: '13px' }}>{bid.team?.name ?? '—'}</span>
                    <span style={{ color: '#aaa', fontSize: '15px', fontWeight: 700 }}>${bid.amount}</span>
                  </div>
                )
              ))}
            </div>

            {/* Winner card */}
            {winner && (
              <div
                style={{
                  width: '100%', maxWidth: '400px',
                  background: 'rgba(34,197,94,0.15)',
                  border: '2px solid var(--success)',
                  borderRadius: '16px',
                  padding: '20px 24px',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px',
                  animation: 'winnerPop 0.6s ease',
                }}
              >
                <span style={{ fontSize: '36px' }}>🏆</span>
                <span style={{ color: 'var(--success)', fontWeight: 800, fontSize: '22px' }}>
                  {winner.teamName}
                </span>
                <span style={{ color: '#fff', fontWeight: 700, fontSize: '28px' }}>
                  ${winner.amount}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}
