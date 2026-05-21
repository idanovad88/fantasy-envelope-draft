'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      router.push('/')
      router.refresh()
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: 'var(--background)' }}>
      <div className="card w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="text-4xl mb-3">🏀</div>
          <h1 className="text-2xl font-bold">פנטזי דראפט מעטפות</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>NBA Auction Draft</p>
        </div>

        <form onSubmit={handleLogin} className="flex flex-col gap-4">
          <div>
            <label className="block text-sm font-medium mb-1.5">אימייל</label>
            <input
              type="email"
              className="input"
              placeholder="you@example.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              dir="ltr"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5">סיסמה</label>
            <input
              type="password"
              className="input"
              placeholder="••••••••"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              dir="ltr"
            />
          </div>

          {error && (
            <div className="text-sm p-3 rounded-lg badge-red" style={{ background: 'rgba(239,68,68,0.1)' }}>
              {error}
            </div>
          )}

          <button type="submit" className="btn btn-primary w-full mt-2" disabled={loading}>
            {loading ? 'מתחבר...' : 'כניסה'}
          </button>
        </form>
      </div>
    </div>
  )
}
