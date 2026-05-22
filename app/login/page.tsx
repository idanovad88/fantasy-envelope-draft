'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

type Mode = 'join' | 'create' | null

export default function LandingPage() {
  const [mode, setMode] = useState<Mode>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [leagueName, setLeagueName] = useState('')
  const [leaguePassword, setLeaguePassword] = useState('')
  const [teamName, setTeamName] = useState('')
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [loading, setLoading] = useState(false)
  const supabase = createClient()
  const router = useRouter()

  function reset() {
    setError('')
    setInfo('')
    setEmail('')
    setPassword('')
    setLeagueName('')
    setLeaguePassword('')
    setTeamName('')
  }

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    // 1. Auth — reuse existing session or sign in anonymously
    const { data: { user: existingUser } } = await supabase.auth.getUser()
    if (!existingUser) {
      const { data: anonData, error: anonErr } = await supabase.auth.signInAnonymously()
      if (anonErr || !anonData.user) {
        setError('שגיאת כניסה: ' + (anonErr?.message ?? 'לא ניתן להתחבר'))
        setLoading(false)
        return
      }
    }

    // 2. Delegate all join logic to API route (uses admin client to bypass RLS)
    const res = await fetch('/api/join-league', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        leagueName: leagueName.trim(),
        joinCode: leaguePassword.trim(),
        teamName: teamName.trim(),
      }),
    })

    const json = await res.json()
    if (!res.ok) {
      setError(json.error ?? 'שגיאה בהצטרפות לליגה')
      setLoading(false)
      return
    }

    window.location.href = '/'
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

    const { data: adminRow } = await supabase
      .from('admin_users')
      .select('role')
      .eq('user_id', signInData.user.id)
      .maybeSingle()

    if (!adminRow) {
      setError('אין לך הרשאה להקים ליגה — פנה למנהל המערכת')
      await supabase.auth.signOut()
      setLoading(false)
      return
    }

    router.push('/create-league')
    router.refresh()
  }

  // ── Landing screen ──────────────────────────────────────────
  if (!mode) {
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

        <div className="flex flex-col sm:flex-row gap-4 w-full max-w-xs">
          <button
            className="btn btn-primary flex-1 text-lg py-4"
            onClick={() => { reset(); setMode('join') }}
          >
            הצטרף לליגה
          </button>
          <button
            className="btn btn-outline flex-1 text-lg py-4"
            onClick={() => { reset(); setMode('create') }}
          >
            הקם ליגה
          </button>
        </div>
      </div>
    )
  }

  // ── Forms ───────────────────────────────────────────────────
  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ background: 'var(--background)' }}
    >
      <div className="card w-full max-w-sm">
        <div className="text-center mb-6">
          <div className="text-3xl mb-2">🏀</div>
          <h1 className="text-xl font-bold">
            {mode === 'join' ? 'הצטרף לליגה' : 'הקמת ליגה חדשה'}
          </h1>
        </div>

        {mode === 'join' ? (
          <form onSubmit={handleJoin} className="flex flex-col gap-4">
            <div>
              <label className="block text-sm font-medium mb-1.5">שם הליגה</label>
              <input
                className="input"
                placeholder="שם הליגה"
                value={leagueName}
                onChange={e => setLeagueName(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">סיסמת הליגה</label>
              <input
                className="input"
                type="password"
                placeholder="הסיסמה שקיבלת מהמנהל"
                value={leaguePassword}
                onChange={e => setLeaguePassword(e.target.value)}
                required
                dir="ltr"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">שם הקבוצה שלך</label>
              <input
                className="input"
                placeholder="בחר שם לקבוצה"
                value={teamName}
                onChange={e => setTeamName(e.target.value)}
                required
                maxLength={40}
              />
            </div>

            {error && <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>}

            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'מצטרף...' : 'הצטרף לליגה'}
            </button>
            <button
              type="button"
              className="text-sm text-center"
              style={{ color: 'var(--muted)' }}
              onClick={() => { setMode(null); setError('') }}
            >
              ← חזרה
            </button>
          </form>
        ) : (
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
              <input
                className="input"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                dir="ltr"
              />
            </div>

            {error && <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>}

            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'נכנס...' : 'כניסה'}
            </button>
            <button
              type="button"
              className="text-sm text-center"
              style={{ color: 'var(--muted)' }}
              onClick={() => { setMode(null); setError('') }}
            >
              ← חזרה
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
