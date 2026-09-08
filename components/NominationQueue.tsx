'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatCurrency } from '@/lib/utils'

export interface QueueRow {
  playerId: string
  name: string
  position: string | null
  openingBid: number
}

interface Props {
  leagueId: string
  /** In queue order, already filtered to players still in the pool. */
  rows: QueueRow[]
  /**
   * The team's ceiling for a new opening bid right now, display only. An entry
   * above it is not rejected — it is skipped when the turn comes, and the money
   * may well be free again by then.
   */
  maxOpeningBid: number
}

/**
 * The team's automatic nomination list.
 *
 * When the team's turn to put a player up comes round, the first entry that is
 * still available and still affordable goes up on its own, at the opening bid
 * set here. Nobody else can see this list.
 *
 * Collapsed by default: it is a thing you set up once and then leave alone,
 * and the players table under it is what the page is for.
 */
export default function NominationQueue({ leagueId, rows, maxOpeningBid }: Props) {
  // The editable copy. Re-seeded when the server list's CONTENT changes, the
  // same compare-during-render as PlayerPicker's star set — a router.refresh()
  // fires on every realtime event, and identity comparison would throw away an
  // edit in progress.
  const [draft, setDraft] = useState<QueueRow[]>(rows)
  const serverKey = rows.map(r => `${r.playerId}:${r.openingBid}`).join(',')
  const [seededFrom, setSeededFrom] = useState(serverKey)
  if (seededFrom !== serverKey) {
    setSeededFrom(serverKey)
    setDraft(rows)
  }

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const router = useRouter()

  const dirty = serverKey !== draft.map(r => `${r.playerId}:${r.openingBid}`).join(',')

  function move(index: number, by: number) {
    const to = index + by
    if (to < 0 || to >= draft.length) return
    const next = [...draft]
    ;[next[index], next[to]] = [next[to], next[index]]
    setDraft(next)
  }

  function remove(playerId: string) {
    setDraft(prev => prev.filter(r => r.playerId !== playerId))
  }

  function setBid(playerId: string, raw: string) {
    const n = Number(raw)
    setDraft(prev =>
      prev.map(r => (r.playerId === playerId ? { ...r, openingBid: Number.isFinite(n) ? n : 1 } : r))
    )
  }

  async function save() {
    if (draft.some(r => !Number.isInteger(r.openingBid) || r.openingBid < 1)) {
      setError('הצעת פתיחה חייבת להיות מספר שלם, לפחות $1')
      return
    }
    setBusy(true)
    setError('')
    const res = await fetch('/api/open/queue/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        league_id: leagueId,
        entries: draft.map((r, i) => ({
          player_id: r.playerId,
          position: i + 1,
          opening_bid: r.openingBid,
        })),
      }),
    })
    const data = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) {
      setError(data?.error ?? 'השמירה נכשלה')
      return
    }
    router.refresh()
  }

  return (
    <details className="card mb-4">
      <summary className="cursor-pointer font-bold">
        ⬆ רשימת ההעלאות שלי ({rows.length})
      </summary>

      <p className="text-xs mt-2 mb-3" style={{ color: 'var(--muted)' }}>
        כשיגיע תורך להעלות שחקן, הראשון ברשימה שעדיין זמין ושהתקציב מספיק לו יעלה
        ללוח אוטומטית במחיר הפתיחה שנקבע לו. הרשימה פרטית — אף קבוצה אחרת לא רואה
        אותה. שחקן שמישהו אחר העלה לפניך פשוט מדולג.
      </p>

      {draft.length === 0 ? (
        <p className="text-sm py-2" style={{ color: 'var(--muted)' }}>
          הרשימה ריקה — סמן שחקנים בחץ ⬆ בטבלה למטה. בלי רשימה, התור פשוט ממתין לך.
        </p>
      ) : (
        <div className="flex flex-col">
          {draft.map((r, i) => {
            const tooExpensive = r.openingBid > maxOpeningBid
            return (
              <div
                key={r.playerId}
                className="flex items-center gap-2 py-2 border-b flex-wrap"
                style={{ borderColor: 'var(--border)' }}
              >
                <span className="font-bold w-6 text-center" style={{ color: 'var(--muted)' }}>
                  {i + 1}
                </span>
                {r.position && (
                  <span className="badge badge-gray text-xs w-8 text-center shrink-0">{r.position}</span>
                )}
                <span className="font-medium flex-1 min-w-[7rem]" dir="ltr">{r.name}</span>

                <label className="text-xs" style={{ color: 'var(--muted)' }}>פתיחה $</label>
                <input
                  className="input text-center"
                  style={{ width: 72, padding: '4px 6px' }}
                  type="number"
                  min={1}
                  value={r.openingBid}
                  onChange={e => setBid(r.playerId, e.target.value)}
                  dir="ltr"
                />

                <button
                  type="button"
                  className="btn btn-outline"
                  style={{ fontSize: '0.7rem', padding: '2px 8px' }}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  aria-label="העלה במיקום"
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="btn btn-outline"
                  style={{ fontSize: '0.7rem', padding: '2px 8px' }}
                  disabled={i === draft.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label="הורד במיקום"
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="btn btn-outline"
                  style={{ fontSize: '0.7rem', padding: '2px 8px', color: 'var(--danger)', borderColor: 'var(--danger)' }}
                  onClick={() => remove(r.playerId)}
                  aria-label="הסר מהרשימה"
                >
                  ✕
                </button>

                {/* Not an error: the ceiling moves the moment this team is
                    outbid somewhere else, so the entry may well be affordable
                    by the time its turn comes. It is only skipped meanwhile. */}
                {tooExpensive && (
                  <p className="text-xs w-full" style={{ color: 'var(--warning)' }}>
                    מעל התקציב הפנוי שלך כרגע ({formatCurrency(Math.max(maxOpeningBid, 0))}) — יידלג לשחקן הבא ברשימה
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}

      {error && <p className="text-sm mt-2" style={{ color: 'var(--danger)' }}>{error}</p>}

      {dirty && (
        <div className="flex items-center gap-3 mt-3">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>
            {busy ? 'שומר...' : 'שמור רשימה'}
          </button>
          <button
            type="button"
            className="btn btn-outline"
            disabled={busy}
            onClick={() => { setDraft(rows); setError('') }}
          >
            בטל שינויים
          </button>
        </div>
      )}
    </details>
  )
}
