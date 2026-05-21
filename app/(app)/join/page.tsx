'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

export default function JoinLeaguePage() {
  const [code, setCode] = useState('')
  const [teamName, setTeamName] = useState('')
  const [step, setStep] = useState<'code' | 'team'>('code')
  const [league, setLeague] = useState<{ id: string; name: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const supabase = createClient()
  const router = useRouter()

  async function checkCode(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const { data } = await supabase
      .from('leagues')
      .select('id, name, status')
      .eq('join_code', code.trim().toUpperCase())
      .maybeSingle()

    if (!data) {
      setError('קוד לא תקין — בדוק שוב')
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
    if (!user) { setError('יש להתחבר'); setLoading(false); return }

    const { data: existing } = await supabase
      .from('teams')
      .select('id')
      .eq('user_id', user.id)
      .eq('league_id', league!.id)
      .maybeSingle()

    if (existing) {
      setError('כבר נרשמת לליגה זו')
      setLoading(false)
      return
    }

    const { data: leagueData } = await supabase
      .from('leagues')
      .select('budget_per_team')
      .eq('id', league!.id)
      .single()

    const { error: insertError } = await supabase.from('teams').insert({
      league_id: league!.id,
      name: teamName,
      user_id: user.id,
      budget_remaining: leagueData?.budget_per_team ?? 200,
      approved: false,
    })

    if (insertError) {
      setError(insertError.code === '23505' ? 'שם הקבוצה כבר תפוס, בחר שם אחר' : insertError.message)
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
        <p className="mb-2" style={{ color: 'var(--muted)' }}>הקבוצה שלך ממתינה לאישור האדמין.</p>
        <p className="text-sm mb-6" style={{ color: 'var(--muted)' }}>תקבל גישה לאחר האישור.</p>
        <button className="btn btn-primary" onClick={() => router.push('/')}>לדף הבית</button>
      </div>
    )
  }

  return (
    <div className="max-w-sm mx-auto py-8">
      <h1 className="text-2xl font-bold mb-2">הצטרפות לליגה 🏀</h1>
      <p className="text-sm mb-6" style={{ color: 'var(--muted)' }}>
        הכנס את קוד הליגה שקיבלת מהאדמין
      </p>

      {step === 'code' ? (
        <form onSubmit={checkCode} className="card flex flex-col gap-4">
          <div>
            <label className="block text-sm font-medium mb-1.5">קוד ליגה</label>
            <input
              className="input text-center text-2xl font-bold tracking-widest uppercase"
              placeholder="ABC123"
              value={code}
              onChange={e => setCode(e.target.value.toUpperCase())}
              maxLength={10}
              required
              dir="ltr"
            />
          </div>
          {error && <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>}
          <button type="submit" className="btn btn-primary" disabled={loading || !code.trim()}>
            {loading ? 'בודק...' : 'המשך'}
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
              placeholder="שם הקבוצה"
              value={teamName}
              onChange={e => setTeamName(e.target.value)}
              required
              maxLength={50}
            />
          </div>
          {error && <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>}
          <button type="submit" className="btn btn-primary" disabled={loading || !teamName.trim()}>
            {loading ? 'רושם...' : 'הצטרף לליגה'}
          </button>
          <button type="button" className="btn btn-ghost text-sm" onClick={() => { setStep('code'); setError('') }}>
            ← שנה קוד
          </button>
        </form>
      )}
    </div>
  )
}
