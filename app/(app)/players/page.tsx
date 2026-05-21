import { createClient } from '@/lib/supabase/server'
import type { Player } from '@/types'

export const dynamic = 'force-dynamic'

export default async function PlayersPage() {
  const supabase = await createClient()

  const { data: players } = await supabase
    .from('players')
    .select('*')
    .order('ranking', { ascending: true, nullsFirst: false })

  const typedPlayers = (players || []) as Player[]
  const available = typedPlayers.filter(p => p.status === 'available')
  const onAuction = typedPlayers.filter(p => p.status === 'on_auction')
  const drafted = typedPlayers.filter(p => p.status === 'drafted')

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">שחקנים</h1>
        <div className="flex gap-2 text-sm">
          <span className="badge badge-green">{available.length} זמינים</span>
          {onAuction.length > 0 && <span className="badge badge-yellow">{onAuction.length} במכרז</span>}
          <span className="badge badge-gray">{drafted.length} נרכשו</span>
        </div>
      </div>

      {/* On auction highlight */}
      {onAuction.map(p => (
        <div key={p.id} className="card mb-4" style={{ borderColor: 'var(--warning)', borderWidth: 2 }}>
          <span className="badge badge-yellow mb-2">🔴 במכרז עכשיו</span>
          <p className="font-bold text-xl">{p.name}</p>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>{p.position} · {p.nba_team}</p>
        </div>
      ))}

      {/* Available players table */}
      <div className="card">
        <h2 className="font-bold mb-3">שחקנים זמינים ({available.length})</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
                <th className="text-right pb-2 pr-2">#</th>
                <th className="text-right pb-2">שחקן</th>
                <th className="text-right pb-2">עמדה</th>
                <th className="text-right pb-2">קבוצה</th>
                <th className="text-right pb-2">ערך $</th>
                <th className="text-right pb-2">נקודות</th>
                <th className="text-right pb-2">ריבאונד</th>
                <th className="text-right pb-2">בישולים</th>
              </tr>
            </thead>
            <tbody>
              {available.map((p, i) => (
                <tr key={p.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="py-2 pr-2" style={{ color: 'var(--muted)' }}>{p.ranking ?? i + 1}</td>
                  <td className="py-2 font-medium">{p.name}</td>
                  <td className="py-2">{p.position ?? '—'}</td>
                  <td className="py-2" style={{ color: 'var(--muted)' }}>{p.nba_team ?? '—'}</td>
                  <td className="py-2 font-bold" style={{ color: 'var(--warning)' }}>
                    {p.auction_value ? `$${p.auction_value}` : '—'}
                  </td>
                  <td className="py-2">{(p.stats as { ppg?: number })?.ppg ?? '—'}</td>
                  <td className="py-2">{(p.stats as { rpg?: number })?.rpg ?? '—'}</td>
                  <td className="py-2">{(p.stats as { apg?: number })?.apg ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Drafted players */}
      {drafted.length > 0 && (
        <div className="card mt-4">
          <h2 className="font-bold mb-3" style={{ color: 'var(--muted)' }}>נרכשו ({drafted.length})</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
                  <th className="text-right pb-2">שחקן</th>
                  <th className="text-right pb-2">עמדה</th>
                  <th className="text-right pb-2">מחיר</th>
                </tr>
              </thead>
              <tbody>
                {drafted.map(p => (
                  <tr key={p.id} className="border-t opacity-50" style={{ borderColor: 'var(--border)' }}>
                    <td className="py-2 font-medium line-through">{p.name}</td>
                    <td className="py-2">{p.position ?? '—'}</td>
                    <td className="py-2 font-bold" style={{ color: 'var(--danger)' }}>${p.draft_price}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
