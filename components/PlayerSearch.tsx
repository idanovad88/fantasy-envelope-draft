'use client'

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
}

export default function PlayerSearch({ players }: Props) {
  const { query, setQuery, position, setPosition, sortKey, setSortKey, positions, filtered } =
    usePlayerFilter(players)

  return (
    <div className="card">
      <PlayerFilterBar
        title="שחקנים זמינים"
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

      {filtered.length === 0 ? (
        <p className="text-sm text-center py-4" style={{ color: 'var(--muted)' }}>לא נמצאו שחקנים</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
                <th className="text-right pb-2 pr-2 w-8">#</th>
                <th className="text-right pb-2">שחקן</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(p => (
                <tr key={p.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="py-2 pr-2" style={{ color: 'var(--muted)' }}>{p.ranking ?? '—'}</td>
                  <td className="py-2">
                    <div className="flex items-center gap-2" dir="ltr">
                      {p.position && (
                        <span style={{ background: 'rgba(99,102,241,0.2)', color: 'var(--primary)', fontSize: '11px', padding: '1px 5px', borderRadius: '4px', flexShrink: 0, minWidth: 28, textAlign: 'center' }}>
                          {p.position}
                        </span>
                      )}
                      <span className="font-medium">{p.name}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
