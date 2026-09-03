'use client'

import { Fragment, useState } from 'react'
import { useRouter } from 'next/navigation'
import { usePlayerFilter } from '@/hooks/usePlayerFilter'
import PlayerFilterBar from './PlayerFilterBar'

type Player = {
  id: string
  name: string
  position: string | null
  nba_team: string | null
  ranking: number | null
}

interface Props {
  players: Player[]
  leagueId: string
  /** Whether the action button is shown at all — i.e. it is this user's turn. */
  canPick: boolean
  /** Admin acting for another team. Passed straight through as `team_id`. */
  pickingTeamId?: string
  /**
   * Both draft actions post the same `{ league_id, player_id, team_id? }` body,
   * so the two formats differ only in where it goes and what the button says.
   */
  endpoint?: string
  actionLabel?: string
  title?: string
  /**
   * Open outcry only: let the nominator name the price the auction starts at
   * instead of the fixed $1. Pressing the action button then opens the amount
   * under that player's row rather than sending straight away — an input
   * sitting above the list was read as part of the search header and missed.
   */
  askOpeningBid?: boolean
  /** Display-only ceiling for that input; `open_nominate()` is the real gate. */
  maxOpeningBid?: number
}

export default function PlayerPicker({
  players,
  leagueId,
  canPick,
  pickingTeamId,
  endpoint = '/api/snake-pick',
  actionLabel = 'בחר',
  title = 'שחקנים זמינים',
  askOpeningBid = false,
  maxOpeningBid,
}: Props) {
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState('')
  // Kept as a string so the field can be emptied while typing instead of
  // snapping back to 1 on every keystroke.
  const [openingBid, setOpeningBid] = useState('1')
  // Open outcry: the player whose opening-bid panel is showing, if any.
  const [pendingId, setPendingId] = useState<string | null>(null)
  const router = useRouter()

  const openingBidNum = Number(openingBid)
  const openingBidValid =
    Number.isInteger(openingBidNum) &&
    openingBidNum >= 1 &&
    (maxOpeningBid === undefined || openingBidNum <= maxOpeningBid)

  const { query, setQuery, position, setPosition, sortKey, setSortKey, positions, filtered } =
    usePlayerFilter(players)

  // The row button opens the amount panel instead of nominating outright; a
  // second press on the same row closes it again.
  function togglePending(playerId: string) {
    setError('')
    setOpeningBid('1')
    setPendingId(prev => (prev === playerId ? null : playerId))
  }

  async function handlePick(playerId: string) {
    setLoading(playerId)
    setError('')
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        league_id: leagueId,
        player_id: playerId,
        ...(pickingTeamId ? { team_id: pickingTeamId } : {}),
        ...(askOpeningBid ? { opening_bid: openingBidNum } : {}),
      }),
    })
    const data = await res.json()
    setLoading(null)
    if (!res.ok) {
      setError(data.error ?? 'הפעולה נכשלה')
      return
    }
    setPendingId(null)
    router.refresh()
  }

  return (
    <div className="card">
      <PlayerFilterBar
        title={title}
        total={players.length}
        shown={filtered.length}
        query={query}
        onQuery={setQuery}
        positions={positions}
        position={position}
        onPosition={setPosition}
        sortKey={sortKey}
        onSort={setSortKey}
      />

      {error && (
        <p className="text-sm mb-2" style={{ color: 'var(--danger)' }}>{error}</p>
      )}

      {filtered.length === 0 ? (
        <p className="text-sm text-center py-4" style={{ color: 'var(--muted)' }}>לא נמצאו שחקנים</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
                <th className="text-right pb-2 pr-2 w-8">#</th>
                <th className="text-right pb-2">שחקן</th>
                {canPick && <th className="pb-2 w-20"></th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map(p => (
                <Fragment key={p.id}>
                <tr className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="py-2 pr-2" style={{ color: 'var(--muted)' }}>{p.ranking ?? '—'}</td>
                  <td className="py-2">
                    <div className="flex items-center gap-2" dir="ltr">
                      {p.position && (
                        <span style={{ background: 'rgba(99,102,241,0.2)', color: 'var(--primary)', fontSize: '11px', padding: '1px 5px', borderRadius: '4px', flexShrink: 0, minWidth: 28, textAlign: 'center' }}>
                          {p.position}
                        </span>
                      )}
                      <span className="font-medium">{p.name}</span>
                      {p.nba_team && (
                        <span style={{ color: 'var(--muted)', fontSize: '0.7rem' }}>{p.nba_team}</span>
                      )}
                    </div>
                  </td>
                  {canPick && (
                    <td className="py-2 text-center">
                      <button
                        className={pendingId === p.id ? 'btn btn-outline' : 'btn btn-primary'}
                        style={{ fontSize: '0.75rem', padding: '4px 12px' }}
                        disabled={loading === p.id}
                        onClick={() => (askOpeningBid ? togglePending(p.id) : handlePick(p.id))}
                      >
                        {loading === p.id ? '...' : pendingId === p.id ? 'סגור' : actionLabel}
                      </button>
                    </td>
                  )}
                </tr>

                {/* The amount opens under the player it belongs to, so the
                    number and the name are read together. */}
                {canPick && askOpeningBid && pendingId === p.id && (
                  <tr style={{ background: 'var(--background)' }}>
                    <td colSpan={3} className="p-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        <label className="text-sm whitespace-nowrap" style={{ color: 'var(--muted)' }}>
                          הצעת פתיחה $
                        </label>
                        <input
                          className="input"
                          style={{ width: 90, padding: '4px 8px' }}
                          type="number"
                          min={1}
                          max={maxOpeningBid}
                          value={openingBid}
                          onChange={e => setOpeningBid(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter' && openingBidValid) handlePick(p.id)
                          }}
                          dir="ltr"
                          autoFocus
                        />
                        <button
                          className="btn btn-primary"
                          style={{ fontSize: '0.75rem', padding: '4px 12px' }}
                          disabled={loading === p.id || !openingBidValid}
                          onClick={() => handlePick(p.id)}
                        >
                          {loading === p.id ? 'מעלה...' : `העלה את ${p.name}`}
                        </button>
                      </div>
                      <p className="text-xs mt-2" style={{ color: 'var(--muted)' }}>
                        {maxOpeningBid !== undefined ? `מקסימום $${Math.max(maxOpeningBid, 0)} · ` : ''}
                        המחיר שהמכרז נפתח בו — כל קבוצה אחרת תצטרך לעקוף אותו
                      </p>
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
