'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Props {
  playerId: string
  leagueId: string
  playerName: string
}

export default function NominateButton({ playerId, leagueId, playerName }: Props) {
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function nominate() {
    if (!confirm(`להעלות את ${playerName} למכרז ב-$1?`)) return
    setLoading(true)
    const res = await fetch('/api/nominate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player_id: playerId, league_id: leagueId }),
    })
    const data = await res.json()
    if (data.error) {
      alert(data.error)
    } else {
      router.refresh()
    }
    setLoading(false)
  }

  return (
    <button
      onClick={nominate}
      disabled={loading}
      className="btn btn-primary font-bold"
      style={{ padding: '2px 10px', fontSize: '18px', lineHeight: 1 }}
      title={`העלה את ${playerName} למכרז`}
    >
      {loading ? '…' : '+'}
    </button>
  )
}
