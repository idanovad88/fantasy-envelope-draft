'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Props {
  playerId: string
  leagueId: string
  playerName: string
  maxBid: number
}

export default function NominateButton({ playerId, leagueId, playerName, maxBid }: Props) {
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const router = useRouter()

  async function nominate() {
    if (amount < 1 || amount > maxBid) {
      setError(`הצעה חייבת להיות בין $1 ל-$${maxBid}`)
      return
    }
    setLoading(true)
    setError('')
    const res = await fetch('/api/nominate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player_id: playerId, league_id: leagueId, initial_bid: amount }),
    })
    const data = await res.json()
    if (data.error) {
      setError(data.error)
      setLoading(false)
    } else {
      setOpen(false)
      router.refresh()
    }
    setLoading(false)
  }

  if (!open) {
    return (
      <button
        onClick={() => { setAmount(1); setError(''); setOpen(true) }}
        className="btn btn-primary font-bold"
        style={{ padding: '2px 10px', fontSize: '18px', lineHeight: 1 }}
        title={`העלה את ${playerName} למכרז`}
      >
        +
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)' }}>
      <div className="card w-full max-w-xs" style={{ background: 'var(--card)' }}>
        <h3 className="font-bold text-lg mb-1">{playerName}</h3>
        <p className="text-sm mb-4" style={{ color: 'var(--muted)' }}>הגדר הצעת פתיחה</p>

        <label className="block text-sm font-medium mb-1.5">סכום ($)</label>
        <input
          type="number"
          className="input font-bold text-center mb-1"
          min={1}
          max={maxBid}
          value={amount}
          onChange={e => setAmount(Number(e.target.value))}
          dir="ltr"
          autoFocus
        />
        <p className="text-xs mb-4" style={{ color: 'var(--muted)' }}>מקסימום: ${maxBid}</p>

        {error && <p className="text-sm mb-3" style={{ color: 'var(--danger)' }}>{error}</p>}

        <div className="flex gap-2">
          <button className="btn btn-primary flex-1" onClick={nominate} disabled={loading}>
            {loading ? 'מעלה...' : '🚀 העלה למכרז'}
          </button>
          <button className="btn btn-outline flex-1" onClick={() => setOpen(false)} disabled={loading}>
            ביטול
          </button>
        </div>
      </div>
    </div>
  )
}
