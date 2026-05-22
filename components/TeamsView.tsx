'use client'

import { useState } from 'react'
import type { Team, Player } from '@/types'

interface Props {
  teams: Team[]
  playersByTeam: Record<string, Player[]>
  myUserId: string | null
  budgetPerTeam: number
  playersPerTeam: number
}

export default function TeamsView({ teams, playersByTeam, myUserId, budgetPerTeam, playersPerTeam }: Props) {
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null)

  const visibleTeams = selectedTeamId ? teams.filter(t => t.id === selectedTeamId) : teams

  return (
    <>
      {/* Team selector */}
      <div className="flex flex-wrap gap-2 mb-6">
        <button
          className="px-3 py-1.5 rounded-full text-sm font-medium transition-all"
          style={!selectedTeamId
            ? { background: 'var(--primary)', color: 'white' }
            : { background: 'var(--card)', color: 'var(--muted)', border: '1px solid var(--border)' }
          }
          onClick={() => setSelectedTeamId(null)}
        >
          הכל
        </button>
        {teams.map(team => {
          const isSelected = selectedTeamId === team.id
          const isMyTeam = team.user_id === myUserId
          return (
            <button
              key={team.id}
              className="px-3 py-1.5 rounded-full text-sm font-medium transition-all"
              style={isSelected
                ? { background: 'var(--primary)', color: 'white' }
                : isMyTeam
                  ? { background: 'var(--card)', color: 'var(--primary)', border: '2px solid var(--primary)' }
                  : { background: 'var(--card)', color: 'var(--text)', border: '1px solid var(--border)' }
              }
              onClick={() => setSelectedTeamId(isSelected ? null : team.id)}
            >
              {team.name}
            </button>
          )
        })}
      </div>

      {/* Team cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {visibleTeams.map(team => {
          const roster = playersByTeam[team.id] || []
          const isMyTeam = team.user_id === myUserId

          return (
            <div
              key={team.id}
              className="card"
              style={isMyTeam ? { borderColor: 'var(--primary)', borderWidth: 2 } : {}}
            >
              {/* Header */}
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="font-bold text-lg">{team.name}</h2>
                    {isMyTeam && <span className="badge badge-blue text-xs">אתה</span>}
                    {team.is_complete && <span className="badge badge-green text-xs">✅ שלם</span>}
                    {!team.approved && <span className="badge badge-yellow text-xs">ממתין לאישור</span>}
                  </div>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
                    פריוריטי: {team.priority_rank ?? (team.is_complete ? 'הסתיים' : '—')}
                  </p>
                </div>
                <div className="text-left">
                  <p className="font-bold text-xl" style={{ color: team.budget_remaining < 20 ? 'var(--danger)' : 'var(--success)' }}>
                    ${team.budget_remaining}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--muted)' }}>
                    {team.player_count}/{playersPerTeam} שחקנים
                  </p>
                </div>
              </div>

              {/* Budget bar */}
              <div className="w-full h-1.5 rounded-full mb-3" style={{ background: 'var(--border)' }}>
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${(team.budget_remaining / budgetPerTeam) * 100}%`,
                    background: team.budget_remaining < 20 ? 'var(--danger)' : 'var(--success)',
                  }}
                />
              </div>

              {/* Roster */}
              {roster.length > 0 ? (
                <div className="flex flex-col gap-1">
                  {roster.map(p => (
                    <div key={p.id} className="flex items-center justify-between text-sm py-1.5 px-2 rounded" style={{ background: 'var(--background)' }}>
                      <div className="flex items-center gap-2">
                        {p.position && (
                          <span className="badge badge-blue text-xs w-8 text-center">{p.position}</span>
                        )}
                        <span className="font-medium" dir="ltr">{p.name}</span>
                      </div>
                      <span className="font-bold" style={{ color: 'var(--warning)' }}>${p.draft_price}</span>
                    </div>
                  ))}
                  {Array.from({ length: playersPerTeam - roster.length }).map((_, i) => (
                    <div key={i} className="flex items-center justify-between text-sm py-1 px-2 rounded" style={{ background: 'var(--background)', opacity: 0.3 }}>
                      <span style={{ color: 'var(--muted)' }}>— ריק —</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-center py-4" style={{ color: 'var(--muted)' }}>
                  אין שחקנים עדיין
                </p>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}
