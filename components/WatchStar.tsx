'use client'

import { useState } from 'react'

interface Props {
  playerId: string
  /** Server-rendered state. Re-synced when the page refreshes. */
  watched: boolean
  /**
   * Told about every successful toggle, so a parent holding the whole set (the
   * "starred only" chip in PlayerPicker) stays in step without a round trip to
   * the server.
   */
  onChange?: (watched: boolean) => void
  /** Slightly larger on the board cards than in a table row. */
  size?: 'sm' | 'md'
}

/**
 * Star a player to follow him.
 *
 * The list is private to the user, and in an open-outcry league it is what the
 * notification cron reads: a starred player going up, or being raised, sends
 * that user a push. One click, no confirmation — the same click undoes it.
 */
export default function WatchStar({ playerId, watched, onChange, size = 'sm' }: Props) {
  const [on, setOn] = useState(watched)
  const [busy, setBusy] = useState(false)

  // The star is rendered from server data, and the page re-renders on every
  // realtime event, so the prop is the truth whenever it changes. Adjusted
  // during render rather than in an effect — React re-runs the component before
  // committing, so a stale star is never painted (same shape as the price floor
  // in OpenAuctionBoard).
  const [serverState, setServerState] = useState(watched)
  if (serverState !== watched) {
    setServerState(watched)
    setOn(watched)
  }

  async function toggle() {
    if (busy) return
    const next = !on
    // Optimistic: the click has to feel instant in a live auction.
    setOn(next)
    setBusy(true)
    try {
      const res = await fetch('/api/players/watch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ player_id: playerId, watched: next }),
      })
      if (!res.ok) throw new Error('failed')
      onChange?.(next)
    } catch {
      setOn(!next)
    }
    setBusy(false)
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={on ? 'הסר מהמעקב' : 'הוסף למעקב'}
      aria-pressed={on}
      title={on ? 'במעקב — תקבל התראה על הצעות' : 'עקוב וקבל התראות'}
      style={{
        background: 'none',
        border: 'none',
        padding: 0,
        lineHeight: 1,
        cursor: busy ? 'default' : 'pointer',
        fontSize: size === 'md' ? '1.25rem' : '1rem',
        color: on ? 'var(--warning)' : 'var(--muted)',
        opacity: on ? 1 : 0.55,
      }}
    >
      {on ? '★' : '☆'}
    </button>
  )
}
