'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export default function AcceptInvite({ token, isLoggedIn }: { token: string; isLoggedIn: boolean }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleLogin() {
    setLoading(true)
    setError('')
    const supabase = createClient()
    const next = `/assist/${token}`
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}` },
    })
    if (error) {
      setError(error.message)
      setLoading(false)
    }
  }

  async function handleAccept() {
    setLoading(true)
    setError('')
    const res = await fetch('/api/team/accept-invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    const json = await res.json()
    if (!res.ok) {
      setError(json.error ?? 'שגיאה')
      setLoading(false)
      return
    }
    window.location.href = '/'
  }

  return (
    <div className="flex flex-col gap-3">
      {isLoggedIn ? (
        <button className="btn btn-primary w-full" onClick={handleAccept} disabled={loading}>
          {loading ? 'מצרף...' : 'אשר הצטרפות כעוזר'}
        </button>
      ) : (
        <button className="btn btn-primary w-full" onClick={handleLogin} disabled={loading} style={{ gap: '0.5rem' }}>
          {loading ? 'מתחבר...' : 'כנס עם Google כדי לאשר'}
        </button>
      )}
      {error && <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>}
    </div>
  )
}
