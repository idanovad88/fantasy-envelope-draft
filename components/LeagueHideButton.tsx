'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function LeagueHideButton({ leagueId, hidden }: { leagueId: string; hidden: boolean }) {
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function toggle() {
    setLoading(true)
    await fetch('/api/leagues/hide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leagueId, hidden: !hidden }),
    })
    router.refresh()
    setLoading(false)
  }

  return (
    <button onClick={toggle} disabled={loading} className="btn btn-outline text-sm">
      {loading ? '...' : hidden ? 'הצג' : 'הסתר'}
    </button>
  )
}
