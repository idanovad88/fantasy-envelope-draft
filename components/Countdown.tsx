'use client'

import { useState, useEffect } from 'react'
import { getCountdown } from '@/lib/utils'

export default function Countdown({ targetDate, label }: { targetDate: string; label: string }) {
  const [cd, setCd] = useState(getCountdown(targetDate))

  useEffect(() => {
    const timer = setInterval(() => setCd(getCountdown(targetDate)), 1000)
    return () => clearInterval(timer)
  }, [targetDate])

  if (!cd) return <span className="badge badge-red">הסתיים</span>

  return (
    <div className="flex items-center gap-1 text-center">
      <p className="text-xs mb-2" style={{ color: 'var(--muted)' }}>{label}</p>
      <div className="flex gap-2">
        {cd.hours > 0 && (
          <div className="countdown-digit">
            <span className="text-2xl font-bold tabular-nums">{String(cd.hours).padStart(2, '0')}</span>
            <span className="text-xs" style={{ color: 'var(--muted)' }}>ש</span>
          </div>
        )}
        <div className="countdown-digit">
          <span className="text-2xl font-bold tabular-nums">{String(cd.minutes).padStart(2, '0')}</span>
          <span className="text-xs" style={{ color: 'var(--muted)' }}>ד</span>
        </div>
        <div className="countdown-digit">
          <span className="text-2xl font-bold tabular-nums">{String(cd.seconds).padStart(2, '0')}</span>
          <span className="text-xs" style={{ color: 'var(--muted)' }}>ש</span>
        </div>
      </div>
    </div>
  )
}
