import { type ClassValue, clsx } from 'clsx'

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
