'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

export default function JoinLeaguePage() {
  const [leagueName, setLeagueName] = useState('')
  const [leaguePassword, setLeaguePassword] = useState('')
  const [teamName, setTeamName] = useState('')
  const [step, setStep] = useState<'find' | 'team'>('find')
  const [league, setLeague] = useState<{ id: string; name: string; budget_per_team: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const supabase = createClient()
  const router = useRouter()

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
      setLeague(data)
      setStep('team')
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
      .from('teams').select('id').eq('user_id', user.id).eq('league_id', league!.id).maybeSingle()

    if (existing) { setError('כבר הצטרפת לליגה זו'); setLoading(false); return }

    const { error: insertErr } = await supabase.from('teams').insert({
      league_id: league!.id,
      name: teamName.trim(),
      user_id: user.id,
      budget_remaining: league!.budget_per_team,
      approved: false,
    })

    if (insertErr) {
      setError(insertErr.code === '23505' ? 'שם קבוצה זה כבר תפוס — בחר שם אחר' : insertErr.message)
    } else {
      setSuccess(true)
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

      {step === 'find' ? (
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
            ✓ ליגה: <strong>{league?.name}</strong>
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
          <button type="button" className="btn-ghost text-sm" onClick={() => { setStep('find'); setError('') }}>
            ← שנה פרטים
          </button>
        </form>
      )}
    </div>
  )
}
