'use client'

import { useState } from 'react'

export default function LeagueSelectButton({ leagueId }: { leagueId: string }) {
  const [loading, setLoading] = useState(false)

  async function enter() {
    setLoading(true)
    await fetch('/api/select-league', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leagueId }),
    })
    window.location.href = '/'
  }

  return (
    <button onClick={enter} disabled={loading} className="btn btn-primary text-sm">
      {loading ? '...' : 'כנס לליגה'}
    </button>
  )
}
