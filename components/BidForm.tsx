'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getMaxBid } from '@/lib/utils'
import type { Team, League } from '@/types'

interface BidFormProps {
  auctionId: string
  team: Team
  league: League
  existingBid?: number
  onBidSubmitted?: () => void
}

export default function BidForm({ auctionId, team, league, existingBid, onBidSubmitted }: BidFormProps) {
  const [amount, setAmount] = useState(existingBid ?? 0)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const supabase = createClient()

  const maxBid = getMaxBid(team.budget_remaining, team.player_count, league.players_per_team)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setMessage('')

    if (amount > maxBid) {
      setMessage(`הצעה מקסימלית: $${maxBid}`)
      setLoading(false)
      return
    }

    const { error } = await supabase.from('bids').upsert(
      { auction_id: auctionId, team_id: team.id, amount, updated_at: new Date().toISOString() },
      { onConflict: 'auction_id,team_id' }
    )

    if (error) {
      setMessage('שגיאה: ' + error.message)
    } else {
      setMessage('ההצעה נשמרה! ✓')
      onBidSubmitted?.()
    }
    setLoading(false)
  }

  return (
    <form onSubmit={handleSubmit} className="card">
      <h3 className="font-bold mb-2 text-sm" style={{ color: 'var(--muted)' }}>הגש הצעה — {team.name}</h3>

      <div className="flex gap-2 mb-3 text-center">
        <div className="flex-1 p-1.5 rounded-lg" style={{ background: 'var(--background)' }}>
          <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>תקציב</p>
          <p className="font-bold text-sm" style={{ color: 'var(--success)' }}>${team.budget_remaining}</p>
        </div>
        <div className="flex-1 p-1.5 rounded-lg" style={{ background: 'var(--background)' }}>
          <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>מקסימום</p>
          <p className="font-bold text-sm" style={{ color: 'var(--warning)' }}>${maxBid}</p>
        </div>
        <div className="flex-1 p-1.5 rounded-lg" style={{ background: 'var(--background)' }}>
          <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>שחקנים</p>
          <p className="font-bold text-sm">{team.player_count}/{league.players_per_team}</p>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1.5">סכום ($)</label>
        <input
          type="number"
          className="input font-bold text-center"
          min={1}
          max={maxBid}
          value={amount}
          onChange={e => setAmount(Number(e.target.value))}
          dir="ltr"
        />
      </div>

      {message && (
        <p className={`text-sm mt-2 ${message.startsWith('שגיאה') ? 'badge-red' : 'badge-green'}`}
          style={{ color: message.startsWith('שגיאה') ? 'var(--danger)' : 'var(--success)' }}>
          {message}
        </p>
      )}

      <button type="submit" className="btn btn-primary w-full mt-3 pulse-glow" disabled={loading}>
        {loading ? 'שומר...' : existingBid !== undefined ? 'עדכן הצעה' : 'הגש הצעה'}
      </button>

      {existingBid !== undefined && (
        <p className="text-xs text-center mt-2" style={{ color: 'var(--muted)' }}>
          הצעה נוכחית: ${existingBid} (ניתן לעדכן עד חשיפת התוצאות)
        </p>
      )}
    </form>
  )
}
