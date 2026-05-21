'use client'

import { useState, useEffect, Suspense } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter, useSearchParams } from 'next/navigation'

function JoinLeagueContent() {
  const searchParams = useSearchParams()
  const initialTab = searchParams.get('tab') === 'create' ? 'create' : 'join'

  const [tab, setTab] = useState<'join' | 'create'>(initialTab)

  // --- Join existing league state ---
  const [leagueName, setLeagueName] = useState('')
  const [leaguePassword, setLeaguePassword] = useState('')
  const [teamName, setTeamName] = useState('')
  const [joinStep, setJoinStep] = useState<'find' | 'team'>('find')
  const [foundLeague, setFoundLeague] = useState<{ id: string; name: string; budget_per_team: number } | null>(null)

  // --- Create league state ---
  const [newLeagueName, setNewLeagueName] = useState('')
  const [newLeagueCode, setNewLeagueCode] = useState('')
  const [canCreate, setCanCreate] = useState<boolean | null>(null)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  const supabase = createClient()
  const router = useRouter()

  useEffect(() => {
    async function checkWhitelist() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user?.email) { setCanCreate(false); return }
      const { data, error } = await supabase
        .from('league_creator_whitelist')
        .select('email')
        .eq('email', user.email)
        .maybeSingle()
      setCanCreate(!error && !!data)
    }
    checkWhitelist()
  }, [])

  async function findLeague(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const { data } = await supabase
      .from('leagues')
      .select('id, name, budget_per_team, status')
      .ilike('name', leagueName.trim())
      .eq('join_code', leaguePassword.trim().toUpperCase())
      .maybeSingle()
    if (!data) {
      setError('שם הליגה או הסיסמה שגויים')
    } else if (data.status === 'completed') {
      setError('הדראפט הסתיים — לא ניתן להצטרף')
    } else {
      setFoundLeague(data)
      setJoinStep('team')
    }
    setLoading(false)
  }

  async function registerTeam(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setError('יש להתחבר מחדש'); setLoading(false); return }
    const { data: existing } = await supabase
      .from('teams').select('id').eq('user_id', user.id).eq('league_id', foundLeague!.id).maybeSingle()
    if (existing) { setError('כבר הצטרפת לליגה זו'); setLoading(false); return }
    const { error: insertErr } = await supabase.from('teams').insert({
      league_id: foundLeague!.id,
      name: teamName.trim(),
      user_id: user.id,
      budget_remaining: foundLeague!.budget_per_team,
      approved: false,
    })
    if (insertErr) {
      setError(insertErr.code === '23505' ? 'שם קבוצה זה כבר תפוס — בחר שם אחר' : insertErr.message)
    } else {
      setSuccess(true)
    }
    setLoading(false)
  }

  async function createLeague(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const res = await fetch('/api/create-league', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leagueName: newLeagueName.trim(), joinCode: newLeagueCode.trim() }),
    })
    const data = await res.json()
    if (data.error) {
      setError(data.error)
    } else {
      router.push('/admin')
    }
    setLoading(false)
  }

  if (success) {
    return (
      <div className="max-w-sm mx-auto text-center py-12">
        <div className="text-5xl mb-4">✅</div>
        <h2 className="text-xl font-bold mb-2">נרשמת בהצלחה!</h2>
        <p className="mb-6" style={{ color: 'var(--muted)' }}>הקבוצה ממתינה לאישור המנהל.</p>
        <button className="btn btn-primary" onClick={() => router.push('/')}>לדף הבית</button>
      </div>
    )
  }

  return (
    <div className="max-w-sm mx-auto py-8">
      <h1 className="text-2xl font-bold mb-6">הצטרפות לליגה</h1>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 p-1 rounded-lg" style={{ background: 'var(--card)' }}>
        <button
          className="flex-1 py-2 rounded-md text-sm font-medium transition-all"
          style={tab === 'join' ? { background: 'var(--primary)', color: 'white' } : { color: 'var(--muted)' }}
          onClick={() => { setTab('join'); setError('') }}
        >
          הצטרף לליגה
        </button>
        <button
          className="flex-1 py-2 rounded-md text-sm font-medium transition-all"
          style={tab === 'create' ? { background: 'var(--primary)', color: 'white' } : { color: 'var(--muted)' }}
          onClick={() => { setTab('create'); setError('') }}
        >
          הקם ליגה
        </button>
      </div>

      {/* Join existing league */}
      {tab === 'join' && (
        joinStep === 'find' ? (
          <form onSubmit={findLeague} className="card flex flex-col gap-4">
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
            {error && <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>}
            <button type="submit" className="btn btn-primary" disabled={loading || !leagueName.trim() || !leaguePassword.trim()}>
              {loading ? 'מחפש...' : 'המשך'}
            </button>
          </form>
        ) : (
          <form onSubmit={registerTeam} className="card flex flex-col gap-4">
            <div className="p-3 rounded-lg text-sm" style={{ background: 'rgba(99,102,241,0.1)', color: 'var(--primary)' }}>
              ✓ ליגה: <strong>{foundLeague?.name}</strong>
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
            <button type="submit" className="btn btn-primary" disabled={loading || !teamName.trim()}>
              {loading ? 'רושם...' : 'הצטרף לליגה'}
            </button>
            <button type="button" className="btn-ghost text-sm" onClick={() => { setJoinStep('find'); setError('') }}>
              ← שנה פרטים
            </button>
          </form>
        )
      )}

      {/* Create new league */}
      {tab === 'create' && (
        <div className="card flex flex-col gap-4">
          {canCreate === null && (
            <p className="text-sm text-center" style={{ color: 'var(--muted)' }}>בודק הרשאות...</p>
          )}
          {canCreate === false && (
            <div className="text-center py-4">
              <p className="text-4xl mb-3">🔒</p>
              <p className="font-medium mb-2">אינך מורשה להקים ליגה</p>
              <p className="text-sm" style={{ color: 'var(--muted)' }}>
                פנה למנהל המערכת כדי לקבל הרשאה.
              </p>
            </div>
          )}
          {canCreate === true && (
            <form onSubmit={createLeague} className="flex flex-col gap-4">
              <div>
                <label className="block text-sm font-medium mb-1.5">שם הליגה</label>
                <input
                  className="input"
                  placeholder="פנטזי דראפט 2025-26"
                  value={newLeagueName}
                  onChange={e => setNewLeagueName(e.target.value)}
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">קוד הצטרפות (אופציונלי)</label>
                <input
                  className="input uppercase tracking-widest font-bold"
                  placeholder="ABC123"
                  value={newLeagueCode}
                  onChange={e => setNewLeagueCode(e.target.value.toUpperCase())}
                  maxLength={10}
                  dir="ltr"
                />
                <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
                  קוד שישתפו חברים כדי להצטרף
                </p>
              </div>
              {error && <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>}
              <button type="submit" className="btn btn-primary" disabled={loading || !newLeagueName.trim()}>
                {loading ? 'יוצר...' : '🚀 הקם ליגה'}
              </button>
              <p className="text-xs text-center" style={{ color: 'var(--muted)' }}>
                תועבר לפאנל הניהול להגדרת הליגה
              </p>
            </form>
          )}
        </div>
      )}
    </div>
  )
}

export default function JoinLeaguePage() {
  return (
    <Suspense>
      <JoinLeagueContent />
    </Suspense>
  )
}
