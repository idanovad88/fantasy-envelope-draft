'use client'

import { useState } from 'react'

interface Props {
  playerId: string
  leagueId: string
  /** Server-rendered state. Re-synced when the page refreshes. */
  queued: boolean
  /**
   * Told about every successful toggle, so a parent holding the whole set stays
   * in step without a round trip. Same contract as WatchStar's.
   */
  onChange?: (queued: boolean) => void
  size?: 'sm' | 'md'
}

/**
 * Mark a player to be put on the board automatically.
 *
 * The list is per team — owner and assistant share it — and it is private:
 * a rival who could read it would know exactly whom to put up ahead of you.
 * When the team's turn comes, the first player on the list that is still
 * available and still affordable goes up on its own.
 *
 * Deliberately a second control beside the star rather than a reuse of it. The
 * star means "tell me what happens to him"; this means "I will spend money on
 * him", and a manager watching a rival's target must not be committing to buy.
 */
export default function QueueArrow({ playerId, leagueId, queued, onChange, size = 'sm' }: Props) {
  const [on, setOn] = useState(queued)
  const [busy, setBusy] = useState(false)

  // Prop is the truth whenever it changes — the page re-renders on every
  // realtime event. Adjusted during render, not in an effect, so a stale arrow
  // is never painted. Same shape as WatchStar.
  const [serverState, setServerState] = useState(queued)
  if (serverState !== queued) {
    setServerState(queued)
    setOn(queued)
  }

  async function toggle() {
    if (busy) return
    const next = !on
    setOn(next)
    setBusy(true)
    try {
      const res = await fetch('/api/open/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ league_id: leagueId, player_id: playerId, queued: next }),
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
      aria-label={on ? 'הסר מרשימת ההעלאות' : 'הוסף לרשימת ההעלאות'}
      aria-pressed={on}
      title={on ? 'ברשימת ההעלאות — יעלה אוטומטית בתורך' : 'הוסף לרשימת ההעלאות האוטומטית'}
      style={{
        background: 'none',
        border: 'none',
        padding: 0,
        lineHeight: 0,
        cursor: busy ? 'default' : 'pointer',
        color: on ? 'var(--primary)' : 'var(--muted)',
        opacity: on ? 1 : 0.55,
      }}
    >
      {/* Inline SVG rather than an arrow character. U+2B06 (⬆) carries an emoji
          presentation, so iOS and Android paint it as a colour emoji that
          ignores `color` entirely, while its hollow counterpart is a plain text
          glyph — the two states came out as two different icons, and the
          selected one was never the theme colour. ★/☆ next to it are safe
          because neither is an emoji. This is the same shape in both states,
          filled or hollow, and currentColor always applies. */}
      <svg
        viewBox="0 0 24 24"
        width={size === 'md' ? 20 : 16}
        height={size === 'md' ? 20 : 16}
        fill={on ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 3.2 20 12h-4.4v8.8H8.4V12H4z" />
      </svg>
    </button>
  )
}
