import { type ClassValue, clsx } from 'clsx'
import type { Team } from '@/types'

export function cn(...inputs: ClassValue[]) {
  return inputs.filter(Boolean).join(' ')
}

export function formatCurrency(amount: number) {
  return `$${amount}`
}

export function formatTime(dateStr: string) {
  return new Date(dateStr).toLocaleTimeString('he-IL', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Jerusalem',
  })
}

export function formatDateTime(dateStr: string) {
  return new Date(dateStr).toLocaleString('he-IL', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Jerusalem',
  })
}

export function getMaxBid(budgetRemaining: number, playerCount: number, playersPerTeam: number) {
  const remainingSlots = playersPerTeam - playerCount
  if (remainingSlots <= 0) return 0
  // Must keep $1 for each remaining slot after this one
  return budgetRemaining - (remainingSlots - 1)
}

export function getNextNominationTimes(startHour: number, endHour: number, intervalHours: number) {
  const now = new Date()
  const israelNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }))
  const slots: Date[] = []

  const today = new Date(israelNow)
  today.setHours(startHour, 0, 0, 0)

  while (today.getHours() < endHour) {
    slots.push(new Date(today))
    today.setHours(today.getHours() + intervalHours)
  }

  return slots
}

// Snake draft helpers

export function isSnakeRoundReversed(round: number, config: boolean[] | null): boolean {
  if (config === null || config[round - 1] === undefined) return round % 2 === 0
  return config[round - 1]
}

export function getSnakeTeamForPick(
  overallPickNumber: number,
  numTeams: number,
  teams: Team[],
  snakeRoundConfig: boolean[] | null
): Team | null {
  if (teams.length === 0) return null
  const round = Math.ceil(overallPickNumber / numTeams)
  const posInRound = (overallPickNumber - 1) % numTeams
  const reversed = isSnakeRoundReversed(round, snakeRoundConfig)
  const rankIndex = reversed ? (numTeams - 1 - posInRound) : posInRound
  return teams[rankIndex] ?? null
}

// Trade overrides: a map of overall_pick_number → owning team id. When a pick is
// traded its computed owner is overridden. Base order (priority_rank /
// snake_round_config) is never mutated.

export function buildPickOverridesMap(
  rows: { overall_pick_number: number; owner_team_id: string }[] | null | undefined
): Map<number, string> {
  const map = new Map<number, string>()
  for (const r of rows ?? []) map.set(r.overall_pick_number, r.owner_team_id)
  return map
}

export function resolvePickOwner(
  overallPickNumber: number,
  numTeams: number,
  teams: Team[],
  snakeRoundConfig: boolean[] | null,
  overrides?: Map<number, string> | null
): Team | null {
  const overrideTeamId = overrides?.get(overallPickNumber)
  if (overrideTeamId) {
    const t = teams.find(team => team.id === overrideTeamId)
    if (t) return t
  }
  return getSnakeTeamForPick(overallPickNumber, numTeams, teams, snakeRoundConfig)
}

export function getCurrentSnakePicker(
  completedPicksCount: number,
  numTeams: number,
  teams: Team[],
  snakeRoundConfig: boolean[] | null,
  overrides?: Map<number, string> | null
): Team | null {
  return resolvePickOwner(completedPicksCount + 1, numTeams, teams, snakeRoundConfig, overrides)
}

// Future picks currently owned by a team — used to show what a team can offer in
// a trade. Picks that are already made (or on the clock, while the draft is
// active) are not tradeable.
export function getFuturePickNumbersForTeam(
  teamId: string,
  completedCount: number,
  totalPicks: number,
  numTeams: number,
  teams: Team[],
  snakeRoundConfig: boolean[] | null,
  overrides?: Map<number, string> | null,
  isActive = true
): number[] {
  const firstTradeable = isActive ? completedCount + 2 : completedCount + 1
  const result: number[] = []
  for (let n = firstTradeable; n <= totalPicks; n++) {
    const owner = resolvePickOwner(n, numTeams, teams, snakeRoundConfig, overrides)
    if (owner?.id === teamId) result.push(n)
  }
  return result
}

// Round/pick-in-round breakdown for a given overall pick number (display helper).
export function describePick(overallPickNumber: number, numTeams: number): { round: number; pickInRound: number } {
  return {
    round: Math.ceil(overallPickNumber / numTeams),
    pickInRound: ((overallPickNumber - 1) % numTeams) + 1,
  }
}

export function formatTimeSince(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return `${hours} שעות ו-${minutes % 60} דקות`
  if (minutes > 0) return `${minutes} דקות`
  return 'כרגע'
}

export function getCountdown(targetDate: string) {
  const now = Date.now()
  const target = new Date(targetDate).getTime()
  const diff = target - now

  if (diff <= 0) return null

  const hours = Math.floor(diff / (1000 * 60 * 60))
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
  const seconds = Math.floor((diff % (1000 * 60)) / 1000)

  return { hours, minutes, seconds, total: diff }
}
