'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

export default function CreateLeaguePage() {
  const [authorized, setAuthorized] = useState<boolean | null>(null)
  const [leagueName, setLeagueName] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [numTeams, setNumTeams] = useState(10)
  const [playersPerTeam, setPlayersPerTeam] = useState(13)
  const [budgetPerTeam, setBudgetPerTeam] = useState(200)
  const [minBid, setMinBid] = useState(1)
  const [joinDraft, setJoinDraft] = useState(false)
  const [teamName, setTeamName] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const supabase = createClient()
  const router = useRouter()

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user?.email) { setAuthorized(false); return }
      supabase
        .from('league_creator_whitelist')
        .select('email')
        .eq('email', user.email)
        .maybeSingle()
        .then(({ data }) => setAuthorized(!!data))
    })
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const res = await fetch('/api/create-league', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        leagueName,
        joinCode,
        numTeams,
        playersPerTeam,
        budgetPerTeam,
        minBid,
        teamName: joinDraft ? teamName.trim() : null,
      }),
    })

    const data = await res.json()
    if (!res.ok) {
      setError(data.error ?? 'שגיאה ביצירת הליגה')
      setLoading(false)
      return
    }

    router.push('/admin')
    router.refresh()
  }

  if (authorized === null) {
    return (
      <div className="max-w-lg mx-auto mt-12 text-center" style={{ color: 'var(--muted)' }}>
        טוען...
      </div>
    )
  }

  if (!authorized) {
    return (
      <div className="max-w-lg mx-auto mt-12">
        <div className="card text-center">
          <p className="text-3xl mb-3">🔒</p>
          <p className="font-bold mb-2">אינך מורשה להקים ליגה</p>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>פנה למנהל המערכת להוסיף את כתובת המייל שלך לרשימת המורשים.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-lg mx-auto">
      <h1 className="text-2xl font-bold mb-6">הקמת ליגה חדשה</h1>

      <form onSubmit={handleSubmit} className="card flex flex-col gap-5">
        <div>
          <label className="block text-sm font-medium mb-1.5">שם הליגה</label>
          <input
            className="input"
            placeholder="ליגת החברים 2025"
            value={leagueName}
            onChange={e => setLeagueName(e.target.value)}
            required
            maxLength={80}
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5">קוד הצטרפות</label>
          <input
            className="input"
            placeholder="למשל: DRAFT25 (אופציונלי)"
            value={joinCode}
            onChange={e => setJoinCode(e.target.value.toUpperCase())}
            maxLength={10}
            dir="ltr"
          />
          <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>המשתתפים יזדקקו לקוד זה כדי להצטרף</p>
        </div>

        <div className="border-t pt-4" style={{ borderColor: 'var(--border)' }}>
          <p className="text-sm font-medium mb-3">הגדרות ליגה</p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm mb-1.5" style={{ color: 'var(--muted)' }}>מספר קבוצות</label>
              <input
                className="input"
                type="number"
                min={2}
                max={30}
                value={numTeams}
                onChange={e => setNumTeams(Number(e.target.value))}
                required
                dir="ltr"
              />
            </div>
            <div>
              <label className="block text-sm mb-1.5" style={{ color: 'var(--muted)' }}>שחקנים לקבוצה</label>
              <input
                className="input"
                type="number"
                min={1}
                max={50}
                value={playersPerTeam}
                onChange={e => setPlayersPerTeam(Number(e.target.value))}
                required
                dir="ltr"
              />
            </div>
            <div>
              <label className="block text-sm mb-1.5" style={{ color: 'var(--muted)' }}>תקציב לקבוצה ($)</label>
              <input
                className="input"
                type="number"
                min={1}
                value={budgetPerTeam}
                onChange={e => setBudgetPerTeam(Number(e.target.value))}
                required
                dir="ltr"
              />
            </div>
            <div>
              <label className="block text-sm mb-1.5" style={{ color: 'var(--muted)' }}>הצעת מינימום ($)</label>
              <input
                className="input"
                type="number"
                min={1}
                value={minBid}
                onChange={e => setMinBid(Number(e.target.value))}
                required
                dir="ltr"
              />
            </div>
          </div>
        </div>

        <div className="border-t pt-4" style={{ borderColor: 'var(--border)' }}>
          <p className="text-sm font-medium mb-3">השתתפות בדראפט</p>
          <div className="flex gap-3">
            <button
              type="button"
              className="flex-1 py-2 rounded-lg text-sm font-medium border transition-colors"
              style={{
                background: !joinDraft ? 'var(--primary)' : 'transparent',
                color: !joinDraft ? 'white' : 'var(--muted)',
                borderColor: !joinDraft ? 'var(--primary)' : 'var(--border)',
              }}
              onClick={() => setJoinDraft(false)}
            >
              צופה-מנהל בלבד
            </button>
            <button
              type="button"
              className="flex-1 py-2 rounded-lg text-sm font-medium border transition-colors"
              style={{
                background: joinDraft ? 'var(--primary)' : 'transparent',
                color: joinDraft ? 'white' : 'var(--muted)',
                borderColor: joinDraft ? 'var(--primary)' : 'var(--border)',
              }}
              onClick={() => setJoinDraft(true)}
            >
              אצטרף כשחקן
            </button>
          </div>
          {joinDraft && (
            <div className="mt-3">
              <label className="block text-sm mb-1.5" style={{ color: 'var(--muted)' }}>שם הקבוצה שלך</label>
              <input
                className="input"
                placeholder="שם הקבוצה"
                value={teamName}
                onChange={e => setTeamName(e.target.value)}
                required={joinDraft}
                maxLength={40}
              />
            </div>
          )}
        </div>

        {error && <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>}

        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? 'יוצר ליגה...' : 'הקם ליגה'}
        </button>
      </form>
    </div>
  )
}
