'use client'

import { useState } from 'react'
import NominateButton from '@/components/NominateButton'

type Player = {
  id: string
  name: string
  position: string | null
  nba_team: string | null
  ranking: number | null
}

interface Props {
  players: Player[]
  canNominate: boolean
  leagueId: string | null
  teamId: string | null
  budgetRemaining: number
  playerCount: number
  playersPerTeam: number
  maxBid: number
}

export default function PlayerSearch({ players, canNominate, leagueId, teamId, budgetRemaining, playerCount, playersPerTeam, maxBid }: Props) {
  const [query, setQuery] = useState('')

  const filtered = query.trim()
    ? players.filter(p => p.name.toLowerCase().includes(query.trim().toLowerCase()))
    : players

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3 gap-3">
        <h2 className="font-bold whitespace-nowrap">שחקנים זמינים ({players.length})</h2>
        <input
          className="input text-sm flex-1 max-w-48"
          placeholder="חיפוש שחקן..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          dir="ltr"
        />
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-center py-4" style={{ color: 'var(--muted)' }}>לא נמצאו שחקנים</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
                <th className="text-right pb-2 pr-2 w-8">#</th>
                <th className="text-right pb-2">שחקן</th>
                <th className="pb-2 w-10"></th>
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
                    </div>
                  </td>
                  <td className="py-1 pl-1">
                    {canNominate && leagueId && teamId ? (
                      <NominateButton
                        playerId={p.id}
                        leagueId={leagueId}
                        playerName={p.name}
                        maxBid={maxBid}
                      />
                    ) : null}
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
