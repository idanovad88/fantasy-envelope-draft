'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { getMuted, toggleMute, unlockAudio, playDrumroll, playBidReveal, playFanfare } from '@/lib/sounds'

type BidWithTeam = {
  id: string
  team_id: string
  amount: number
  team: { name: string; avatar_url: string | null } | null
}

type RecentlyCompleted = {
  id: string
  updatedAt: string
  winningTeamId: string | null
  winningBid: number | null
  playerName: string
}

type Phase = 'idle' | 'revealing' | 'var' | 'winner'

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function spawnConfetti() {
  const colors = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#ffffff', '#fbbf24']
  for (let i = 0; i < 70; i++) {
    const el = document.createElement('div')
    el.className = 'confetti-piece'
    el.style.left = Math.random() * 100 + 'vw'
    el.style.width = (7 + Math.random() * 8) + 'px'
    el.style.height = (7 + Math.random() * 8) + 'px'
    el.style.background = colors[Math.floor(Math.random() * colors.length)]
    el.style.animationDuration = (1.2 + Math.random() * 1.8) + 's'
    el.style.animationDelay = Math.random() * 0.6 + 's'
    el.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px'
    document.body.appendChild(el)
    setTimeout(() => el.remove(), 3500)
  }
}

interface TeamAvatar {
  url: string | null
  name: string
}

function Avatar({ url, name, size }: TeamAvatar & { size: number }) {
  if (url) {
    return (
      <img
        src={url}
        alt={name}
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
      />
    )
  }
  return (
    <div
      style={{
        width: size, height: size, borderRadius: '50%', flexShrink: 0,
        background: 'var(--primary)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontWeight: 700, fontSize: size * 0.4, color: '#fff',
      }}
    >
      {name?.[0] ?? '?'}
    </div>
  )
}

interface Props {
  leagueId: string
  activeAuctionId: string | null
  recentlyCompleted?: RecentlyCompleted
  myTeamId?: string | null
  varGifUrl?: string | null
}

export default function BidRevealOverlay({ leagueId, activeAuctionId, recentlyCompleted, myTeamId, varGifUrl }: Props) {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('idle')
  const [bids, setBids] = useState<BidWithTeam[]>([])
  const [shownCount, setShownCount] = useState(0)
  const [winner, setWinner] = useState<{ teamName: string; amount: number; avatarUrl: string | null } | null>(null)
  const [playerName, setPlayerName] = useState('')
  const [nominatingTeamId, setNominatingTeamId] = useState<string | null>(null)
  const [muted, setMuted] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startedRef = useRef(false)

  useEffect(() => { setMuted(getMuted()) }, [])

  useEffect(() => {
    const unlock = () => unlockAudio()
    document.addEventListener('click', unlock, { once: true })
    document.addEventListener('keydown', unlock, { once: true })
    document.addEventListener('touchstart', unlock, { once: true })
    return () => {
      document.removeEventListener('click', unlock)
      document.removeEventListener('keydown', unlock)
      document.removeEventListener('touchstart', unlock)
    }
  }, [])

  const REVEAL_INTERVAL = 3000

  async function startReveal(auctionId: string, winningTeamId: string | null, winningBid: number | null, startIndex = 0) {
    if (startedRef.current) return
    startedRef.current = true

    const supabase = createClient()

    const [{ data: bidsData }, { data: auctionMeta }] = await Promise.all([
      supabase
        .from('bids')
        .select('id, team_id, amount, team:teams(name, avatar_url)')
        .eq('auction_id', auctionId),
      supabase
        .from('auctions')
        .select('player:players(name), nominating_team_id, nominating_team:teams!nominating_team_id(name), tie_broken_by_priority')
        .eq('id', auctionId)
        .single(),
    ])

    const pName = (auctionMeta?.player as unknown as { name: string } | null)?.name ?? 'שחקן'
    const nomTeamId = auctionMeta?.nominating_team_id ?? null
    const nomTeamName = (auctionMeta?.nominating_team as unknown as { name: string } | null)?.name ?? null
    const isTieBroken = (auctionMeta as { tie_broken_by_priority?: boolean } | null)?.tie_broken_by_priority ?? false

    let allBids = (bidsData ?? []) as unknown as BidWithTeam[]

    const hasNomBid = nomTeamId && allBids.some(b => b.team_id === nomTeamId)
    if (nomTeamId && nomTeamName && !hasNomBid) {
      allBids = [...allBids, {
        id: 'default-' + nomTeamId,
        team_id: nomTeamId,
        amount: 1,
        team: { name: nomTeamName, avatar_url: null },
      }]
    }

    if (allBids.length === 0) return

    const shuffled = shuffle(allBids)
    const winnerBid = shuffled.find(b => b.team_id === winningTeamId) ?? null
    const winnerInfo = winnerBid
      ? {
          teamName: winnerBid.team?.name ?? '—',
          amount: winningBid ?? winnerBid.amount,
          avatarUrl: winnerBid.team?.avatar_url ?? null,
        }
      : null

    setPlayerName(pName)
    setNominatingTeamId(nomTeamId)
    setWinner(winnerInfo)
    setBids(shuffled)
    setShownCount(startIndex)
    setPhase('revealing')
    playDrumroll(2)

    let count = startIndex
    intervalRef.current = setInterval(() => {
      count++
      if (count >= shuffled.length) {
        clearInterval(intervalRef.current!)
        setShownCount(shuffled.length)

        setTimeout(() => {
          if (isTieBroken) {
            setPhase('var')
            setTimeout(() => {
              setPhase('winner')
              playFanfare()
              if (myTeamId && winningTeamId === myTeamId) spawnConfetti()
              setTimeout(() => {
                setPhase('idle')
                startedRef.current = false
                router.refresh()
              }, 4000)
            }, 4500)
          } else {
            setPhase('winner')
            playFanfare()
            if (myTeamId && winningTeamId === myTeamId) spawnConfetti()
            setTimeout(() => {
              setPhase('idle')
              startedRef.current = false
              router.refresh()
            }, 4000)
          }
        }, 3000)
      } else {
        setShownCount(count)
        playBidReveal()
      }
    }, REVEAL_INTERVAL)
  }

  useEffect(() => {
    if (!recentlyCompleted || startedRef.current) return
    const elapsed = Date.now() - new Date(recentlyCompleted.updatedAt).getTime()
    if (elapsed > 60000) return
    const startIndex = Math.min(Math.floor(elapsed / REVEAL_INTERVAL), 20)
    startReveal(
      recentlyCompleted.id,
      recentlyCompleted.winningTeamId,
      recentlyCompleted.winningBid,
      startIndex,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
          startReveal(updated.id, updated.winning_team_id, updated.winning_bid)
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leagueId])

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
        @keyframes varPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.7; }
        }
      `}</style>

      <button
        onClick={() => { unlockAudio(); setMuted(toggleMute()) }}
        title={muted ? 'הפעל קול' : 'השתק'}
        style={{
          position: 'fixed', bottom: '20px', left: '20px', zIndex: 60,
          background: 'var(--border)', border: 'none', borderRadius: '50%',
          width: '40px', height: '40px', fontSize: '18px',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          opacity: 0.7,
        }}
      >
        {muted ? '🔇' : '🔊'}
      </button>

      {phase !== 'idle' && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 50,
            background: 'rgba(0,0,0,0.88)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            padding: '24px',
            animation: 'fadeIn 0.3s ease',
            overflowY: 'auto',
          }}
        >
          {/* Header — always visible during reveal and winner phases */}
          {phase !== 'var' && (
            <div style={{ textAlign: 'center', marginBottom: '24px' }}>
              <p style={{ color: 'var(--muted)', fontSize: '13px', marginBottom: '6px' }}>חשיפת הצעות</p>
              <h2 style={{ color: '#fff', fontSize: '26px', fontWeight: 800 }} dir="ltr">{playerName}</h2>
            </div>
          )}

          {/* Bids reveal list */}
          {phase === 'revealing' && (
            <div style={{ width: '100%', maxWidth: '420px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {visibleBids.map((bid, i) => {
                const isDefault = bid.team_id === nominatingTeamId && bid.amount === 1
                return (
                  <div
                    key={bid.id}
                    style={{
                      background: 'rgba(255,255,255,0.07)',
                      border: '1px solid rgba(255,255,255,0.12)',
                      borderRadius: '12px',
                      padding: '12px 16px',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      animation: i === visibleBids.length - 1 ? 'slideInUp 0.4s ease' : 'none',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <Avatar url={bid.team?.avatar_url ?? null} name={bid.team?.name ?? '?'} size={40} />
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        <span style={{ color: '#fff', fontWeight: 600, fontSize: '15px' }}>
                          {bid.team?.name ?? '—'}
                        </span>
                        {isDefault && (
                          <span style={{ color: 'var(--muted)', fontSize: '11px' }}>ברירת מחדל</span>
                        )}
                      </div>
                    </div>
                    <span style={{ color: 'var(--success)', fontWeight: 800, fontSize: '20px' }}>
                      ${bid.amount}
                    </span>
                  </div>
                )
              })}

              {shownCount < bids.length && (
                <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: '13px', marginTop: '8px' }}>
                  {bids.length - shownCount} נותרו...
                </div>
              )}
            </div>
          )}

          {/* VAR review phase */}
          {phase === 'var' && (
            <div style={{ textAlign: 'center', animation: 'fadeIn 0.4s ease' }}>
              <p style={{
                color: 'var(--warning)', fontSize: '13px', fontWeight: 700,
                letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: '20px',
                animation: 'varPulse 1.2s ease infinite',
              }}>
                🔍 בדיקת VAR...
              </p>
              {varGifUrl ? (
                <img
                  src={varGifUrl}
                  alt="VAR review"
                  style={{ width: '300px', maxWidth: '85vw', borderRadius: '12px', margin: '0 auto', display: 'block' }}
                />
              ) : (
                <div style={{ fontSize: '72px', margin: '20px 0' }}>🔍</div>
              )}
              <p style={{ color: 'var(--muted)', fontSize: '13px', marginTop: '16px' }}>
                מכרז הוכרע על פי פריוריטי
              </p>
            </div>
          )}

          {/* Winner reveal */}
          {phase === 'winner' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', width: '100%' }}>
              {/* Losing bids (dimmed) */}
              <div style={{ width: '100%', maxWidth: '420px', display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '8px' }}>
                {bids.filter(b => b.team?.name !== winner?.teamName).map(bid => (
                  <div
                    key={bid.id}
                    style={{
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid rgba(255,255,255,0.07)',
                      borderRadius: '10px',
                      padding: '8px 14px',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      opacity: 0.4,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <Avatar url={bid.team?.avatar_url ?? null} name={bid.team?.name ?? '?'} size={28} />
                      <span style={{ color: '#ccc', fontSize: '13px' }}>{bid.team?.name ?? '—'}</span>
                    </div>
                    <span style={{ color: '#aaa', fontSize: '15px', fontWeight: 700 }}>${bid.amount}</span>
                  </div>
                ))}
              </div>

              {/* Winner card */}
              {winner && (
                <div
                  style={{
                    width: '100%', maxWidth: '420px',
                    background: 'rgba(34,197,94,0.15)',
                    border: '2px solid var(--success)',
                    borderRadius: '16px',
                    padding: '24px',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px',
                    animation: 'winnerPop 0.6s cubic-bezier(0.34,1.56,0.64,1)',
                  }}
                >
                  <Avatar url={winner.avatarUrl} name={winner.teamName} size={96} />
                  <span style={{ fontSize: '32px' }}>🏆</span>
                  <span style={{ color: 'var(--success)', fontWeight: 800, fontSize: '22px', textAlign: 'center' }}>
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
      )}
    </>
  )
}
