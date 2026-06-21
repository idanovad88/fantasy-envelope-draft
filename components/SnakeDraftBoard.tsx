'use client'

import type { Team, SnakePick } from '@/types'
import { isSnakeRoundReversed } from '@/lib/utils'

interface Props {
  teams: Team[]
  snakePicks: (SnakePick & { player: { name: string; position: string | null } | null })[]
  numTeams: number
  playersPerTeam: number
  snakeRoundConfig: boolean[] | null
  currentPickNumber: number
  myTeamId?: string | null
  /** overall_pick_number → owning team id, for traded picks */
  overrides?: Record<number, string> | null
}

export default function SnakeDraftBoard({
  teams,
  snakePicks,
  numTeams,
  playersPerTeam,
  snakeRoundConfig,
  currentPickNumber,
  myTeamId,
  overrides,
}: Props) {
  // Map by overall pick number (NOT round+team): after a trade a team can hold
  // two picks in one round, so a round+team key would collide.
  const pickMap = new Map<number, typeof snakePicks[0]>()
  for (const pick of snakePicks) {
    pickMap.set(pick.overall_pick_number, pick)
  }

  const teamNameById = new Map(teams.map(t => [t.id, t.name]))

  // Header columns are teams in priority_rank (seat) order.
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
                  const pickNumberForThisCell = getPickNumberForCell(round, team, sortedTeams, numTeams, snakeRoundConfig)
                  const pick = pickMap.get(pickNumberForThisCell)
                  const isCurrentPick = pickNumberForThisCell === currentPickNumber
                  const isUpcoming = pickNumberForThisCell > currentPickNumber
                  const isMyTeam = team.id === myTeamId

                  // The seat's default owner is this column's team; an override
                  // means the pick was traded to another team.
                  const overrideOwnerId = overrides?.[pickNumberForThisCell]
                  const isTraded = !!overrideOwnerId && overrideOwnerId !== team.id
                  const tradedToName = isTraded ? (teamNameById.get(overrideOwnerId!) ?? '—') : null

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
                          {isTraded && (
                            <div style={{ color: 'var(--primary)', fontSize: '0.62rem', fontWeight: 600 }}>נסחר ← {tradedToName}</div>
                          )}
                        </div>
                      ) : isCurrentPick ? (
                        <span style={{ color: isMyTeam ? 'white' : 'var(--text)', fontWeight: 600, fontSize: '0.75rem' }}>
                          על הדק #{pickNumberForThisCell}
                          {isTraded && <div style={{ fontSize: '0.62rem' }}>נסחר ← {tradedToName}</div>}
                        </span>
                      ) : isUpcoming ? (
                        <span style={{ color: 'var(--border)', fontSize: '0.7rem' }}>
                          #{pickNumberForThisCell}
                          {isTraded && (
                            <div style={{ color: 'var(--primary)', fontSize: '0.62rem', fontWeight: 600 }}>← {tradedToName}</div>
                          )}
                        </span>
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
