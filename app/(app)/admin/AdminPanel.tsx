'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { formatDateTime, formatTime } from '@/lib/utils'
import type { League, Team, Auction } from '@/types'

type PastAuction = { id: string; scheduled_start: string; winning_bid: number | null; player: { name: string } | null; winning_team: { name: string } | null }

interface Props {
  league: League | null
  teams: Team[]
  pendingTeams: Team[]
  activeAuction: (Auction & { player: { name: string }; bids: { id: string }[] }) | null
  players: { id: string; name: string; status: string; ranking: number | null; position: string | null }[]
  pastAuctions: PastAuction[]
}

export default function AdminPanel({ league, teams, pendingTeams, activeAuction, players, pastAuctions }: Props) {
  const supabase = createClient()
  const [tab, setTab] = useState<'overview' | 'teams' | 'auction' | 'players' | 'lottery' | 'league'>('overview')
  const [loading, setLoading] = useState('')
  const [msg, setMsg] = useState('')

  // League settings state
  const [leagueName, setLeagueName] = useState(league?.name ?? 'פנטזי דראפט 25-26')
  const [numTeams, setNumTeams] = useState(league?.num_teams ?? 12)
  const [playersPerTeam, setPlayersPerTeam] = useState(league?.players_per_team ?? 13)
  const [budgetPerTeam, setBudgetPerTeam] = useState(league?.budget_per_team ?? 200)
  const [joinCode, setJoinCode] = useState(league?.join_code ?? '')
  const [draftStartTime, setDraftStartTime] = useState(() => {
    if (!league?.draft_start_time) return ''
    return new Date(league.draft_start_time).toISOString().slice(0, 16)
  })

  // Player management state
  const [newPlayerName, setNewPlayerName] = useState('')
  const [newPlayerPos, setNewPlayerPos] = useState('PG')
  const [playerFilter, setPlayerFilter] = useState('')

  // Admin management state
  const [adminEmail, setAdminEmail] = useState('')

  // Auction nomination state
  const [selectedPlayer, setSelectedPlayer] = useState('')
  const [selectedNominator, setSelectedNominator] = useState('')
  const [nominationTime, setNominationTime] = useState(() => {
    const d = new Date()
    d.setMinutes(0, 0, 0)
    return d.toISOString().slice(0, 16)
  })

  const availablePlayers = players.filter(p => p.status === 'available')

  async function addPlayer() {
    if (!league || !newPlayerName.trim()) return
    setLoading('add_player')
    const { error } = await supabase.from('players').insert({
      league_id: league.id,
      name: newPlayerName.trim(),
      position: newPlayerPos,
      status: 'available',
      stats: {},
    })
    if (error) { setMsg('שגיאה: ' + error.message); setLoading(''); return }
    setMsg(`${newPlayerName.trim()} נוסף!`)
    setNewPlayerName('')
    setLoading('')
    window.location.reload()
  }

  async function removePlayer(playerId: string, name: string) {
    if (!confirm(`להסיר את ${name} מהרשימה?`)) return
    setLoading('remove_' + playerId)
    await supabase.from('players').delete().eq('id', playerId)
    setMsg(`${name} הוסר`)
    setLoading('')
    window.location.reload()
  }

  async function addAdmin() {
    if (!adminEmail.trim()) return
    setLoading('add_admin')
    const res = await fetch('/api/admin/add-admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminEmail.trim() }),
    })
    const data = await res.json()
    if (data.error) setMsg('שגיאה: ' + data.error)
    else { setMsg(`מנהל נוסף בהצלחה`); setAdminEmail('') }
    setLoading('')
  }

  function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    const code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
    setJoinCode(code)
  }

  async function saveLeague() {
    setLoading('league')
    const payload = {
      name: leagueName,
      num_teams: numTeams,
      players_per_team: playersPerTeam,
      budget_per_team: budgetPerTeam,
      join_code: joinCode.trim().toUpperCase() || null,
      draft_start_time: draftStartTime ? new Date(draftStartTime).toISOString() : null,
      updated_at: new Date().toISOString(),
    }
    if (league) {
      await supabase.from('leagues').update(payload).eq('id', league.id)
    } else {
      const { data: { user } } = await supabase.auth.getUser()
      await supabase.from('leagues').insert({ ...payload, created_by: user?.id })
    }
    setMsg('הליגה נשמרה')
    setLoading('')
    window.location.reload()
  }

  async function setLeagueStatus(status: string) {
    if (!league) return
    setLoading('status_' + status)
    await supabase.from('leagues').update({ status, updated_at: new Date().toISOString() }).eq('id', league.id)
    setMsg(`סטטוס עודכן ל: ${status}`)
    setLoading('')
    window.location.reload()
  }

  async function runLottery() {
    if (!league) return
    setLoading('lottery')
    const approvedTeams = teams.filter(t => t.approved && !t.is_complete)
    const shuffled = [...approvedTeams].sort(() => Math.random() - 0.5)
    const updates = shuffled.map((t, i) =>
      supabase.from('teams').update({ priority_rank: i + 1, tiebreak_rank: i + 1, updated_at: new Date().toISOString() }).eq('id', t.id)
    )
    await Promise.all(updates)
    await setLeagueStatus('active')
    setMsg('הגרלה בוצעה! סדר פריוריטי נקבע.')
    setLoading('')
    window.location.reload()
  }

  async function approveTeam(teamId: string) {
    setLoading('team_' + teamId)
    await supabase.from('teams').update({ approved: true, budget_remaining: league?.budget_per_team ?? 200, updated_at: new Date().toISOString() }).eq('id', teamId)
    setMsg('קבוצה אושרה')
    setLoading('')
    window.location.reload()
  }

  async function nominatePlayer() {
    if (!league || !selectedPlayer || !selectedNominator) return
    setLoading('nominate')

    const scheduledStart = new Date(nominationTime + ':00')
    const revealMinutes = league.reveal_before_minutes ?? 30
    const nextNomination = new Date(scheduledStart.getTime() + league.nomination_interval_hours * 60 * 60 * 1000)
    const revealTime = new Date(nextNomination.getTime() - revealMinutes * 60 * 1000)

    const existingCount = await supabase.from('auctions').select('id', { count: 'exact' }).eq('league_id', league.id)
    const slotNum = (existingCount.count ?? 0) + 1

    const { error: auctionErr } = await supabase.from('auctions').insert({
      league_id: league.id,
      player_id: selectedPlayer,
      nominating_team_id: selectedNominator || null,
      slot_number: slotNum,
      scheduled_start: scheduledStart.toISOString(),
      reveal_time: revealTime.toISOString(),
      status: 'active',
    })

    if (!auctionErr) {
      await supabase.from('players').update({ status: 'on_auction' }).eq('id', selectedPlayer)
      setMsg('שחקן הועלה למכרז!')
      setSelectedPlayer('')
    } else {
      setMsg('שגיאה: ' + auctionErr.message)
    }
    setLoading('')
    window.location.reload()
  }

  async function revealAuction(auctionId: string) {
    setLoading('reveal_' + auctionId)
    await supabase.rpc('resolve_auction', { p_auction_id: auctionId })
    setMsg('תוצאות נחשפו והשחקן הועבר לקבוצה הזוכה')
    setLoading('')
    window.location.reload()
  }

  async function cancelAuction(auctionId: string) {
    if (!confirm('לבטל את המכרז ולהחזיר את השחקן לרשימה?')) return
    setLoading('cancel_' + auctionId)
    const res = await fetch('/api/admin/cancel-auction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auctionId }),
    })
    if (res.ok) {
      setMsg('המכרז בוטל והשחקן הוחזר לרשימה')
    } else {
      setMsg('שגיאה בביטול')
    }
    setLoading('')
    window.location.reload()
  }

  const TABS = [
    { id: 'overview', label: 'סקירה' },
    { id: 'auction', label: 'מכרז' },
    { id: 'players', label: 'שחקנים' },
    { id: 'teams', label: 'קבוצות' },
    { id: 'lottery', label: 'הגרלה' },
    { id: 'league', label: 'הגדרות' },
  ] as const

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">ניהול דראפט</h1>
      {msg && (
        <div className="mb-4 p-3 rounded-lg text-sm" style={{ background: 'rgba(99,102,241,0.15)', color: 'var(--primary)' }}>
          {msg}
          <button className="btn-ghost text-xs mr-2" onClick={() => setMsg('')}>✕</button>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-6 p-1 rounded-lg" style={{ background: 'var(--card)' }}>
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className="flex-1 py-2 px-2 rounded-md text-sm font-medium transition-all"
            style={tab === t.id ? { background: 'var(--primary)', color: 'white' } : { color: 'var(--muted)' }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* OVERVIEW */}
      {tab === 'overview' && (
        <div className="flex flex-col gap-4">
          <div className="card">
            <h2 className="font-bold mb-3">סטטוס ליגה</h2>
            {league ? (
              <>
                <p className="text-xl font-bold mb-3">{league.name}</p>
                <div className="flex gap-2 flex-wrap">
                  <span className="badge badge-blue">{league.status}</span>
                  <span className="badge badge-gray">{teams.filter(t => t.approved).length}/{league.num_teams} קבוצות</span>
                  <span className="badge badge-green">{teams.filter(t => t.is_complete).length} סיימו</span>
                </div>
                <div className="flex gap-2 mt-4 flex-wrap">
                  {league.status === 'active' && (
                    <button className="btn btn-danger" onClick={() => setLeagueStatus('paused')} disabled={!!loading}>
                      ⏸ השהה דראפט
                    </button>
                  )}
                  {league.status === 'paused' && (
                    <button className="btn btn-success" onClick={() => setLeagueStatus('active')} disabled={!!loading}>
                      ▶ המשך דראפט
                    </button>
                  )}
                  {league.status === 'active' && (
                    <button className="btn btn-danger" onClick={() => { if (confirm('לסיים את הדראפט?')) setLeagueStatus('completed') }}>
                      🏁 סיים דראפט
                    </button>
                  )}
                </div>
              </>
            ) : (
              <p style={{ color: 'var(--muted)' }}>ליגה טרם נוצרה. עבור להגדרות.</p>
            )}
          </div>

          {pendingTeams.length > 0 && (
            <div className="card" style={{ borderColor: 'var(--warning)' }}>
              <h2 className="font-bold mb-3 flex items-center gap-2">
                ⚠️ קבוצות ממתינות לאישור ({pendingTeams.length})
              </h2>
              {pendingTeams.map(t => (
                <div key={t.id} className="flex items-center justify-between py-2 border-t" style={{ borderColor: 'var(--border)' }}>
                  <span className="font-medium">{t.name}</span>
                  <button className="btn btn-success text-sm" onClick={() => approveTeam(t.id)} disabled={loading === 'team_' + t.id}>
                    {loading === 'team_' + t.id ? '...' : 'אשר'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* AUCTION */}
      {tab === 'auction' && (
        <div className="flex flex-col gap-4">
          {/* Active auction */}
          {activeAuction && (
            <div className="card" style={{ borderColor: 'var(--primary)' }}>
              <h2 className="font-bold mb-3">מכרז פעיל: {(activeAuction as { player?: { name: string } }).player?.name}</h2>
              <p className="text-sm mb-3" style={{ color: 'var(--muted)' }}>
                חשיפה: {formatDateTime(activeAuction.reveal_time)}
              </p>

              {/* Bid count only — amounts hidden until reveal */}
              <div className="mb-4">
                <p className="text-sm" style={{ color: 'var(--muted)' }}>
                  הצעות שהוגשו: <strong style={{ color: 'var(--text)' }}>
                    {((activeAuction as { bids?: unknown[] }).bids || []).length}
                  </strong>
                </p>
              </div>

              <div className="flex gap-2">
                <button className="btn btn-primary flex-1" onClick={() => revealAuction(activeAuction.id)} disabled={!!loading}>
                  {loading === 'reveal_' + activeAuction.id ? 'מסדר...' : '👁 חשוף תוצאות'}
                </button>
                <button className="btn btn-outline flex-shrink-0" onClick={() => cancelAuction(activeAuction.id)} disabled={!!loading}
                  style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}>
                  {loading === 'cancel_' + activeAuction.id ? '...' : '✕ בטל מכרז'}
                </button>
              </div>
            </div>
          )}

          {/* Past auctions */}
          {pastAuctions.length > 0 && (
            <div className="card">
              <h2 className="font-bold mb-3">היסטוריית מכרזים</h2>
              <div className="flex flex-col gap-1">
                {pastAuctions.map(a => (
                  <div key={a.id} className="flex items-center justify-between py-2 border-t text-sm" style={{ borderColor: 'var(--border)' }}>
                    <div>
                      <span className="font-medium">{a.player?.name ?? '—'}</span>
                      {a.winning_team && (
                        <span style={{ color: 'var(--muted)' }}> · {a.winning_team.name} · <span style={{ color: 'var(--success)' }}>${a.winning_bid}</span></span>
                      )}
                      {!a.winning_team && <span style={{ color: 'var(--muted)' }}> · לא נרכש</span>}
                    </div>
                    <button
                      className="text-xs px-2 py-1 rounded"
                      style={{ color: 'var(--danger)', border: '1px solid var(--danger)' }}
                      onClick={() => cancelAuction(a.id)}
                      disabled={!!loading}
                    >
                      בטל
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Nominate new player */}
          <div className="card">
            <h2 className="font-bold mb-4">העלה שחקן חדש למכרז</h2>

            <div className="flex flex-col gap-3">
              <div>
                <label className="block text-sm font-medium mb-1.5">שחקן</label>
                <select className="input" value={selectedPlayer} onChange={e => setSelectedPlayer(e.target.value)}>
                  <option value="">בחר שחקן...</option>
                  {availablePlayers.map(p => (
                    <option key={p.id} value={p.id}>{p.ranking ? `#${p.ranking} ` : ''}{p.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1.5">קבוצה מעלה (מנומינייטור)</label>
                <select className="input" value={selectedNominator} onChange={e => setSelectedNominator(e.target.value)}>
                  <option value="">בחר קבוצה...</option>
                  {teams.filter(t => t.approved && !t.is_complete).sort((a, b) => (a.priority_rank ?? 99) - (b.priority_rank ?? 99)).map(t => (
                    <option key={t.id} value={t.id}>#{t.priority_rank} {t.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1.5">זמן פתיחת מכרז</label>
                <input
                  type="datetime-local"
                  className="input"
                  value={nominationTime}
                  onChange={e => setNominationTime(e.target.value)}
                  dir="ltr"
                />
              </div>

              <button
                className="btn btn-primary"
                onClick={nominatePlayer}
                disabled={!selectedPlayer || !!loading || !league}
              >
                {loading === 'nominate' ? 'מעלה...' : '🚀 העלה למכרז'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PLAYERS */}
      {tab === 'players' && (
        <div className="flex flex-col gap-4">
          {/* Add player */}
          {league && (
            <div className="card">
              <h2 className="font-bold mb-4">הוסף שחקן ידנית</h2>
              <div className="flex flex-col gap-3">
                <div>
                  <label className="block text-sm font-medium mb-1.5">שם שחקן</label>
                  <input
                    className="input"
                    placeholder="שם מלא"
                    value={newPlayerName}
                    onChange={e => setNewPlayerName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && addPlayer()}
                    dir="ltr"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1.5">עמדה</label>
                  <select
                    className="input"
                    value={newPlayerPos}
                    onChange={e => setNewPlayerPos(e.target.value)}
                  >
                    {['PG', 'SG', 'SF', 'PF', 'C'].map(p => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                </div>
                <button
                  className="btn btn-primary"
                  onClick={addPlayer}
                  disabled={!newPlayerName.trim() || loading === 'add_player'}
                >
                  {loading === 'add_player' ? '...' : '+ הוסף שחקן'}
                </button>
              </div>
            </div>
          )}

          {/* Player list */}
          <div className="card">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-bold">רשימת שחקנים ({players.length})</h2>
              <input
                className="input text-sm w-40"
                placeholder="חיפוש..."
                value={playerFilter}
                onChange={e => setPlayerFilter(e.target.value)}
                dir="ltr"
              />
            </div>
            <div className="flex flex-col gap-1 max-h-[500px] overflow-y-auto">
              {players
                .filter(p => !playerFilter || p.name.toLowerCase().includes(playerFilter.toLowerCase()))
                .map(p => (
                  <div key={p.id} className="flex items-center justify-between px-3 py-2 rounded" style={{ background: 'var(--background)' }}>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium" dir="ltr">{p.name}</span>
                      {p.position && <span className="badge badge-blue text-xs">{p.position}</span>}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`badge text-xs ${p.status === 'available' ? 'badge-green' : p.status === 'on_auction' ? 'badge-yellow' : 'badge-gray'}`}>
                        {p.status === 'available' ? 'זמין' : p.status === 'on_auction' ? 'במכרז' : 'נדרפט'}
                      </span>
                      {p.status === 'available' && (
                        <button
                          className="btn btn-danger text-xs py-0.5 px-2"
                          onClick={() => removePlayer(p.id, p.name)}
                          disabled={loading === 'remove_' + p.id}
                        >
                          הסר
                        </button>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}

      {/* TEAMS */}
      {tab === 'teams' && (
        <div className="card">
          <h2 className="font-bold mb-4">ניהול קבוצות</h2>
          <div className="flex flex-col gap-2">
            {teams.map(team => (
              <div key={team.id} className="flex items-center justify-between p-3 rounded-lg" style={{ background: 'var(--background)' }}>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{team.name}</span>
                    {team.is_complete && <span className="badge badge-green text-xs">✅</span>}
                    {!team.approved && <span className="badge badge-yellow text-xs">ממתין</span>}
                  </div>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
                    פריוריטי #{team.priority_rank ?? '—'} · {team.player_count} שחקנים · ${team.budget_remaining}
                  </p>
                </div>
                <div className="flex gap-2">
                  {!team.approved && (
                    <button className="btn btn-success text-xs" onClick={() => approveTeam(team.id)}>
                      אשר
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* LOTTERY */}
      {tab === 'lottery' && (
        <div className="card">
          <h2 className="font-bold mb-2">הגרלת פריוריטי 🎲</h2>
          <p className="text-sm mb-4" style={{ color: 'var(--muted)' }}>
            ההגרלה תקבע את סדר הקבוצות לנומינציה. הסדר ייקבע רנדומלית על כל הקבוצות המאושרות.
          </p>

          <div className="mb-4 flex flex-col gap-1">
            {teams.filter(t => t.approved).map(t => (
              <div key={t.id} className="flex items-center justify-between text-sm px-3 py-2 rounded" style={{ background: 'var(--background)' }}>
                <span>{t.name}</span>
                <span className="badge badge-gray">
                  {t.priority_rank ? `#${t.priority_rank}` : 'ממתין'}
                </span>
              </div>
            ))}
          </div>

          <button
            className="btn btn-primary w-full"
            onClick={runLottery}
            disabled={!!loading || !league || teams.filter(t => t.approved).length < 2}
          >
            {loading === 'lottery' ? 'מגריל...' : '🎲 הפעל הגרלה'}
          </button>
        </div>
      )}

      {/* LEAGUE SETTINGS */}
      {tab === 'league' && (
        <div className="card">
          <h2 className="font-bold mb-4">הגדרות ליגה</h2>
          <div className="flex flex-col gap-4">
            <div>
              <label className="block text-sm font-medium mb-1.5">שם הליגה</label>
              <input className="input" value={leagueName} onChange={e => setLeagueName(e.target.value)} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1.5">מספר קבוצות</label>
                <input type="number" className="input text-center" value={numTeams} onChange={e => setNumTeams(Number(e.target.value))} min={2} max={20} dir="ltr" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">שחקנים לקבוצה</label>
                <input type="number" className="input text-center" value={playersPerTeam} onChange={e => setPlayersPerTeam(Number(e.target.value))} min={1} max={30} dir="ltr" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">תקציב ($)</label>
                <input type="number" className="input text-center" value={budgetPerTeam} onChange={e => setBudgetPerTeam(Number(e.target.value))} min={1} dir="ltr" />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1.5">סיסמת הליגה</label>
              <div className="flex gap-2">
                <input
                  className="input text-center font-bold tracking-widest uppercase flex-1"
                  placeholder="ABC123"
                  value={joinCode}
                  onChange={e => setJoinCode(e.target.value.toUpperCase())}
                  maxLength={10}
                  dir="ltr"
                />
                <button type="button" className="btn btn-outline" onClick={generateCode}>
                  🎲 צור
                </button>
              </div>
              {joinCode && (
                <p className="text-xs mt-1.5" style={{ color: 'var(--muted)' }}>
                  שתף: שם הליגה <strong style={{ color: 'var(--primary)' }}>{leagueName}</strong> + סיסמה <strong style={{ color: 'var(--primary)' }}>{joinCode}</strong>
                </p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium mb-1.5">תאריך ושעת תחילת הדראפט</label>
              <input
                type="datetime-local"
                className="input"
                value={draftStartTime}
                min={new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)}
                onChange={e => setDraftStartTime(e.target.value)}
                dir="ltr"
              />
              <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
                יוצג שעון ספירה לאחור בדאשבורד עד לזמן זה
              </p>
            </div>

            <button className="btn btn-primary" onClick={saveLeague} disabled={loading === 'league'}>
              {loading === 'league' ? 'שומר...' : 'שמור הגדרות'}
            </button>
          </div>

          <div className="mt-6 pt-6" style={{ borderTop: '1px solid var(--border)' }}>
            <h2 className="font-bold mb-3">הוסף מנהל ליגה</h2>
            <p className="text-xs mb-3" style={{ color: 'var(--muted)' }}>
              המשתמש חייב להיות רשום במערכת לפני ההוספה.
            </p>
            <div className="flex gap-2">
              <input
                className="input flex-1"
                type="email"
                placeholder="אימייל המנהל"
                value={adminEmail}
                onChange={e => setAdminEmail(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addAdmin()}
                dir="ltr"
              />
              <button
                className="btn btn-primary"
                onClick={addAdmin}
                disabled={!adminEmail.trim() || loading === 'add_admin'}
              >
                {loading === 'add_admin' ? '...' : 'הוסף'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
