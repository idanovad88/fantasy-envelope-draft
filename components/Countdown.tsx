'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { getCountdown } from '@/lib/utils'

export default function Countdown({ targetDate, label }: { targetDate: string; label: string }) {
  const [cd, setCd] = useState(getCountdown(targetDate))
  const router = useRouter()
  const refreshedRef = useRef(false)

  useEffect(() => {
    refreshedRef.current = false
    const timer = setInterval(() => {
      const newCd = getCountdown(targetDate)
      setCd(newCd)
      if (!newCd && !refreshedRef.current) {
        refreshedRef.current = true
        router.refresh()
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [targetDate, router])

  if (!cd) return <span className="badge badge-red">הסתיים</span>

  const isUrgent = cd.total < 120_000

  return (
    <div className={`flex items-center gap-1 text-center${isUrgent ? ' pulse-glow-danger' : ''}`} style={{ borderRadius: '8px', padding: isUrgent ? '4px 8px' : '0' }}>
      <p className="text-xs mb-2" style={{ color: isUrgent ? 'var(--danger)' : 'var(--muted)' }}>{label}</p>
      <div className="flex gap-2">
        {cd.hours > 0 && (
          <div className="countdown-digit">
            <span className="text-2xl font-bold tabular-nums" style={{ color: isUrgent ? 'var(--danger)' : undefined }}>
              {String(cd.hours).padStart(2, '0')}
            </span>
            <span className="text-xs" style={{ color: isUrgent ? 'var(--danger)' : 'var(--muted)' }}>ש</span>
          </div>
        )}
        <div className="countdown-digit">
          <span className="text-2xl font-bold tabular-nums" style={{ color: isUrgent ? 'var(--danger)' : undefined }}>
            {String(cd.minutes).padStart(2, '0')}
          </span>
          <span className="text-xs" style={{ color: isUrgent ? 'var(--danger)' : 'var(--muted)' }}>ד</span>
        </div>
        <div className="countdown-digit">
          <span className="text-2xl font-bold tabular-nums" style={{ color: isUrgent ? 'var(--danger)' : undefined }}>
            {String(cd.seconds).padStart(2, '0')}
          </span>
          <span className="text-xs" style={{ color: isUrgent ? 'var(--danger)' : 'var(--muted)' }}>ש</span>
        </div>
      </div>
    </div>
  )
}
