'use client'

import { useState } from 'react'
import { Eye, EyeOff, X } from 'lucide-react'

type Step = 'league_name' | 'password' | 'team_name'

export default function JoinLeagueForm() {
  const [modalOpen, setModalOpen] = useState(false)
  const [step, setStep] = useState<Step>('league_name')
  const [leagueName, setLeagueName] = useState('')
  const [leaguePassword, setLeaguePassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [teamName, setTeamName] = useState('')
  const [foundLeague, setFoundLeague] = useState<{ id: string; name: string } | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  function openModal() {
    setModalOpen(true)
    setStep('league_name')
    setLeagueName('')
    setLeaguePassword('')
    setTeamName('')
    setFoundLeague(null)
    setError('')
  }

  function closeModal() {
    setModalOpen(false)
  }

  function goBack() {
    setError('')
    if (step === 'password') { setStep('league_name'); setLeaguePassword('') }
    if (step === 'team_name') { setStep('password'); setTeamName('') }
  }

  async function handleLeagueName(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const res = await fetch('/api/leagues/find', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leagueName: leagueName.trim() }),
    })
    const data = await res.json()
    if (!data.found) {
      setError(data.error ?? 'ליגה לא נמצאה')
    } else {
      setFoundLeague(data.league)
      setStep('password')
    }
    setLoading(false)
  }

  async function handlePassword(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const res = await fetch('/api/leagues/find', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leagueName: leagueName.trim(), joinCode: leaguePassword.trim() }),
    })
    const data = await res.json()
    if (!data.found) {
      setError(data.error ?? 'סיסמה שגויה')
    } else {
      setFoundLeague(data.league)
      setStep('team_name')
    }
    setLoading(false)
  }

  async function handleTeamName(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
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
    window.location.href = '/leagues'
  }

  const stepIndex = step === 'league_name' ? 0 : step === 'password' ? 1 : 2

  return (
    <>
      <button className="btn btn-primary w-full text-base py-3" onClick={openModal}>
        🏀 הצטרף לליגה קיימת
      </button>

      {modalOpen && (
        <div
          className="fixed inset-0 flex items-center justify-center px-4"
          style={{ background: 'rgba(0,0,0,0.75)', zIndex: 50 }}
          onClick={e => { if (e.target === e.currentTarget) closeModal() }}
        >
          <div className="card w-full max-w-sm relative">
            {/* Close */}
            <button
              onClick={closeModal}
              style={{ position: 'absolute', top: '1rem', left: '1rem', color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            >
              <X size={20} />
            </button>

            {/* Header + step dots */}
            <div className="text-center mb-5">
              <h2 className="text-xl font-bold">הצטרף לליגה</h2>
              <div className="flex justify-center gap-2 mt-3">
                {[0, 1, 2].map(i => (
                  <div
                    key={i}
                    style={{
                      width: '8px',
                      height: '8px',
                      borderRadius: '9999px',
                      background: i <= stepIndex ? 'var(--primary)' : 'var(--border)',
                      transition: 'background 0.2s',
                    }}
                  />
                ))}
              </div>
            </div>

            {/* Step 1 — League name */}
            {step === 'league_name' && (
              <form onSubmit={handleLeagueName} className="flex flex-col gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1.5">שם הליגה</label>
                  <input
                    className="input"
                    placeholder="הכנס שם ליגה"
                    value={leagueName}
                    onChange={e => setLeagueName(e.target.value)}
                    autoFocus
                    required
                  />
                </div>
                {error && <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>}
                <button type="submit" className="btn btn-primary" disabled={loading || !leagueName.trim()}>
                  {loading ? 'מחפש...' : 'המשך →'}
                </button>
              </form>
            )}

            {/* Step 2 — Password */}
            {step === 'password' && (
              <form onSubmit={handlePassword} className="flex flex-col gap-4">
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm" style={{ background: 'rgba(99,102,241,0.1)', color: 'var(--primary)' }}>
                  <span>✓</span>
                  <span className="font-medium">{foundLeague?.name}</span>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1.5">סיסמת הליגה</label>
                  <div className="relative">
                    <input
                      className="input"
                      style={{ paddingLeft: '2rem' }}
                      type={showPassword ? 'text' : 'password'}
                      placeholder="הסיסמה שקיבלת מהמנהל"
                      value={leaguePassword}
                      onChange={e => setLeaguePassword(e.target.value)}
                      autoFocus
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
                <div className="flex gap-2">
                  <button type="button" className="btn btn-outline flex-1" onClick={goBack}>← חזרה</button>
                  <button type="submit" className="btn btn-primary flex-1" disabled={loading || !leaguePassword.trim()}>
                    {loading ? 'בודק...' : 'המשך →'}
                  </button>
                </div>
              </form>
            )}

            {/* Step 3 — Team name */}
            {step === 'team_name' && (
              <form onSubmit={handleTeamName} className="flex flex-col gap-4">
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm" style={{ background: 'rgba(99,102,241,0.1)', color: 'var(--primary)' }}>
                  <span>✓</span>
                  <span className="font-medium">{foundLeague?.name}</span>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1.5">שם הקבוצה שלך</label>
                  <input
                    className="input"
                    placeholder="בחר שם לקבוצה"
                    value={teamName}
                    onChange={e => setTeamName(e.target.value)}
                    autoFocus
                    required
                    maxLength={40}
                  />
                </div>
                {error && <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>}
                <div className="flex gap-2">
                  <button type="button" className="btn btn-outline flex-1" onClick={goBack}>← חזרה</button>
                  <button type="submit" className="btn btn-primary flex-1" disabled={loading || !teamName.trim()}>
                    {loading ? 'מצטרף...' : 'הצטרף'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  )
}
