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
      <h3 className="font-bold mb-3">הגש הצעה — {team.name}</h3>

      <div className="grid grid-cols-3 gap-3 mb-4 text-center">
        <div className="p-2 rounded-lg" style={{ background: 'var(--background)' }}>
          <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>תקציב נותר</p>
          <p className="font-bold" style={{ color: 'var(--success)' }}>${team.budget_remaining}</p>
        </div>
        <div className="p-2 rounded-lg" style={{ background: 'var(--background)' }}>
          <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>מקסימום הצעה</p>
          <p className="font-bold" style={{ color: 'var(--warning)' }}>${maxBid}</p>
        </div>
        <div className="p-2 rounded-lg" style={{ background: 'var(--background)' }}>
          <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>ריקים לסגור</p>
          <p className="font-bold">{league.players_per_team - team.player_count}</p>
        </div>
      </div>

      <div className="flex gap-3 items-end">
        <div className="flex-1">
          <label className="block text-sm font-medium mb-1.5">סכום ($)</label>
          <input
            type="number"
            className="input text-xl font-bold text-center"
            min={0}
            max={maxBid}
            value={amount}
            onChange={e => setAmount(Number(e.target.value))}
            dir="ltr"
          />
        </div>
        <div className="flex gap-2">
          {[1, 5, 10, 25].map(v => (
            <button
              key={v}
              type="button"
              className="btn btn-outline px-2 py-1 text-xs"
              onClick={() => setAmount(prev => Math.min(prev + v, maxBid))}
            >
              +{v}
            </button>
          ))}
        </div>
      </div>

      {message && (
        <p className={`text-sm mt-2 ${message.startsWith('שגיאה') ? 'badge-red' : 'badge-green'}`}
          style={{ color: message.startsWith('שגיאה') ? 'var(--danger)' : 'var(--success)' }}>
          {message}
        </p>
      )}

      <button type="submit" className="btn btn-primary w-full mt-4 pulse-glow" disabled={loading}>
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
