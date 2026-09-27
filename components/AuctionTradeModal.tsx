'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Player, Team } from '@/types'

/**
 * Propose an auction trade: players for players, the same number each way,
 * plus optional cash in either direction. Opened from a player on another
 * team's card in /teams. The budget line here is a preview — the server
 * checks the real floor (open bids and led auctions included).
 */
export default function AuctionTradeModal({
  leagueId, myTeam, myRoster, otherTeam, otherRoster, initialPlayerId, playersPerTeam, onClose,
}: {
  leagueId: string
  myTeam: Team
  myRoster: Player[]
  otherTeam: Team
  otherRoster: Player[]
  initialPlayerId: string
  playersPerTeam: number
  onClose: () => void
}) {
  const router = useRouter()
  const [getIds, setGetIds] = useState<Set<string>>(() => new Set([initialPlayerId]))
  const [giveIds, setGiveIds] = useState<Set<string>>(new Set())
  const [cash, setCash] = useState(0)
  const [cashDir, setCashDir] = useState<'give' | 'get'>('give')
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, id: string) => {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setter(next)
  }

  const cashOk = Number.isInteger(cash) && cash >= 0
  const myAfter = myTeam.budget_remaining + (cashDir === 'give' ? -cash : cash)
  const otherAfter = otherTeam.budget_remaining + (cashDir === 'give' ? cash : -cash)
  // $1 for every empty roster slot — the part of the floor visible from here.
  const myFloor = Math.max(playersPerTeam - myTeam.player_count, 0)
  const otherFloor = Math.max(playersPerTeam - otherTeam.player_count, 0)
  const myShort = cash > 0 && cashDir === 'give' && myAfter < myFloor
  const otherShort = cash > 0 && cashDir === 'get' && otherAfter < otherFloor

  const balanced = giveIds.size > 0 && giveIds.size === getIds.size
  const canSend = balanced && cashOk && !myShort && !otherShort && !loading

  async function submit() {
    if (!canSend) return
    setLoading(true)
    setError('')
    const res = await fetch('/api/trades/propose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        league_id: leagueId,
        target_team_id: otherTeam.id,
        give_player_ids: [...giveIds],
        get_player_ids: [...getIds],
        cash_amount: cash,
        cash_direction: cashDir,
        note: note.trim() || null,
      }),
    })
    const data = await res.json().catch(() => ({}))
    setLoading(false)
    if (!res.ok) { setError(data.error ?? 'שגיאה בשליחת ההצעה'); return }
    setSent(true)
    router.refresh()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="card w-full max-w-lg" style={{ background: 'var(--card)', maxHeight: '90dvh', overflowY: 'auto' }}>
        <div className="flex items-center justify-between gap-3 mb-4">
          <h3 className="font-bold text-lg min-w-0 truncate">🔄 הצעת טרייד ל{otherTeam.name}</h3>
          <button onClick={onClose} aria-label="סגור" style={{ color: 'var(--muted)', fontSize: 20, lineHeight: 1 }}>✕</button>
        </div>

        {sent ? (
          <div className="text-center py-4">
            <p className="font-bold mb-1" style={{ color: 'var(--success)' }}>ההצעה נשלחה!</p>
            <p className="text-sm mb-4" style={{ color: 'var(--muted)' }}>
              {otherTeam.name} יראו אותה בדף הבית. אם יאשרו, היא תעבור לאישור מנהל הליגה.
            </p>
            <button className="btn btn-primary" onClick={onClose}>סגור</button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
              <PlayerColumn
                title={`אתה מקבל (${getIds.size})`}
                color="var(--success)"
                roster={otherRoster}
                selected={getIds}
                onToggle={id => toggle(getIds, setGetIds, id)}
              />
              <PlayerColumn
                title={`אתה נותן (${giveIds.size})`}
                color="var(--danger)"
                roster={myRoster}
                selected={giveIds}
                onToggle={id => toggle(giveIds, setGiveIds, id)}
              />
            </div>

            {!balanced && (
              <p className="text-xs mb-3" style={{ color: 'var(--warning)' }}>
                כל צד חייב לתת אותו מספר שחקנים ({giveIds.size} מול {getIds.size})
              </p>
            )}

            <div className="rounded-lg p-3 mb-3" style={{ background: 'var(--background)' }}>
              <p className="text-sm font-medium mb-2">💰 תוספת כסף (לא חובה)</p>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--border)' }}>
                  {(['give', 'get'] as const).map(d => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setCashDir(d)}
                      className="text-sm"
                      style={{
                        padding: '6px 12px',
                        background: cashDir === d ? 'var(--primary)' : 'transparent',
                        color: cashDir === d ? 'white' : 'var(--text)',
                      }}
                    >
                      {d === 'give' ? 'אני מוסיף' : 'אני מבקש'}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    className="input font-bold text-center"
                    style={{ width: 90 }}
                    min={0}
                    step={1}
                    value={cash}
                    onChange={e => setCash(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                    dir="ltr"
                  />
                  <span className="text-sm">$</span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 mt-3 text-xs">
                <BudgetLine name="אתה" before={myTeam.budget_remaining} after={myAfter} short={myShort} />
                <BudgetLine name={otherTeam.name} before={otherTeam.budget_remaining} after={otherAfter} short={otherShort} />
              </div>
              {(myShort || otherShort) && (
                <p className="text-xs mt-2" style={{ color: 'var(--danger)' }}>
                  כל קבוצה חייבת להישאר עם לפחות $1 לכל מקום פנוי בסגל
                </p>
              )}
            </div>

            <textarea
              className="input mb-3"
              rows={2}
              maxLength={300}
              placeholder="הערה (לא חובה)"
              value={note}
              onChange={e => setNote(e.target.value)}
            />

            {error && <p className="text-sm mb-3" style={{ color: 'var(--danger)' }}>{error}</p>}

            <div className="flex gap-2">
              <button className="btn btn-primary flex-1" onClick={submit} disabled={!canSend}>
                {loading ? 'שולח...' : 'שלח הצעה'}
              </button>
              <button className="btn btn-outline flex-1" onClick={onClose} disabled={loading}>ביטול</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function PlayerColumn({ title, color, roster, selected, onToggle }: {
  title: string
  color: string
  roster: Player[]
  selected: Set<string>
  onToggle: (id: string) => void
}) {
  return (
    <div className="rounded-lg p-3 min-w-0" style={{ background: 'var(--background)' }}>
      <p className="text-sm font-bold mb-2" style={{ color }}>{title}</p>
      {roster.length === 0 && <p className="text-xs" style={{ color: 'var(--muted)' }}>אין שחקנים</p>}
      {roster.map(p => (
        <label key={p.id} className="flex items-center gap-2 text-sm py-1" style={{ cursor: 'pointer' }}>
          <input type="checkbox" checked={selected.has(p.id)} onChange={() => onToggle(p.id)} />
          <span className="truncate min-w-0" dir="ltr">{p.name}</span>
          {p.position && <span className="badge badge-gray text-xs" dir="ltr">{p.position}</span>}
          <span className="text-xs mr-auto" style={{ color: 'var(--muted)' }}>${p.draft_price}</span>
        </label>
      ))}
    </div>
  )
}

function BudgetLine({ name, before, after, short }: { name: string; before: number; after: number; short: boolean }) {
  return (
    <div className="min-w-0">
      <p className="truncate" style={{ color: 'var(--muted)' }}>{name}</p>
      <p dir="ltr" style={{ textAlign: 'right', color: short ? 'var(--danger)' : 'var(--text)' }}>
        ${before} → <b>${after}</b>
      </p>
    </div>
  )
}
