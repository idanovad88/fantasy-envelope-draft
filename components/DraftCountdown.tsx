'use client'

import { useState, useEffect } from 'react'

function getFullCountdown(targetDate: string) {
  const diff = new Date(targetDate).getTime() - Date.now()
  if (diff <= 0) return null
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
  const seconds = Math.floor((diff % (1000 * 60)) / 1000)
  return { days, hours, minutes, seconds }
}

export default function DraftCountdown({ targetDate }: { targetDate: string }) {
  const [cd, setCd] = useState(getFullCountdown(targetDate))

  useEffect(() => {
    const timer = setInterval(() => setCd(getFullCountdown(targetDate)), 1000)
    return () => clearInterval(timer)
  }, [targetDate])

  if (!cd) return (
    <div className="card mt-4 text-center" style={{ borderColor: 'var(--success)' }}>
      <p className="font-bold text-lg" style={{ color: 'var(--success)' }}>הדראפט התחיל!</p>
    </div>
  )

  const units = [
    { value: cd.days, label: 'ימים' },
    { value: cd.hours, label: 'שעות' },
    { value: cd.minutes, label: 'דקות' },
    { value: cd.seconds, label: 'שניות' },
  ]

  return (
    <div className="card mt-4" style={{ borderColor: 'var(--primary)' }}>
      <p className="text-sm font-bold text-center mb-4" style={{ color: 'var(--primary)' }}>
        הדראפט מתחיל בעוד
      </p>
      <div className="flex justify-center gap-3" dir="ltr">
        {units.map(({ value, label }) => (
          <div key={label} className="text-center">
            <div className="rounded-xl px-4 py-3" style={{ background: 'var(--background)', minWidth: 60 }}>
              <span className="text-3xl font-bold tabular-nums" style={{ color: 'var(--primary)' }}>
                {String(value).padStart(2, '0')}
              </span>
            </div>
            <p className="text-xs mt-1.5" style={{ color: 'var(--muted)' }}>{label}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
