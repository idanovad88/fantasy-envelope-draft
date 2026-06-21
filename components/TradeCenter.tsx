'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { TradeStatus } from '@/types'

export type AssetLabel = { type: 'pick' | 'player'; label: string }

export type TeamAssets = {
  teamId: string
  teamName: string
  picks: { overall_pick_number: number; round: number; pickInRound: number }[]
  players: { id: string; name: string; position: string | null }[]
}

export type TradeView = {
  id: string
  status: TradeStatus
  note: string | null
  rejection_reason: string | null
  created_at: string
  proposingTeamId: string
  targetTeamId: string
  proposingName: string
  targetName: string
  proposingGives: AssetLabel[]
  targetGives: AssetLabel[]
}

interface Props {
  leagueId: string
  myTeamId: string
  teams: { id: string; name: string }[]
  catalog: Record<string, TeamAssets>
  trades: TradeView[]
  /** asset keys (`pick:<n>` / `player:<id>`) tied up in other open trades */
  lockedKeys: string[]
}

const STATUS_LABEL: Record<TradeStatus, string> = {
  pending_target: 'ממתין לתגובת היריבה',
  pending_admin: 'ממתין לאישור מנהל',
  approved: 'בוצע',
  rejected: 'נדחה',
  cancelled: 'בוטל',
}

const STATUS_BADGE: Record<TradeStatus, string> = {
  pending_target: 'badge-yellow',
  pending_admin: 'badge-yellow',
  approved: 'badge-green',
  rejected: 'badge-red',
  cancelled: 'badge-gray',
}

export default function TradeCenter({ leagueId, myTeamId, teams, catalog, trades, lockedKeys }: Props) {
  const router = useRouter()
  const locked = new Set(lockedKeys)
  const [targetId, setTargetId] = useState('')
  const [mySel, setMySel] = useState<Set<string>>(new Set())
  const [targetSel, setTargetSel] = useState<Set<string>>(new Set())
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState('')
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')

  const myAssets = catalog[myTeamId]
  const targetAssets = targetId ? catalog[targetId] : null

  function toggle(set: Set<string>, key: string, setter: (s: Set<string>) => void) {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setter(next)
  }

  function onTargetChange(id: string) {
    setTargetId(id)
    setMySel(new Set())
    setTargetSel(new Set())
    setError('')
    setMsg('')
  }

  function keyToAsset(key: string, fromTeamId: string) {
    const [type, val] = key.split(':')
    if (type === 'pick') {
      return { from_team_id: fromTeamId, asset_type: 'pick' as const, overall_pick_number: Number(val) }
    }
    return { from_team_id: fromTeamId, asset_type: 'player' as const, player_id: val }
  }

  const balanced = mySel.size > 0 && mySel.size === targetSel.size

  async function submitProposal() {
    if (!targetId || !balanced) return
    setLoading('propose')
    setError('')
    setMsg('')
    const assets = [
      ...[...mySel].map(k => keyToAsset(k, myTeamId)),
      ...[...targetSel].map(k => keyToAsset(k, targetId)),
    ]
    const res = await fetch('/api/trades/propose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ league_id: leagueId, target_team_id: targetId, assets, note: note.trim() || null }),
    })
    const data = await res.json()
    setLoading('')
    if (!res.ok) { setError(data.error ?? 'שגיאה בשליחת ההצעה'); return }
    setMsg('ההצעה נשלחה!')
    setMySel(new Set()); setTargetSel(new Set()); setNote('')
    router.refresh()
  }

  async function act(url: string, body: object, key: string) {
    setLoading(key)
    setError('')
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    setLoading('')
    if (!res.ok) { setError(data.error ?? 'שגיאה'); return }
    router.refresh()
  }

  const incoming = trades.filter(t => t.targetTeamId === myTeamId && t.status === 'pending_target')
  const sent = trades.filter(t => t.proposingTeamId === myTeamId && (t.status === 'pending_target' || t.status === 'pending_admin'))
  const awaitingAdmin = trades.filter(t => t.targetTeamId === myTeamId && t.status === 'pending_admin')
  const history = trades.filter(t =>
    (t.proposingTeamId === myTeamId || t.targetTeamId === myTeamId) &&
    ['approved', 'rejected', 'cancelled'].includes(t.status)
  )

  const otherTeams = teams.filter(t => t.id !== myTeamId)

  return (
    <div className="flex flex-col gap-4">
      {error && <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>}
      {msg && <p className="text-sm" style={{ color: 'var(--success)' }}>{msg}</p>}

      {/* ── New proposal ─────────────────────────────────────────── */}
      <div className="card">
        <h2 className="font-bold mb-3">הצעה חדשה</h2>

        <label className="text-sm block mb-1" style={{ color: 'var(--muted)' }}>קבוצת יעד</label>
        <select className="input mb-4" value={targetId} onChange={e => onTargetChange(e.target.value)}>
          <option value="">בחר קבוצה...</option>
          {otherTeams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>

        {targetId && targetAssets && myAssets && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <AssetColumn title="אתה נותן" assets={myAssets} selected={mySel} locked={locked} onToggle={k => toggle(mySel, k, setMySel)} />
              <AssetColumn title={`${targetAssets.teamName} נותן`} assets={targetAssets} selected={targetSel} locked={locked} onToggle={k => toggle(targetSel, k, setTargetSel)} />
            </div>

            <div className="mt-4 flex items-center justify-between flex-wrap gap-2">
              <span className="text-sm" style={{ color: balanced ? 'var(--success)' : 'var(--muted)' }}>
                {mySel.size} מול {targetSel.size} נכסים {balanced ? '✓ מאוזן' : '— כל צד חייב לתת אותו מספר'}
              </span>
            </div>

            <input
              className="input mt-3"
              placeholder="הודעה (אופציונלי)"
              value={note}
              onChange={e => setNote(e.target.value)}
            />

            <button
              className="btn btn-primary w-full mt-3"
              disabled={!balanced || loading === 'propose'}
              onClick={submitProposal}
            >
              {loading === 'propose' ? '...' : 'שלח הצעת טרייד'}
            </button>
          </>
        )}
      </div>

      {/* ── Incoming (need my response) ──────────────────────────── */}
      {incoming.length > 0 && (
        <div className="card">
          <h2 className="font-bold mb-3">הצעות שמחכות לתגובתך ({incoming.length})</h2>
          <div className="flex flex-col gap-3">
            {incoming.map(t => (
              <TradeRow key={t.id} trade={t} myTeamId={myTeamId}>
                <div className="flex gap-2 mt-2">
                  <button className="btn btn-primary text-sm" disabled={loading === t.id}
                    onClick={() => act('/api/trades/respond', { trade_id: t.id, action: 'accept' }, t.id)}>
                    אשר
                  </button>
                  <button className="btn btn-outline text-sm" disabled={loading === t.id}
                    onClick={() => act('/api/trades/respond', { trade_id: t.id, action: 'reject' }, t.id)}>
                    דחה
                  </button>
                </div>
              </TradeRow>
            ))}
          </div>
        </div>
      )}

      {/* ── Sent by me (pending) ─────────────────────────────────── */}
      {sent.length > 0 && (
        <div className="card">
          <h2 className="font-bold mb-3">הצעות ששלחתי ({sent.length})</h2>
          <div className="flex flex-col gap-3">
            {sent.map(t => (
              <TradeRow key={t.id} trade={t} myTeamId={myTeamId}>
                <div className="flex items-center gap-2 mt-2">
                  <span className={`badge ${STATUS_BADGE[t.status]} text-xs`}>{STATUS_LABEL[t.status]}</span>
                  <button className="btn btn-outline text-sm" disabled={loading === t.id}
                    onClick={() => act('/api/trades/cancel', { trade_id: t.id }, t.id)}>
                    בטל
                  </button>
                </div>
              </TradeRow>
            ))}
          </div>
        </div>
      )}

      {/* ── Accepted by me, awaiting admin ───────────────────────── */}
      {awaitingAdmin.length > 0 && (
        <div className="card">
          <h2 className="font-bold mb-3">ממתין לאישור מנהל ({awaitingAdmin.length})</h2>
          <div className="flex flex-col gap-3">
            {awaitingAdmin.map(t => (
              <TradeRow key={t.id} trade={t} myTeamId={myTeamId}>
                <span className={`badge ${STATUS_BADGE[t.status]} text-xs mt-2 inline-block`}>{STATUS_LABEL[t.status]}</span>
              </TradeRow>
            ))}
          </div>
        </div>
      )}

      {/* ── History ──────────────────────────────────────────────── */}
      {history.length > 0 && (
        <div className="card">
          <h2 className="font-bold mb-3">היסטוריה</h2>
          <div className="flex flex-col gap-3">
            {history.map(t => (
              <TradeRow key={t.id} trade={t} myTeamId={myTeamId}>
                <div className="mt-2">
                  <span className={`badge ${STATUS_BADGE[t.status]} text-xs`}>{STATUS_LABEL[t.status]}</span>
                  {t.rejection_reason && (
                    <span className="text-xs mr-2" style={{ color: 'var(--muted)' }}>· {t.rejection_reason}</span>
                  )}
                </div>
              </TradeRow>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function AssetColumn({
  title, assets, selected, locked, onToggle,
}: {
  title: string
  assets: TeamAssets
  selected: Set<string>
  locked: Set<string>
  onToggle: (key: string) => void
}) {
  return (
    <div className="rounded-lg p-3" style={{ background: 'var(--background)' }}>
      <h3 className="font-bold text-sm mb-2">{title}</h3>
      {assets.picks.length === 0 && assets.players.length === 0 && (
        <p className="text-xs" style={{ color: 'var(--muted)' }}>אין נכסים זמינים</p>
      )}
      {assets.players.length > 0 && (
        <div className="mb-2">
          <p className="text-xs mb-1" style={{ color: 'var(--muted)' }}>שחקנים</p>
          {assets.players.map(p => {
            const key = `player:${p.id}`
            return (
              <CheckRow key={key} checked={selected.has(key)} disabled={locked.has(key)} onChange={() => onToggle(key)}>
                <span dir="ltr">{p.name}</span>
                {p.position && <span className="badge badge-gray text-xs mr-2">{p.position}</span>}
              </CheckRow>
            )
          })}
        </div>
      )}
      {assets.picks.length > 0 && (
        <div>
          <p className="text-xs mb-1" style={{ color: 'var(--muted)' }}>בחירות עתידיות</p>
          {assets.picks.map(pk => {
            const key = `pick:${pk.overall_pick_number}`
            return (
              <CheckRow key={key} checked={selected.has(key)} disabled={locked.has(key)} onChange={() => onToggle(key)}>
                סיבוב {pk.round}, בחירה {pk.pickInRound} <span style={{ color: 'var(--muted)' }}>#{pk.overall_pick_number}</span>
              </CheckRow>
            )
          })}
        </div>
      )}
    </div>
  )
}

function CheckRow({ checked, onChange, disabled, children }: { checked: boolean; onChange: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <label
      className="flex items-center gap-2 text-sm py-1"
      style={{ cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 }}
    >
      <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} />
      <span className="flex items-center gap-1">{children}</span>
      {disabled && <span className="text-xs" style={{ color: 'var(--muted)' }}>· בהצעה פתוחה</span>}
    </label>
  )
}

function TradeRow({ trade, myTeamId, children }: { trade: TradeView; myTeamId: string; children?: React.ReactNode }) {
  const iAmProposer = trade.proposingTeamId === myTeamId
  // "I give" / "I get" perspective
  const iGive = iAmProposer ? trade.proposingGives : trade.targetGives
  const iGet = iAmProposer ? trade.targetGives : trade.proposingGives
  const otherName = iAmProposer ? trade.targetName : trade.proposingName

  return (
    <div className="rounded-lg p-3" style={{ background: 'var(--background)', border: '1px solid var(--border)' }}>
      <p className="text-sm font-medium mb-2">מול {otherName}</p>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <p className="text-xs mb-1" style={{ color: 'var(--danger)' }}>אתה נותן</p>
          {iGive.length === 0 ? <p className="text-xs" style={{ color: 'var(--muted)' }}>—</p> :
            iGive.map((a, i) => <p key={i} dir={a.type === 'player' ? 'ltr' : 'rtl'}>{a.label}</p>)}
        </div>
        <div>
          <p className="text-xs mb-1" style={{ color: 'var(--success)' }}>אתה מקבל</p>
          {iGet.length === 0 ? <p className="text-xs" style={{ color: 'var(--muted)' }}>—</p> :
            iGet.map((a, i) => <p key={i} dir={a.type === 'player' ? 'ltr' : 'rtl'}>{a.label}</p>)}
        </div>
      </div>
      {trade.note && <p className="text-xs mt-2" style={{ color: 'var(--muted)' }}>💬 {trade.note}</p>}
      {children}
    </div>
  )
}
