'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import { Eye, EyeOff } from 'lucide-react'

export default function LandingPage() {
  const [createMode, setCreateMode] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const supabase = createClient()
  const router = useRouter()

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) router.replace('/leagues')
    })
  }, [])

  async function handleGoogleSignIn() {
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    })
    if (error) {
      setError(error.message)
      setLoading(false)
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const { data: signInData, error: authErr } = await supabase.auth.signInWithPassword({ email, password })
    if (authErr || !signInData?.user) {
      setError('אימייל או סיסמה שגויים')
      setLoading(false)
      return
    }

    const { data: whitelistRow } = await supabase
      .from('league_creator_whitelist')
      .select('email')
      .eq('email', signInData.user.email)
      .maybeSingle()

    if (!whitelistRow) {
      setError('אין לך הרשאה להקים ליגה — פנה למנהל המערכת')
      await supabase.auth.signOut()
      setLoading(false)
      return
    }

    router.push('/create-league')
    router.refresh()
  }

  // ── Create league (admin) screen ────────────────────────────
  if (createMode) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4" style={{ background: 'var(--background)' }}>
        <div className="card w-full max-w-sm">
          <div className="text-center mb-6">
            <div className="text-3xl mb-2">🏀</div>
            <h1 className="text-xl font-bold">הקמת ליגה חדשה</h1>
          </div>
          <form onSubmit={handleCreate} className="flex flex-col gap-4">
            <div>
              <label className="block text-sm font-medium mb-1.5">אימייל</label>
              <input
                className="input"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                dir="ltr"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">סיסמה</label>
              <div className="relative">
                <input
                  className="input"
                  style={{ paddingLeft: '2rem' }}
                  type={showPassword ? 'text' : 'password'}
                  placeholder="••••••••"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  dir="ltr"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(p => !p)}
                  style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            {error && <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>}
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'נכנס...' : 'כניסה'}
            </button>
            <button
              type="button"
              className="text-sm text-center"
              style={{ color: 'var(--muted)' }}
              onClick={() => { setCreateMode(false); setError('') }}
            >
              ← חזרה
            </button>
          </form>
        </div>
      </div>
    )
  }

  // ── Landing screen ───────────────────────────────────────────
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center gap-8 px-4"
      style={{ background: 'var(--background)' }}
    >
      <div className="text-center">
        <div className="text-6xl mb-4">🏀</div>
        <h1 className="text-3xl font-bold">פנטזי דראפט מעטפות</h1>
        <p className="mt-2 text-lg" style={{ color: 'var(--muted)' }}>NBA Auction Draft</p>
      </div>

      <div className="flex flex-col gap-3 w-full max-w-xs">
        <button
          className="btn btn-primary text-lg py-4"
          onClick={handleGoogleSignIn}
          disabled={loading}
          style={{ gap: '0.75rem' }}
        >
          <svg width="20" height="20" viewBox="0 0 48 48" style={{ flexShrink: 0 }}>
            <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 7.9 3l5.7-5.7C34 6.5 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.9z"/>
            <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 16.1 19 13 24 13c3.1 0 5.8 1.1 7.9 3l5.7-5.7C34 6.5 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
            <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.3 35.2 26.8 36 24 36c-5.2 0-9.7-3.3-11.3-8H6.3C9.6 35.6 16.3 44 24 44z"/>
            <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.5l6.2 5.2C41.4 34.9 44 29.9 44 24c0-1.3-.1-2.6-.4-3.9z"/>
          </svg>
          {loading ? 'מתחבר...' : 'כנס עם Google'}
        </button>

        <button
          className="btn btn-ghost text-sm"
          onClick={() => { setCreateMode(true); setError('') }}
        >
          הקמת ליגה (מנהלים)
        </button>
      </div>

      {error && <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>}
    </div>
  )
}
