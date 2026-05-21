'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

export default function RegisterTeamPage() {
  const [teamName, setTeamName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const supabase = createClient()
  const router = useRouter()

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setError('יש להתחבר'); setLoading(false); return }

    // Get active league
    const { data: league } = await supabase.from('leagues').select('id, budget_per_team').order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (!league) { setError('אין ליגה פעילה'); setLoading(false); return }

    // Check if user already has team
    const { data: existing } = await supabase.from('teams').select('id').eq('user_id', user.id).eq('league_id', league.id).maybeSingle()
    if (existing) { setError('יש לך כבר קבוצה בליגה זו'); setLoading(false); return }

    const { error: insertError } = await supabase.from('teams').insert({
      league_id: league.id,
      name: teamName,
      user_id: user.id,
      budget_remaining: league.budget_per_team,
      approved: false,
    })

    if (insertError) {
      setError(insertError.code === '23505' ? 'שם הקבוצה כבר תפוס' : insertError.message)
    } else {
      setSuccess(true)
    }
    setLoading(false)
  }

  if (success) {
    return (
      <div className="max-w-sm mx-auto text-center py-12">
        <div className="text-5xl mb-4">✅</div>
        <h2 className="text-xl font-bold mb-2">הקבוצה נרשמה!</h2>
        <p className="mb-6" style={{ color: 'var(--muted)' }}>האדמין יאשר את הקבוצה שלך בקרוב.</p>
        <button className="btn btn-primary" onClick={() => router.push('/')}>חזרה לבית</button>
      </div>
    )
  }

  return (
    <div className="max-w-sm mx-auto py-8">
      <h1 className="text-2xl font-bold mb-6">רישום קבוצה</h1>
      <form onSubmit={handleRegister} className="card flex flex-col gap-4">
        <div>
          <label className="block text-sm font-medium mb-1.5">שם הקבוצה</label>
          <input
            className="input"
            placeholder="שם הקבוצה שלך"
            value={teamName}
            onChange={e => setTeamName(e.target.value)}
            required
            maxLength={50}
          />
        </div>
        {error && <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={loading || !teamName.trim()}>
          {loading ? 'רושם...' : 'הרשם לדראפט'}
        </button>
      </form>
    </div>
  )
}
