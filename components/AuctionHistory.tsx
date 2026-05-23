'use client'

import { useState } from 'react'
import { formatDateTime } from '@/lib/utils'

type BidWithTeam = {
  id: string
  team_id: string
  amount: number
  team: { name: string } | null
}

type AuctionWithBids = {
  id: string
  scheduled_start: string
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

  const toggle = (id: string) =>
    setExpandedId(prev => (prev === id ? null : id))

  return (
    <div>
      <h2 className="font-bold mb-3">היסטוריית מכרזים</h2>
      <div className="flex flex-col gap-2">
        {auctions.map(auction => {
          const isExpanded = expandedId === auction.id

          // If nominating team has no bid, synthesize a $1 default entry for display
          const nomId = auction.nominating_team_id
          const hasNomBid = !nomId || auction.bids.some(b => b.team_id === nomId)
          const allBids: BidWithTeam[] = hasNomBid
            ? auction.bids
            : [...auction.bids, { id: 'default', team_id: nomId!, amount: 1, team: auction.nominating_team }]
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
