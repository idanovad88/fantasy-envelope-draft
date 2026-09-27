'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { AuctionTradeView } from '@/lib/auctionTradeViews'
import { sideSummary } from '@/lib/auctionTradeViews'

/**
 * The caller's own auction trades: offers waiting on them, offers they sent,
 * and — when `showHistory` — the ones already decided. Mounted on the
 * dashboard (open items only, hidden when empty) and on /trades.
 */
export default function TradeInbox({
  myTeamId,
  trades,
  showHistory = false,
  title = 'טריידים',
}: {
  myTeamId: string
  trades: AuctionTradeView[]
  showHistory?: boolean
  title?: string
}) {
  const router = useRouter()
  const [loading, setLoading] = useState('')
  const [error, setError] = useState('')

  const incoming = trades.filter(t => t.targetTeamId === myTeamId && t.status === 'pending_target')
  const sent = trades.filter(t => t.proposingTeamId === myTeamId && (t.status === 'pending_target' || t.status === 'pending_admin'))
  const awaitingAdmin = trades.filter(t => t.targetTeamId === myTeamId && t.status === 'pending_admin')
  const history = showHistory
    ? trades.filter(t =>
        (t.proposingTeamId === myTeamId || t.targetTeamId === myTeamId) &&
        ['approved', 'rejected', 'cancelled'].includes(t.status))
    : []

  if (!showHistory && incoming.length + sent.length + awaitingAdmin.length === 0) return null

  async function act(url: string, body: object, key: string) {
    setLoading(key)
    setError('')
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    setLoading('')
    if (!res.ok) { setError(data.error ?? 'שגיאה'); return }
    router.refresh()
  }

  return (
    <div className="card">
      <h2 className="font-bold text-lg mb-3">🔄 {title}</h2>
      {error && <p className="text-sm mb-3" style={{ color: 'var(--danger)' }}>{error}</p>}

      <div className="flex flex-col gap-3">
        {incoming.length > 0 && (
          <Section label={`הצעות שקיבלת (${incoming.length})`}>
            {incoming.map(t => (
              <TradeCard key={t.id} trade={t} myTeamId={myTeamId}>
                <div className="flex flex-wrap gap-2 mt-3">
                  <button className="btn btn-primary" disabled={!!loading}
                    onClick={() => act('/api/trades/respond', { trade_id: t.id, action: 'accept' }, `a-${t.id}`)}>
                    {loading === `a-${t.id}` ? '...' : '✅ אשר'}
                  </button>
                  <button className="btn btn-outline" disabled={!!loading}
                    onClick={() => act('/api/trades/respond', { trade_id: t.id, action: 'reject' }, `r-${t.id}`)}>
                    {loading === `r-${t.id}` ? '...' : '❌ דחה'}
                  </button>
                </div>
              </TradeCard>
            ))}
          </Section>
        )}

        {awaitingAdmin.length > 0 && (
          <Section label="אישרת — ממתין למנהל הליגה">
            {awaitingAdmin.map(t => <TradeCard key={t.id} trade={t} myTeamId={myTeamId} />)}
          </Section>
        )}

        {sent.length > 0 && (
          <Section label="הצעות ששלחת">
            {sent.map(t => (
              <TradeCard key={t.id} trade={t} myTeamId={myTeamId}>
                <div className="flex flex-wrap items-center gap-2 mt-3">
                  <span className="badge badge-yellow text-xs">
                    {t.status === 'pending_target' ? 'ממתין לתשובה' : 'ממתין למנהל הליגה'}
                  </span>
                  <button className="btn btn-outline" disabled={!!loading}
                    onClick={() => act('/api/trades/cancel', { trade_id: t.id }, `c-${t.id}`)}>
                    {loading === `c-${t.id}` ? '...' : 'בטל הצעה'}
                  </button>
                </div>
              </TradeCard>
            ))}
          </Section>
        )}

        {showHistory && (
          <Section label="היסטוריה שלי">
            {history.length === 0 ? (
              <p className="text-sm" style={{ color: 'var(--muted)' }}>אין עדיין</p>
            ) : history.map(t => (
              <TradeCard key={t.id} trade={t} myTeamId={myTeamId}>
                <div className="mt-2 text-xs flex flex-wrap gap-2 items-center">
                  <StatusBadge status={t.status} />
                  {t.rejection_reason && <span style={{ color: 'var(--muted)' }}>{t.rejection_reason}</span>}
                </div>
              </TradeCard>
            ))}
          </Section>
        )}
      </div>
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-sm font-medium mb-2" style={{ color: 'var(--muted)' }}>{label}</p>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  )
}

export function StatusBadge({ status }: { status: string }) {
  if (status === 'approved') return <span className="badge badge-green text-xs">בוצע</span>
  if (status === 'rejected') return <span className="badge badge-red text-xs">נדחה</span>
  if (status === 'cancelled') return <span className="badge badge-gray text-xs">בוטל</span>
  return <span className="badge badge-yellow text-xs">ממתין</span>
}

function TradeCard({ trade, myTeamId, children }: { trade: AuctionTradeView; myTeamId: string; children?: React.ReactNode }) {
  const iAmProposer = trade.proposingTeamId === myTeamId
  const otherId = iAmProposer ? trade.targetTeamId : trade.proposingTeamId
  const otherName = iAmProposer ? trade.targetName : trade.proposingName

  return (
    <div className="rounded-lg p-3" style={{ background: 'var(--background)', border: '1px solid var(--border)' }}>
      <p className="text-sm font-medium mb-2">{iAmProposer ? 'אל' : 'מאת'} {otherName}</p>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <AssetList label="אתה נותן" color="var(--danger)" items={sideSummary(trade, myTeamId)} />
        <AssetList label="אתה מקבל" color="var(--success)" items={sideSummary(trade, otherId)} />
      </div>
      {trade.note && <p className="text-xs mt-2" style={{ color: 'var(--muted)' }}>💬 {trade.note}</p>}
      {children}
    </div>
  )
}

function AssetList({ label, color, items }: { label: string; color: string; items: string[] }) {
  return (
    <div className="min-w-0">
      <p className="text-xs mb-1" style={{ color }}>{label}</p>
      {items.length === 0
        ? <p className="text-xs" style={{ color: 'var(--muted)' }}>—</p>
        : items.map((s, i) => <p key={i} className="truncate" dir="ltr" style={{ textAlign: 'right' }}>{s}</p>)}
    </div>
  )
}
