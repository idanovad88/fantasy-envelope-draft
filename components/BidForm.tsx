'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { getMaxBid } from '@/lib/utils'
import { unlockAudio } from '@/lib/sounds'
import type { Team, League } from '@/types'

interface BidFormProps {
  auctionId: string
  team: Team
  league: League
  existingBid?: number
  revealTime: string
  /** The team nominated this player — its $1 auto-bid cannot be withdrawn. */
  isNominator?: boolean
  onBidSubmitted?: () => void
}

function useCountdown(targetDate: string) {
  const calc = () => {
    const diff = new Date(targetDate).getTime() - Date.now()
    if (diff <= 0) return null
    return {
      hours: Math.floor(diff / (1000 * 60 * 60)),
      minutes: Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60)),
      seconds: Math.floor((diff % (1000 * 60)) / 1000),
    }
  }
  const [cd, setCd] = useState(calc)
  useEffect(() => {
    const t = setInterval(() => setCd(calc()), 1000)
    return () => clearInterval(t)
  }, [targetDate])
  return cd
}

export default function BidForm({ auctionId, team, league, existingBid, revealTime, isNominator, onBidSubmitted }: BidFormProps) {
  // Only the team that nominated the player may take him for $1 — that is its
  // mandatory auto-bid. Everyone else pays at least $2. Enforced in the DB too
  // (trg_enforce_min_bid), since bids are upserted straight from the browser.
  const minBid = isNominator ? 1 : 2
  const [amount, setAmount] = useState(existingBid ?? minBid)
  const [loading, setLoading] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [message, setMessage] = useState('')
  const supabase = createClient()
  const router = useRouter()
  const cd = useCountdown(revealTime)
  const expired = !cd
  // The nominating team's auto-bid is mandatory (enforced again server-side).
  const canCancel = existingBid !== undefined && !expired && !isNominator

  const maxBid = getMaxBid(team.budget_remaining, team.player_count, league.players_per_team)
  const cannotAfford = maxBid < minBid

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    unlockAudio()  // user gesture — unlock AudioContext for reveal sounds
    if (expired) { setMessage('המועד להגשת הצעות עבר'); return }
    setLoading(true)
    setMessage('')

    if (amount < minBid) { setMessage(`מינימום $${minBid}`); setLoading(false); return }
    if (amount > maxBid) { setMessage(`הצעה מקסימלית: $${maxBid}`); setLoading(false); return }

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

  // One click, no confirmation step — the bid can simply be submitted again
  // while the auction is still open, so a mis-click costs nothing.
  async function handleCancel() {
    setCancelling(true)
    setMessage('')

    const res = await fetch('/api/cancel-bid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auctionId }),
    })
    const data = await res.json().catch(() => ({}))

    if (!res.ok) {
      setMessage('שגיאה: ' + (data?.error ?? 'לא ניתן לבטל את ההצעה'))
    } else {
      setMessage('ההצעה בוטלה')
      setAmount(minBid)
      router.refresh()
    }
    setCancelling(false)
  }

  return (
    <form onSubmit={handleSubmit} className="card">
      <h3 className="font-bold mb-2 text-sm" style={{ color: 'var(--muted)' }}>הגש הצעה — {team.name}</h3>

      {/* Countdown */}
      <div className="mb-3 p-2 rounded-lg text-center" style={{ background: 'var(--background)' }}>
        {expired ? (
          <p className="font-bold text-sm" style={{ color: 'var(--danger)' }}>המועד להגשת הצעות עבר</p>
        ) : (
          <>
            <p className="text-xs mb-1.5" style={{ color: 'var(--muted)' }}>זמן נותר להגשה</p>
            <div className="flex justify-center items-end gap-3" dir="ltr">
              <div className="text-center">
                <p className="text-2xl font-bold tabular-nums" style={{ color: 'var(--primary)' }}>
                  {String(cd.hours).padStart(2, '0')}
                </p>
                <p className="text-xs" style={{ color: 'var(--muted)' }}>שעות</p>
              </div>
              <p className="text-2xl font-bold mb-4" style={{ color: 'var(--muted)' }}>:</p>
              <div className="text-center">
                <p className="text-2xl font-bold tabular-nums" style={{ color: 'var(--primary)' }}>
                  {String(cd.minutes).padStart(2, '0')}
                </p>
                <p className="text-xs" style={{ color: 'var(--muted)' }}>דקות</p>
              </div>
              <p className="text-2xl font-bold mb-4" style={{ color: 'var(--muted)' }}>:</p>
              <div className="text-center">
                <p className="text-2xl font-bold tabular-nums" style={{ color: 'var(--primary)' }}>
                  {String(cd.seconds).padStart(2, '0')}
                </p>
                <p className="text-xs" style={{ color: 'var(--muted)' }}>שניות</p>
              </div>
            </div>
          </>
        )}
      </div>

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
          min={minBid}
          max={maxBid}
          value={amount}
          onChange={e => setAmount(Number(e.target.value))}
          disabled={expired || cannotAfford}
          dir="ltr"
        />
        <p className="text-xs mt-1.5" style={{ color: 'var(--muted)' }}>
          {isNominator
            ? 'העלית את השחקן — אתה יכול לזכות בו ב-$1'
            : 'מינימום $2 — רק הקבוצה שהעלתה את השחקן יכולה לזכות בו ב-$1'}
        </p>
      </div>

      {message && (
        <p className="text-sm mt-2"
          style={{
            color: message.startsWith('שגיאה') || message.includes('עבר')
              ? 'var(--danger)'
              : message.includes('בוטלה') ? 'var(--warning)' : 'var(--success)'
          }}>
          {message}
        </p>
      )}

      <button type="submit" className="btn btn-primary w-full mt-3" disabled={loading || cancelling || expired || cannotAfford}>
        {expired ? 'הזמן עבר' : cannotAfford ? `אין תקציב ל-$${minBid}` : loading ? 'שומר...' : existingBid !== undefined ? 'עדכן הצעה' : 'הגש הצעה'}
      </button>

      {canCancel && (
        <button
          type="button"
          onClick={handleCancel}
          className="btn btn-outline w-full mt-2"
          style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
          disabled={loading || cancelling}
        >
          {cancelling ? 'מבטל...' : 'בטל הצעה'}
        </button>
      )}

      {existingBid !== undefined && !expired && (
        <p className="text-xs text-center mt-2" style={{ color: 'var(--muted)' }}>
          הצעה נוכחית: ${existingBid}
          {isNominator && ' · העלית את השחקן — ההצעה חייבת להישאר'}
        </p>
      )}
    </form>
  )
}
