'use client'

import type { Team, SnakePick } from '@/types'
import { isSnakeRoundReversed, getSnakeTeamForPick } from '@/lib/utils'

interface Props {
  teams: Team[]
  snakePicks: (SnakePick & { player: { name: string; position: string | null } | null })[]
  numTeams: number
  playersPerTeam: number
  snakeRoundConfig: boolean[] | null
  currentPickNumber: number
  myTeamId?: string | null
}

export default function SnakeDraftBoard({
  teams,
  snakePicks,
  numTeams,
  playersPerTeam,
  snakeRoundConfig,
  currentPickNumber,
  myTeamId,
}: Props) {
  // Map from "round-teamId" to pick
  const pickMap = new Map<string, typeof snakePicks[0]>()
  for (const pick of snakePicks) {
    pickMap.set(`${pick.round}-${pick.team_id}`, pick)
  }

  // Map from overall pick number → team (for header order)
  // Header columns are teams in priority_rank order
  const sortedTeams = [...teams].sort((a, b) => (a.priority_rank ?? 999) - (b.priority_rank ?? 999))

  return (
    <div className="overflow-x-auto">
      <table style={{ borderCollapse: 'collapse', minWidth: '100%', fontSize: '0.8rem' }}>
        <thead>
          <tr>
            <th
              style={{
                padding: '6px 8px',
                background: 'var(--muted)',
                color: 'white',
                textAlign: 'center',
                whiteSpace: 'nowrap',
                position: 'sticky',
                right: 0,
                zIndex: 1,
              }}
            >
              סיבוב
            </th>
            {sortedTeams.map(team => (
              <th
                key={team.id}
                style={{
                  padding: '6px 10px',
                  background: team.id === myTeamId ? 'var(--primary)' : 'var(--muted)',
                  color: 'white',
                  textAlign: 'center',
                  whiteSpace: 'nowrap',
                  minWidth: '100px',
                }}
              >
                {team.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: playersPerTeam }, (_, roundIdx) => {
            const round = roundIdx + 1
            const reversed = isSnakeRoundReversed(round, snakeRoundConfig)
            const firstPickInRound = (round - 1) * numTeams + 1
            const lastPickInRound = round * numTeams

            return (
              <tr key={round} style={{ borderBottom: '1px solid var(--border)' }}>
                <td
                  style={{
                    padding: '6px 8px',
                    textAlign: 'center',
                    whiteSpace: 'nowrap',
                    background: 'var(--background, #fff)',
                    position: 'sticky',
                    right: 0,
                    borderLeft: '1px solid var(--border)',
                  }}
                >
                  <span style={{ color: 'var(--muted)', fontSize: '0.75rem' }}>
                    {round} {reversed ? '←' : '→'}
                  </span>
                </td>
                {sortedTeams.map(team => {
                  const pick = pickMap.get(`${round}-${team.id}`)
                  const pickNumberForThisCell = getPickNumberForCell(round, team, sortedTeams, numTeams, snakeRoundConfig)
                  const isCurrentPick = pickNumberForThisCell === currentPickNumber
                  const isUpcoming = pickNumberForThisCell > currentPickNumber
                  const isMyTeam = team.id === myTeamId

                  return (
                    <td
                      key={team.id}
                      style={{
                        padding: '6px 10px',
                        textAlign: 'center',
                        background: isCurrentPick
                          ? isMyTeam ? 'var(--primary)' : 'var(--warning)'
                          : isUpcoming
                          ? 'transparent'
                          : pick
                          ? isMyTeam ? 'rgba(var(--primary-rgb, 59,130,246), 0.08)' : 'transparent'
                          : 'transparent',
                        borderLeft: '1px solid var(--border)',
                        minWidth: '100px',
                      }}
                    >
                      {pick ? (
                        <div>
                          <div style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '120px' }}>
                            {pick.player?.name ?? '—'}
                          </div>
                          {pick.player?.position && (
                            <div style={{ color: 'var(--muted)', fontSize: '0.7rem' }}>{pick.player.position}</div>
                          )}
                          <div style={{ color: 'var(--muted)', fontSize: '0.65rem' }}>#{pick.overall_pick_number}</div>
                        </div>
                      ) : isCurrentPick ? (
                        <span style={{ color: isMyTeam ? 'white' : 'var(--text)', fontWeight: 600, fontSize: '0.75rem' }}>
                          על הדק #{pickNumberForThisCell}
                        </span>
                      ) : isUpcoming ? (
                        <span style={{ color: 'var(--border)', fontSize: '0.7rem' }}>#{pickNumberForThisCell}</span>
                      ) : (
                        <span style={{ color: 'var(--muted)' }}>—</span>
                      )}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function getPickNumberForCell(
  round: number,
  team: Team,
  sortedTeams: Team[],
  numTeams: number,
  snakeRoundConfig: boolean[] | null
): number {
  const teamIndex = sortedTeams.findIndex(t => t.id === team.id)
  const reversed = isSnakeRoundReversed(round, snakeRoundConfig)
  const posInRound = reversed ? (numTeams - 1 - teamIndex) : teamIndex
  return (round - 1) * numTeams + posInRound + 1
}
