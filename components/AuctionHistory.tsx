'use client'

import { useState, useEffect, useMemo } from 'react'
import { formatDateTime, REVEAL_WINDOW_MS } from '@/lib/utils'
import { getSeenRevealId, REVEAL_SEEN_EVENT } from '@/lib/reveal'

type BidWithTeam = {
  id: string
  team_id: string
  amount: number
  team: { name: string } | null
}

type AuctionWithBids = {
  id: string
  scheduled_start: string
  updated_at: string
  winning_bid: number | null
  winning_team_id: string | null
  nominating_team_id: string | null
  tie_broken_by_priority: boolean
  status: string
  player: { name: string; position: string | null; nba_team: string | null } | null
  nominating_team: { name: string } | null
  winning_team: { name: string } | null
  bids: BidWithTeam[]
}

export default function AuctionHistory({ auctions }: { auctions: AuctionWithBids[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [seenId, setSeenId] = useState<string | null>(null)
  const [windowOpen, setWindowOpen] = useState(true)

  const toggle = (id: string) =>
    setExpandedId(prev => (prev === id ? null : id))

  // The single most-recently-completed auction is the one the BidRevealOverlay
  // animates. Its result must not appear here until that reveal has been seen,
  // otherwise the history spoils the surprise the animation is building.
  const pendingReveal = useMemo(() => {
    const completed = auctions.filter(a => a.status === 'completed' && a.updated_at)
    if (completed.length === 0) return null
    const latest = completed.reduce((m, a) =>
      new Date(a.updated_at).getTime() > new Date(m.updated_at).getTime() ? a : m)
    if (Date.now() - new Date(latest.updated_at).getTime() >= REVEAL_WINDOW_MS) return null
    return latest
  }, [auctions])

  // Read the seen-id on mount and stay in sync when the overlay finishes a reveal
  // in this same tab (custom event — `storage` fires only in other tabs).
  useEffect(() => {
    setSeenId(getSeenRevealId())
    const onSeen = (e: Event) => setSeenId((e as CustomEvent<string>).detail)
    window.addEventListener(REVEAL_SEEN_EVENT, onSeen)
    return () => window.removeEventListener(REVEAL_SEEN_EVENT, onSeen)
  }, [])

  // Fail open: if the overlay never plays (tab was closed, etc.), un-mask once
  // the reveal window elapses so the result isn't hidden forever.
  useEffect(() => {
    if (!pendingReveal) return
    const remaining = REVEAL_WINDOW_MS - (Date.now() - new Date(pendingReveal.updated_at).getTime())
    if (remaining <= 0) { setWindowOpen(false); return }
    setWindowOpen(true)
    const t = setTimeout(() => setWindowOpen(false), remaining)
    return () => clearTimeout(t)
  }, [pendingReveal])

  const maskedId = pendingReveal && windowOpen && seenId !== pendingReveal.id
    ? pendingReveal.id
    : null

  return (
    <div>
      <h2 className="font-bold mb-3">היסטוריית מכרזים</h2>
      <div className="flex flex-col gap-2">
        {auctions.map(auction => {
          const isExpanded = expandedId === auction.id

          // Currently being revealed by the overlay — hide the result so the
          // history doesn't spoil it. No expand, no winner, no price, no bids.
          if (auction.id === maskedId) {
            return (
              <div key={auction.id} className="card select-none" style={{ opacity: 0.85 }}>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">{auction.player?.name}</p>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
                      {formatDateTime(auction.scheduled_start)}
                      {auction.nominating_team && ` · ${auction.nominating_team.name}`}
                    </p>
                  </div>
                  <span className="badge badge-yellow">🔒 בחשיפה…</span>
                </div>
              </div>
            )
          }

          // If nominating team has no bid, synthesize a $1 default entry for display.
          // Match by team_id OR by name (nominating_team_id can be absent from PostgREST * expansion).
          const nomId   = auction.nominating_team_id ?? null
          const nomName = auction.nominating_team?.name ?? null
          const hasNomBid =
            !nomName ||
            auction.bids.some(b =>
              (nomId && b.team_id === nomId) || b.team?.name === nomName
            )
          const allBids: BidWithTeam[] = hasNomBid
            ? auction.bids
            : [...auction.bids, { id: 'default', team_id: nomId ?? 'default', amount: 1, team: auction.nominating_team }]
          const sortedBids = [...allBids].sort((a, b) => b.amount - a.amount)

          return (
            <div
              key={auction.id}
              className="card cursor-pointer select-none"
              onClick={() => toggle(auction.id)}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">{auction.player?.name}</p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
                    {formatDateTime(auction.scheduled_start)}
                    {auction.nominating_team && ` · ${auction.nominating_team.name}`}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-left">
                    {auction.winning_team ? (
                      <>
                        <p className="font-bold" style={{ color: 'var(--success)' }}>
                          ${auction.winning_bid}
                        </p>
                        <p className="text-xs" style={{ color: 'var(--muted)' }}>
                          {auction.winning_team.name}
                        </p>
                        {auction.tie_broken_by_priority && (
                          <span className="badge badge-yellow text-xs">פריוריטי</span>
                        )}
                      </>
                    ) : auction.status === 'revealed' ? (
                      <span className="badge badge-yellow">נחשף</span>
                    ) : (
                      <span className="badge badge-gray">לא נרכש</span>
                    )}
                  </div>
                  <span style={{ color: 'var(--muted)', fontSize: '0.7rem' }}>
                    {isExpanded ? '▲' : '▼'}
                  </span>
                </div>
              </div>

              {isExpanded && (
                <div
                  className="mt-3 pt-3 border-t"
                  style={{ borderColor: 'var(--border)' }}
                  onClick={e => e.stopPropagation()}
                >
                  {sortedBids.length > 0 ? (
                    <>
                      <p className="text-xs font-semibold mb-2" style={{ color: 'var(--muted)' }}>
                        הצעות ({sortedBids.length})
                      </p>
                      <div className="flex flex-col gap-1.5">
                        {sortedBids.map(bid => {
                          const isWinner = bid.team_id === auction.winning_team_id
                          const isDefault = bid.id === 'default' || (bid.team_id === nomId && bid.amount === 1)
                          return (
                            <div
                              key={bid.id}
                              className="flex items-center justify-between text-sm"
                            >
                              <div className="flex flex-col gap-0">
                                <span
                                  className={isWinner ? 'font-bold' : ''}
                                  style={isWinner ? { color: 'var(--success)' } : { color: 'var(--text)' }}
                                >
                                  {bid.team?.name ?? '—'}
                                  {isWinner && ' 🏆'}
                                </span>
                                {isDefault && (
                                  <span style={{ fontSize: '10px', color: 'var(--muted)' }}>ברירת מחדל</span>
                                )}
                              </div>
                              <span
                                className={`font-mono ${isWinner ? 'font-bold' : ''}`}
                                style={isWinner ? { color: 'var(--success)' } : { color: 'var(--text)' }}
                              >
                                ${bid.amount}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    </>
                  ) : (
                    <p className="text-sm" style={{ color: 'var(--muted)' }}>
                      אין הצעות
                    </p>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
