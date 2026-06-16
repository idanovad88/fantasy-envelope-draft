'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

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
  canPick: boolean
  pickingTeamId?: string
}

export default function SnakePlayerPicker({ players, leagueId, canPick, pickingTeamId }: Props) {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState('')
  const router = useRouter()

  const filtered = query.trim()
    ? players.filter(p => p.name.toLowerCase().includes(query.trim().toLowerCase()))
    : players

  async function handlePick(playerId: string) {
    setLoading(playerId)
    setError('')
    const res = await fetch('/api/snake-pick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        league_id: leagueId,
        player_id: playerId,
        ...(pickingTeamId ? { team_id: pickingTeamId } : {}),
      }),
    })
    const data = await res.json()
    setLoading(null)
    if (!res.ok) {
      setError(data.error ?? 'שגיאה בבחירה')
      return
    }
    router.refresh()
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-1 gap-3">
        <h2 className="font-bold whitespace-nowrap">שחקנים זמינים ({players.length})</h2>
        <input
          className="input text-sm flex-1 max-w-48"
          placeholder="חיפוש שחקן..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          dir="ltr"
        />
      </div>

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
              {filtered.map((p, i) => (
                <tr key={p.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="py-2 pr-2" style={{ color: 'var(--muted)' }}>{p.ranking ?? i + 1}</td>
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
                        className="btn btn-primary"
                        style={{ fontSize: '0.75rem', padding: '4px 12px' }}
                        disabled={loading === p.id}
                        onClick={() => handlePick(p.id)}
                      >
                        {loading === p.id ? '...' : 'בחר'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
