'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { formatDateTime, formatTime } from '@/lib/utils'
import type { League, Team, Auction } from '@/types'
import ImportPlayers from './ImportPlayers'

type PastAuction = { id: string; scheduled_start: string; winning_bid: number | null; player: { name: string } | null; winning_team: { name: string } | null }
type ScheduledAuction = { id: string; scheduled_start: string; reveal_time: string; player: { name: string } | null }

interface Props {
  initialTab?: 'overview' | 'teams' | 'auction' | 'players' | 'lottery' | 'league'
  league: League | null
  teams: Team[]
  activeAuction: (Auction & { player: { name: string }; bids: { id: string }[] }) | null
  scheduledAuctions: ScheduledAuction[]
  players: { id: string; name: string; status: string; ranking: number | null; position: string | null }[]
  pastAuctions: PastAuction[]
  leagueCreators: string[]
  adminUserIds: string[]
  currentUserId: string
}

export default function AdminPanel({ initialTab = 'overview', league, teams, activeAuction, scheduledAuctions, players, pastAuctions, leagueCreators, adminUserIds, currentUserId }: Props) {
  const supabase = createClient()
  const [tab, setTab] = useState<'overview' | 'teams' | 'auction' | 'players' | 'lottery' | 'league'>(initialTab)
  const [loading, setLoading] = useState('')
  const [msg, setMsg] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [deletingTeamId, setDeletingTeamId] = useState<string | null>(null)
  const [localTeams, setLocalTeams] = useState(teams)
  const [localAdminIds, setLocalAdminIds] = useState<string[]>(adminUserIds)
  const [togglingAdminTeamId, setTogglingAdminTeamId] = useState<string | null>(null)
  const [adminTeamName, setAdminTeamName] = useState('')
  const [joiningDraft, setJoiningDraft] = useState(false)
  const [uploadingAvatarTeamId, setUploadingAvatarTeamId] = useState<string | null>(null)
  const [localVarGifUrl, setLocalVarGifUrl] = useState<string | null>(league?.var_gif_url ?? null)

  const adminHasTeam = localTeams.some(t => t.user_id === currentUserId)

  async function uploadTeamAvatar(teamId: string, file: File) {
    setUploadingAvatarTeamId(teamId)
    const formData = new FormData()
    formData.append('file', file)
    formData.append('teamId', teamId)
    const res = await fetch('/api/admin/upload-team-avatar', { method: 'POST', body: formData })
    const json = await res.json()
    if (json.error) { setMsg('שגיאה: ' + json.error); setUploadingAvatarTeamId(null); return }
    setLocalTeams(prev => prev.map(t => t.id === teamId ? { ...t, avatar_url: json.url } : t))
    setMsg('תמונה עודכנה!')
    setUploadingAvatarTeamId(null)
  }

  async function uploadVarGif(file: File) {
    if (!league) return
    setLoading('var_gif')
    const formData = new FormData()
    formData.append('file', file)
    formData.append('leagueId', league.id)
    const res = await fetch('/api/admin/upload-var-gif', { method: 'POST', body: formData })
    const json = await res.json()
    if (json.error) { setMsg('שגיאה: ' + json.error) }
    else { setLocalVarGifUrl(json.url); setMsg('גיף ה-VAR עודכן!') }
    setLoading('')
  }

  // League settings state
  const [leagueName, setLeagueName] = useState(league?.name ?? 'פנטזי דראפט 25-26')
  const [numTeams, setNumTeams] = useState(league?.num_teams ?? 12)
  const [playersPerTeam, setPlayersPerTeam] = useState(league?.players_per_team ?? 13)
  const [budgetPerTeam, setBudgetPerTeam] = useState(league?.budget_per_team ?? 200)
  const [joinCode, setJoinCode] = useState(league?.join_code ?? '')
  const [auctionDurationHours, setAuctionDurationHours] = useState(league?.auction_duration_hours ?? 1.5)
  const SLOT_TYPES = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UTIL', 'BENCH'] as const
  const [rosterSlots, setRosterSlots] = useState<Record<string, number>>(
    league?.roster_slots ?? {}
  )
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

  // League creator whitelist state
  const [creatorEmail, setCreatorEmail] = useState('')

  // Reveal time edit state
  const [newRevealTime, setNewRevealTime] = useState(() => {
    if (!activeAuction?.reveal_time) return ''
    return new Date(activeAuction.reveal_time).toISOString().slice(0, 16)
  })

  // Auction nomination state
  const [selectedPlayer, setSelectedPlayer] = useState('')
  const [playerSearch, setPlayerSearch] = useState('')
  const [showPlayerResults, setShowPlayerResults] = useState(false)
  const [selectedNominator, setSelectedNominator] = useState('')
  const [nominationTime, setNominationTime] = useState(() => {
    const revealTimes: string[] = []
    if (activeAuction?.reveal_time) revealTimes.push(activeAuction.reveal_time)
    scheduledAuctions.forEach(a => revealTimes.push(a.reveal_time))
    if (revealTimes.length > 0) {
      const latest = revealTimes.reduce((max, t) => t > max ? t : max, revealTimes[0])
      return new Date(latest).toISOString().slice(0, 16)
    }
    const d = new Date()
    d.setMinutes(0, 0, 0)
    return d.toISOString().slice(0, 16)
  })

  const availablePlayers = players.filter(p => p.status === 'available')

  async function toggleTeamAdmin(teamId: string, teamUserId: string, grant: boolean) {
    setTogglingAdminTeamId(teamId)
    const res = await fetch('/api/admin/set-team-admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, grant }),
    })
    const json = await res.json()
    if (!res.ok) { setMsg('שגיאה: ' + json.error); setTogglingAdminTeamId(null); return }
    setLocalAdminIds(prev => grant ? [...prev, teamUserId] : prev.filter(id => id !== teamUserId))
    setTogglingAdminTeamId(null)
  }

  async function joinDraftAsAdmin(e: React.FormEvent) {
    e.preventDefault()
    if (!league || !adminTeamName.trim()) return
    setJoiningDraft(true)
    const res = await fetch('/api/join-league', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        leagueName: league.name,
        joinCode: league.join_code ?? '',
        teamName: adminTeamName.trim(),
      }),
    })
    const json = await res.json()
    if (!res.ok) { setMsg('שגיאה: ' + json.error); setJoiningDraft(false); return }
    setMsg('הצטרפת לדראפט!')
    window.location.reload()
  }

  async function deleteTeam(teamId: string, teamName: string) {
    if (!confirm(`למחוק את הקבוצה "${teamName}"? הפעולה בלתי הפיכה.`)) return
    setDeletingTeamId(teamId)
    const res = await fetch('/api/admin/delete-team', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId }),
    })
    const json = await res.json()
    if (!res.ok) { setMsg('שגיאה: ' + json.error); setDeletingTeamId(null); return }
    setLocalTeams(prev => prev.filter(t => t.id !== teamId))
    setDeletingTeamId(null)
    setMsg(`הקבוצה "${teamName}" נמחקה`)
  }

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

  async function removeAllPlayers() {
    if (!league) return
    const availableCount = players.filter(p => p.status === 'available').length
    if (availableCount === 0) { setMsg('אין שחקנים זמינים להסרה'); return }
    if (!confirm(`למחוק את כל ${availableCount} השחקנים הזמינים? לא ניתן לבטל פעולה זו.`)) return
    setLoading('remove_all')
    await supabase.from('players').delete().eq('league_id', league.id).eq('status', 'available')
    setMsg(`${availableCount} שחקנים הוסרו`)
    setLoading('')
    window.location.reload()
  }

  async function addCreator() {
    if (!creatorEmail.trim()) return
    setLoading('add_creator')
    const { error } = await supabase.from('league_creator_whitelist').insert({ email: creatorEmail.trim().toLowerCase() })
    if (error) setMsg('שגיאה: ' + error.message)
    else { setMsg('מייל נוסף לרשימה'); setCreatorEmail('') }
    setLoading('')
    window.location.reload()
  }

  async function removeCreator(email: string) {
    if (!confirm(`להסיר ${email} מהרשימה?`)) return
    await supabase.from('league_creator_whitelist').delete().eq('email', email)
    setMsg('מייל הוסר')
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
      auction_duration_hours: auctionDurationHours,
      roster_slots: Object.keys(rosterSlots).length > 0 ? rosterSlots : null,
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

  async function runNominationLottery() {
    if (!league) return
    setLoading('lottery_nomination')
    const approvedTeams = teams.filter(t => t.approved && !t.is_complete)
    const shuffled = [...approvedTeams].sort(() => Math.random() - 0.5)
    const updates = shuffled.map((t, i) =>
      supabase.from('teams').update({ priority_rank: i + 1, updated_at: new Date().toISOString() }).eq('id', t.id)
    )
    await Promise.all(updates)
    setMsg('הגרלת סדר העלאות בוצעה!')
    setLoading('')
    window.location.reload()
  }

  async function runTiebreakLottery() {
    if (!league) return
    setLoading('lottery_tiebreak')
    const approvedTeams = teams.filter(t => t.approved && !t.is_complete)
    const shuffled = [...approvedTeams].sort(() => Math.random() - 0.5)
    const updates = shuffled.map((t, i) =>
      supabase.from('teams').update({ tiebreak_rank: i + 1, updated_at: new Date().toISOString() }).eq('id', t.id)
    )
    await Promise.all(updates)
    setMsg('הגרלת סדר פריוריטי בוצעה!')
    setLoading('')
    window.location.reload()
  }

  async function nominatePlayer() {
    if (!league || !selectedPlayer || !selectedNominator) return

    const revealTimes: Date[] = []
    if (activeAuction?.reveal_time) revealTimes.push(new Date(activeAuction.reveal_time))
    scheduledAuctions.forEach(a => revealTimes.push(new Date(a.reveal_time)))

    const hasExisting = revealTimes.length > 0
    const scheduledStart = new Date(nominationTime + ':00')

    if (hasExisting) {
      const latestReveal = new Date(Math.max(...revealTimes.map(d => d.getTime())))
      if (scheduledStart < latestReveal) {
        setMsg(`שעת הפתיחה חייבת להיות אחרי ${formatDateTime(latestReveal.toISOString())}`)
        return
      }
    }

    setLoading('nominate')

    const durationHours = league.auction_duration_hours ?? 1.5
    const revealTime = new Date(scheduledStart.getTime() + durationHours * 60 * 60 * 1000)

    const existingCount = await supabase.from('auctions').select('id', { count: 'exact' }).eq('league_id', league.id)
    const slotNum = (existingCount.count ?? 0) + 1
    const auctionStatus = scheduledStart > new Date() ? 'pending' : 'active'

    const { error: auctionErr } = await supabase.from('auctions').insert({
      league_id: league.id,
      player_id: selectedPlayer,
      nominating_team_id: selectedNominator || null,
      slot_number: slotNum,
      scheduled_start: scheduledStart.toISOString(),
      reveal_time: revealTime.toISOString(),
      status: auctionStatus,
    })

    if (!auctionErr) {
      await supabase.from('players').update({ status: 'on_auction' }).eq('id', selectedPlayer)
      setMsg(hasExisting
        ? `מכרז תוזמן לפתיחה ב-${formatDateTime(scheduledStart.toISOString())}`
        : 'שחקן הועלה למכרז!')
      setSelectedPlayer('')
    } else {
      setMsg('שגיאה: ' + auctionErr.message)
    }
    setLoading('')
    window.location.reload()
  }

  async function updateRevealTime() {
    if (!activeAuction || !newRevealTime) return
    setLoading('reveal_time')
    const { error } = await supabase
      .from('auctions')
      .update({ reveal_time: new Date(newRevealTime).toISOString(), updated_at: new Date().toISOString() })
      .eq('id', activeAuction.id)
    if (error) setMsg('שגיאה: ' + error.message)
    else setMsg('זמן הסגירה עודכן!')
    setLoading('')
    window.location.reload()
  }

  async function revealAuction(auctionId: string) {
    setLoading('reveal_' + auctionId)
    await supabase.rpc('resolve_auction', { p_auction_id: auctionId })
    // Activate next scheduled auction if its start time has arrived
    await fetch('/api/admin/activate-pending-auction', { method: 'POST' })
    setMsg('תוצאות נחשפו והשחקן הועבר לקבוצה הזוכה')
    setLoading('')
    window.location.reload()
  }

  async function deleteLeague() {
    if (!league) return
    if (!confirm(`למחוק לצמיתות את הליגה "${league.name}"?\n\nכל הקבוצות, השחקנים, המכרזים וההגדרות יימחקו ולא ניתן יהיה לשחזר אותם.`)) return
    const name = prompt(`כדי לאשר, הקלד את שם הליגה: ${league.name}`)
    if (name?.trim() !== league.name.trim()) { setMsg('שם הליגה שגוי — הפעולה בוטלה'); return }
    setLoading('delete_league')
    const res = await fetch('/api/admin/delete-league', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leagueId: league.id }),
    })
    const json = await res.json()
    if (!res.ok) { setMsg('שגיאה: ' + json.error); setLoading(''); return }
    window.location.href = '/leagues'
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
            onClick={() => { setTab(t.id); window.history.replaceState(null, '', `?tab=${t.id}`) }}
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

          {league && !adminHasTeam && (
            <div className="card">
              <h2 className="font-bold mb-1">הצטרפות לדראפט כשחקן</h2>
              <p className="text-sm mb-3" style={{ color: 'var(--muted)' }}>אתה מנהל הליגה — תוכל גם להשתתף עם קבוצה משלך.</p>
              <form onSubmit={joinDraftAsAdmin} className="flex gap-2">
                <input
                  className="input flex-1"
                  placeholder="שם הקבוצה שלך"
                  value={adminTeamName}
                  onChange={e => setAdminTeamName(e.target.value)}
                  required
                  maxLength={40}
                />
                <button type="submit" className="btn btn-primary" disabled={joiningDraft}>
                  {joiningDraft ? '...' : 'הצטרף'}
                </button>
              </form>
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
              <div className="mb-3">
                <p className="text-sm" style={{ color: 'var(--muted)' }}>
                  הצעות שהוגשו: <strong style={{ color: 'var(--text)' }}>
                    {((activeAuction as { bids?: unknown[] }).bids || []).length}
                  </strong>
                </p>
              </div>

              {/* Edit reveal time */}
              <div className="mb-4">
                <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--muted)' }}>שנה זמן סגירה</label>
                <div className="flex gap-2">
                  <input
                    type="datetime-local"
                    className="input text-sm flex-1"
                    value={newRevealTime}
                    onChange={e => setNewRevealTime(e.target.value)}
                    dir="ltr"
                  />
                  <button
                    className="btn btn-outline text-sm"
                    onClick={updateRevealTime}
                    disabled={!!loading || !newRevealTime}
                  >
                    {loading === 'reveal_time' ? '...' : 'עדכן'}
                  </button>
                </div>
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

          {/* Scheduled (pending) auctions queue */}
          {scheduledAuctions.length > 0 && (
            <div className="card" style={{ borderColor: 'var(--muted)', opacity: 0.9 }}>
              <h2 className="font-bold mb-3">⏰ תור מכרזים ({scheduledAuctions.length})</h2>
              <div className="flex flex-col gap-2">
                {scheduledAuctions.map((a, i) => (
                  <div key={a.id} className="flex items-center justify-between py-2 border-t text-sm" style={{ borderColor: 'var(--border)' }}>
                    <div>
                      <span className="font-medium">{i + 1}. {a.player?.name ?? '—'}</span>
                      <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
                        פתיחה: {formatDateTime(a.scheduled_start)} · סגירה: {formatDateTime(a.reveal_time)}
                      </p>
                    </div>
                    <button
                      className="text-xs px-2 py-1 rounded flex-shrink-0"
                      style={{ color: 'var(--danger)', border: '1px solid var(--danger)' }}
                      onClick={() => cancelAuction(a.id)}
                      disabled={!!loading}
                    >
                      {loading === 'cancel_' + a.id ? '...' : '✕'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Nominate new player */}
          <div className="card">
            <h2 className="font-bold mb-4">
              {activeAuction || scheduledAuctions.length > 0 ? 'הוסף לתור המכרזים' : 'העלה שחקן חדש למכרז'}
            </h2>

            <div className="flex flex-col gap-3">
              {/* Player search */}
              <div>
                <label className="block text-sm font-medium mb-1.5">שחקן</label>
                {selectedPlayer ? (
                  <div className="flex items-center gap-2">
                    <div className="input flex-1 text-sm" style={{ background: 'rgba(99,102,241,0.08)', color: 'var(--primary)', fontWeight: 500 }}>
                      {(() => {
                        const p = availablePlayers.find(p => p.id === selectedPlayer)
                        return p ? `${p.ranking ? `#${p.ranking} ` : ''}${p.name}` : '—'
                      })()}
                    </div>
                    <button
                      type="button"
                      className="btn btn-outline text-sm flex-shrink-0"
                      onClick={() => { setSelectedPlayer(''); setPlayerSearch('') }}
                    >
                      שנה
                    </button>
                  </div>
                ) : (
                  <div style={{ position: 'relative' }}>
                    <input
                      className="input"
                      placeholder="חפש לפי שם..."
                      value={playerSearch}
                      onChange={e => { setPlayerSearch(e.target.value); setShowPlayerResults(true) }}
                      onFocus={() => setShowPlayerResults(true)}
                      onBlur={() => setTimeout(() => setShowPlayerResults(false), 150)}
                      dir="rtl"
                    />
                    {showPlayerResults && (
                      <div
                        style={{
                          position: 'absolute', top: '100%', right: 0, left: 0, zIndex: 50,
                          background: 'var(--card)', border: '1px solid var(--border)',
                          borderRadius: '8px', maxHeight: '220px', overflowY: 'auto',
                          boxShadow: '0 4px 12px rgba(0,0,0,0.15)', marginTop: '4px',
                        }}
                      >
                        {availablePlayers
                          .filter(p => !playerSearch || p.name.toLowerCase().includes(playerSearch.toLowerCase()))
                          .slice(0, 30)
                          .map(p => (
                            <button
                              key={p.id}
                              type="button"
                              className="w-full text-right px-3 py-2 text-sm"
                              style={{ display: 'block', borderBottom: '1px solid var(--border)' }}
                              onMouseDown={() => { setSelectedPlayer(p.id); setPlayerSearch(''); setShowPlayerResults(false) }}
                            >
                              {p.ranking ? <span style={{ color: 'var(--muted)', marginLeft: '6px' }}>#{p.ranking}</span> : null}
                              {p.name}
                              {p.position ? <span style={{ color: 'var(--muted)', fontSize: '0.75rem', marginRight: '6px' }}>{p.position}</span> : null}
                            </button>
                          ))}
                        {availablePlayers.filter(p => !playerSearch || p.name.toLowerCase().includes(playerSearch.toLowerCase())).length === 0 && (
                          <p className="px-3 py-2 text-sm" style={{ color: 'var(--muted)' }}>לא נמצאו שחקנים</p>
                        )}
                      </div>
                    )}
                  </div>
                )}
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
                {(() => {
                  const allRevealTimes = [activeAuction?.reveal_time, ...scheduledAuctions.map(a => a.reveal_time)].filter(Boolean) as string[]
                  const latestReveal = allRevealTimes.length > 0
                    ? allRevealTimes.reduce((max, t) => t > max ? t : max, allRevealTimes[0])
                    : null
                  return (
                    <>
                      <input
                        type="datetime-local"
                        className="input"
                        value={nominationTime}
                        onChange={e => setNominationTime(e.target.value)}
                        dir="ltr"
                      />
                      {latestReveal && (
                        <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
                          לא לפני {formatDateTime(latestReveal)} (סיום המכרז הקודם)
                        </p>
                      )}
                    </>
                  )
                })()}
              </div>

              <button
                className="btn btn-primary"
                onClick={nominatePlayer}
                disabled={!selectedPlayer || !!loading || !league}
              >
                {loading === 'nominate' ? 'מעלה...' : (activeAuction || scheduledAuctions.length > 0) ? '⏰ הוסף לתור' : '🚀 העלה למכרז'}
              </button>
            </div>
          </div>

          {/* Past auctions — collapsible */}
          {pastAuctions.length > 0 && (
            <div className="card">
              <button
                className="flex items-center justify-between w-full text-right"
                onClick={() => setHistoryOpen(o => !o)}
              >
                <span className="font-bold">היסטוריית מכרזים ({pastAuctions.length})</span>
                <span style={{ color: 'var(--muted)', fontSize: '1.1rem' }}>{historyOpen ? '▲' : '▼'}</span>
              </button>
              {historyOpen && (
                <div className="flex flex-col gap-1 mt-3">
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
              )}
            </div>
          )}
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
              <div className="flex items-center gap-2">
                <input
                  className="input text-sm w-40"
                  placeholder="חיפוש..."
                  value={playerFilter}
                  onChange={e => setPlayerFilter(e.target.value)}
                  dir="ltr"
                />
                <button
                  className="btn btn-danger text-xs"
                  onClick={removeAllPlayers}
                  disabled={!!loading || players.filter(p => p.status === 'available').length === 0}
                >
                  {loading === 'remove_all' ? '...' : 'הסר הכל'}
                </button>
              </div>
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

          {league && <ImportPlayers leagueId={league.id} />}
        </div>
      )}

      {/* TEAMS */}
      {tab === 'teams' && (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-bold">ניהול קבוצות</h2>
            <a
              href="/api/admin/export-teams"
              download
              className="btn btn-outline text-sm"
            >
              ⬇ ייצא לאקסל
            </a>
          </div>
          <div className="flex flex-col gap-2">
            {localTeams.map(team => (
              <div key={team.id} className="flex items-center justify-between p-3 rounded-lg" style={{ background: 'var(--background)' }}>
                <div className="flex items-center gap-3">
                  {/* Team avatar */}
                  {team.avatar_url ? (
                    <img src={team.avatar_url} alt={team.name} style={{ width: 40, height: 40, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                  ) : (
                    <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', fontWeight: 700, color: 'var(--muted)', flexShrink: 0 }}>
                      {team.name[0]}
                    </div>
                  )}
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{team.name}</span>
                      {team.is_complete && <span className="badge badge-green text-xs">✅</span>}
                      {team.user_id && localAdminIds.includes(team.user_id) && <span className="badge badge-blue text-xs">מנהל</span>}
                    </div>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
                      {team.player_count} שחקנים · ${team.budget_remaining}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2 items-center">
                  {/* Upload avatar button */}
                  <label style={{ cursor: uploadingAvatarTeamId === team.id ? 'not-allowed' : 'pointer' }}>
                    <input
                      type="file"
                      accept="image/*"
                      style={{ display: 'none' }}
                      disabled={!!uploadingAvatarTeamId}
                      onChange={e => {
                        const file = e.target.files?.[0]
                        if (file) uploadTeamAvatar(team.id, file)
                        e.target.value = ''
                      }}
                    />
                    <span
                      className="btn btn-outline text-xs"
                      style={{ opacity: uploadingAvatarTeamId === team.id ? 0.5 : 1, pointerEvents: 'none' }}
                    >
                      {uploadingAvatarTeamId === team.id ? '...' : '📷'}
                    </span>
                  </label>
                  <button
                    className="btn text-xs"
                    style={{ background: 'var(--danger)', color: 'white', opacity: deletingTeamId === team.id ? 0.5 : 1 }}
                    disabled={deletingTeamId === team.id}
                    onClick={() => deleteTeam(team.id, team.name)}
                  >
                    {deletingTeamId === team.id ? '...' : 'מחק'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* LOTTERY */}
      {tab === 'lottery' && (
        <div className="flex flex-col gap-4">
          {/* Nomination order lottery */}
          <div className="card">
            <h2 className="font-bold mb-1">🎲 הגרלת סדר העלאות</h2>
            <p className="text-sm mb-3" style={{ color: 'var(--muted)' }}>
              קובע איזו קבוצה מעלה שחקן למכרז בכל תור. הסדר סימטרי וקבוע — כל קבוצה מקבלת תורה לפי הסדר.
            </p>
            <div className="mb-4 flex flex-col gap-1">
              {teams.filter(t => t.approved).sort((a, b) => (a.priority_rank ?? 999) - (b.priority_rank ?? 999)).map(t => (
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
              onClick={runNominationLottery}
              disabled={!!loading || !league || teams.filter(t => t.approved).length < 2}
            >
              {loading === 'lottery_nomination' ? 'מגריל...' : '🎲 הגרל סדר העלאות'}
            </button>
          </div>

          {/* Tiebreak priority lottery */}
          <div className="card">
            <h2 className="font-bold mb-1">🏆 הגרלת סדר פריוריטי</h2>
            <p className="text-sm mb-3" style={{ color: 'var(--muted)' }}>
              שובר שוויון בהצעות זהות. הקבוצה הגבוהה בסדר זוכה — ולאחר מכן יורדת לתחתית. הגרלה עצמאית מסדר העלאות.
            </p>
            <div className="mb-4 flex flex-col gap-1">
              {teams.filter(t => t.approved).sort((a, b) => (a.tiebreak_rank ?? 999) - (b.tiebreak_rank ?? 999)).map(t => (
                <div key={t.id} className="flex items-center justify-between text-sm px-3 py-2 rounded" style={{ background: 'var(--background)' }}>
                  <span>{t.name}</span>
                  <span className="badge badge-gray">
                    {t.tiebreak_rank ? `#${t.tiebreak_rank}` : 'ממתין'}
                  </span>
                </div>
              ))}
            </div>
            <button
              className="btn btn-primary w-full"
              onClick={runTiebreakLottery}
              disabled={!!loading || !league || teams.filter(t => t.approved).length < 2}
            >
              {loading === 'lottery_tiebreak' ? 'מגריל...' : '🏆 הגרל סדר פריוריטי'}
            </button>
          </div>

          {/* Activate league after both lotteries */}
          {league?.status === 'lottery' && (
            <div className="card" style={{ border: '1px solid var(--success)' }}>
              <h2 className="font-bold mb-1">הפעל ליגה</h2>
              <p className="text-sm mb-3" style={{ color: 'var(--muted)' }}>
                לאחר ביצוע שתי ההגרלות ניתן להפעיל את הדראפט.
              </p>
              {(!teams.some(t => t.priority_rank) || !teams.some(t => t.tiebreak_rank)) && (
                <p className="text-sm mb-3" style={{ color: 'var(--warning)' }}>
                  ⚠️ יש להגריל את שני הסדרים לפני ההפעלה
                </p>
              )}
              <button
                className="btn btn-success w-full"
                onClick={() => setLeagueStatus('active')}
                disabled={!!loading || !teams.some(t => t.priority_rank) || !teams.some(t => t.tiebreak_rank)}
              >
                {loading === 'status_active' ? 'מפעיל...' : '▶ הפעל דראפט'}
              </button>
            </div>
          )}
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
              <label className="block text-sm font-medium mb-1.5">משך מכרז (שעות)</label>
              <input
                type="number"
                className="input text-center"
                value={auctionDurationHours}
                onChange={e => setAuctionDurationHours(Number(e.target.value))}
                min={0.25}
                max={24}
                step={0.25}
                dir="ltr"
              />
              <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
                זמן הסגירה של כל מכרז — ברירת מחדל: 1.5 שעות (90 דקות)
              </p>
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

            <div>
              <label className="block text-sm font-medium mb-2">עמדות הרכב קבוצה</label>
              <div className="grid grid-cols-3 gap-2 mb-2">
                {SLOT_TYPES.map(slot => (
                  <div key={slot} className="flex items-center gap-2">
                    <span className="text-xs font-bold w-10 text-left" dir="ltr">{slot}</span>
                    <input
                      type="number"
                      className="input text-center"
                      style={{ padding: '4px 8px' }}
                      value={rosterSlots[slot] ?? 0}
                      min={0}
                      max={30}
                      dir="ltr"
                      onChange={e => {
                        const val = Math.max(0, Number(e.target.value))
                        setRosterSlots(prev => ({ ...prev, [slot]: val }))
                      }}
                    />
                  </div>
                ))}
              </div>
              {(() => {
                const total = SLOT_TYPES.reduce((sum, s) => sum + (rosterSlots[s] ?? 0), 0)
                const ok = total === playersPerTeam
                return (
                  <p className="text-xs" style={{ color: ok ? 'var(--success)' : 'var(--danger)' }}>
                    סה&quot;כ: {total} / {playersPerTeam} שחקנים{ok ? ' ✓' : ' — לא תואם לשחקנים לקבוצה'}
                  </p>
                )
              })()}
              <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
                G קולט PG/SG · F קולט SF/PF · UTIL קולט כל עמדה · BENCH מילוי
              </p>
            </div>

            {/* VAR GIF upload */}
            <div>
              <label className="block text-sm font-medium mb-2">גיף VAR (מוצג כשמכרז נחשף בפריוריטי)</label>
              {localVarGifUrl && (
                <div className="mb-2">
                  <img src={localVarGifUrl} alt="VAR GIF" style={{ height: 80, borderRadius: 8, border: '1px solid var(--border)' }} />
                </div>
              )}
              <label style={{ cursor: loading === 'var_gif' ? 'not-allowed' : 'pointer', display: 'inline-flex' }}>
                <input
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  disabled={loading === 'var_gif' || !league}
                  onChange={e => {
                    const file = e.target.files?.[0]
                    if (file) uploadVarGif(file)
                    e.target.value = ''
                  }}
                />
                <span className="btn btn-outline text-sm" style={{ opacity: loading === 'var_gif' ? 0.5 : 1, pointerEvents: 'none' }}>
                  {loading === 'var_gif' ? 'מעלה...' : localVarGifUrl ? '🔄 החלף גיף VAR' : '⬆️ העלה גיף VAR'}
                </span>
              </label>
              <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
                מוצג לפני הכרזת הזוכה כשיש הצעות שוות
              </p>
            </div>

            <button className="btn btn-primary" onClick={saveLeague} disabled={loading === 'league'}>
              {loading === 'league' ? 'שומר...' : 'שמור הגדרות'}
            </button>
          </div>

          <div className="mt-6 pt-6" style={{ borderTop: '1px solid var(--border)' }}>
            <h2 className="font-bold mb-3">הרשאות מנהל לקבוצות</h2>
            <div className="flex flex-col gap-2">
              {localTeams.filter(t => t.user_id && t.user_id !== currentUserId).map(team => (
                <div key={team.id} className="flex items-center justify-between px-3 py-2 rounded" style={{ background: 'var(--background)' }}>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{team.name}</span>
                    {team.user_id && localAdminIds.includes(team.user_id) && (
                      <span className="badge badge-blue text-xs">מנהל</span>
                    )}
                  </div>
                  {team.user_id && localAdminIds.includes(team.user_id) ? (
                    <button
                      className="btn text-xs"
                      style={{ background: 'var(--muted)', color: 'white', opacity: togglingAdminTeamId === team.id ? 0.5 : 1 }}
                      disabled={togglingAdminTeamId === team.id}
                      onClick={() => toggleTeamAdmin(team.id, team.user_id!, false)}
                    >
                      {togglingAdminTeamId === team.id ? '...' : 'בטל ניהול'}
                    </button>
                  ) : (
                    <button
                      className="btn text-xs"
                      style={{ background: 'var(--success)', color: 'white', opacity: togglingAdminTeamId === team.id ? 0.5 : 1 }}
                      disabled={togglingAdminTeamId === team.id}
                      onClick={() => toggleTeamAdmin(team.id, team.user_id!, true)}
                    >
                      {togglingAdminTeamId === team.id ? '...' : 'הענק ניהול'}
                    </button>
                  )}
                </div>
              ))}
              {localTeams.filter(t => t.user_id && t.user_id !== currentUserId).length === 0 && (
                <p className="text-sm" style={{ color: 'var(--muted)' }}>אין קבוצות אחרות בליגה</p>
              )}
            </div>
          </div>

          <div className="mt-6 pt-6" style={{ borderTop: '1px solid var(--border)' }}>
            <h2 className="font-bold mb-1">מורשים להקמת ליגה</h2>
            <p className="text-xs mb-3" style={{ color: 'var(--muted)' }}>
              מיילים ברשימה יוכלו להקים ליגה חדשה עצמאית.
            </p>
            {leagueCreators.length > 0 && (
              <div className="flex flex-col gap-1 mb-3">
                {leagueCreators.map(email => (
                  <div key={email} className="flex items-center justify-between px-3 py-2 rounded text-sm" style={{ background: 'var(--background)' }}>
                    <span dir="ltr">{email}</span>
                    <button
                      className="text-xs px-2 py-0.5 rounded"
                      style={{ color: 'var(--danger)', border: '1px solid var(--danger)' }}
                      onClick={() => removeCreator(email)}
                    >
                      הסר
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <input
                className="input flex-1"
                type="email"
                placeholder="אימייל להוספה"
                value={creatorEmail}
                onChange={e => setCreatorEmail(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addCreator()}
                dir="ltr"
              />
              <button
                className="btn btn-primary"
                onClick={addCreator}
                disabled={!creatorEmail.trim() || loading === 'add_creator'}
              >
                {loading === 'add_creator' ? '...' : 'הוסף'}
              </button>
            </div>
          </div>

          {league && league.created_by === currentUserId && (
            <div className="mt-6 pt-6" style={{ borderTop: '2px solid var(--danger)' }}>
              <h2 className="font-bold mb-1" style={{ color: 'var(--danger)' }}>אזור מסוכן</h2>
              <p className="text-sm mb-4" style={{ color: 'var(--muted)' }}>
                מחיקת הליגה תמחק לצמיתות את כל הקבוצות, השחקנים, המכרזים וההגדרות. פעולה זו בלתי הפיכה.
              </p>
              <button
                className="btn btn-danger"
                onClick={deleteLeague}
                disabled={loading === 'delete_league'}
              >
                {loading === 'delete_league' ? 'מוחק...' : '🗑 מחק ליגה'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
