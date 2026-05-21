import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { formatTime } from '@/lib/utils'
import type { League, Team, Auction } from '@/types'
import DraftCountdown from '@/components/DraftCountdown'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const [{ data: league }, { data: myTeam }, { data: activeAuction }, { data: teams }] =
    await Promise.all([
      supabase.from('leagues').select('*').order('created_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('teams').select('*').eq('user_id', user!.id).maybeSingle(),
      supabase.from('auctions').select('*, player:players(*), nominating_team:teams!nominating_team_id(name)').eq('status', 'active').maybeSingle(),
      supabase.from('teams').select('*').order('priority_rank', { ascending: true, nullsFirst: false }),
    ])

  const typedLeague = league as League | null
  const typedMyTeam = myTeam as Team | null
  const typedActiveAuction = activeAuction as (Auction & { player: { name: string }; nominating_team: { name: string } | null }) | null
  const typedTeams = (teams || []) as Team[]

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">
        {typedLeague ? typedLeague.name : 'פנטזי דראפט מעטפות 🏀'}
      </h1>

      {/* Status banner */}
      {typedLeague && (
        <div className="card mb-6">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-sm" style={{ color: 'var(--muted)' }}>סטטוס ליגה</p>
              <p className="font-bold text-lg mt-0.5">
                {typedLeague.status === 'setup' && 'הגדרה'}
                {typedLeague.status === 'lottery' && 'הגרלת פריוריטי'}
                {typedLeague.status === 'active' && 'דראפט פעיל'}
                {typedLeague.status === 'paused' && 'דראפט מושהה'}
                {typedLeague.status === 'completed' && 'דראפט הסתיים'}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="text-center p-3 rounded-lg" style={{ background: 'var(--background)' }}>
              <p className="text-2xl font-bold">{typedTeams.filter(t => t.approved).length}/{typedLeague.num_teams}</p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>הצטרפו</p>
            </div>
            <div className="text-center p-3 rounded-lg" style={{ background: 'var(--background)' }}>
              <p className="text-2xl font-bold" style={{ color: 'var(--warning)' }}>{typedTeams.filter(t => !t.approved).length}</p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>ממתינות לאישור</p>
            </div>
            <div className="text-center p-3 rounded-lg" style={{ background: 'var(--background)' }}>
              <p className="text-2xl font-bold" style={{ color: 'var(--success)' }}>{typedTeams.filter(t => t.is_complete).length}</p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>השלימו דראפט</p>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Current auction card */}
        <div className="card">
          <h2 className="font-bold mb-3">מכרז נוכחי</h2>
          {typedActiveAuction ? (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="font-bold text-xl">{typedActiveAuction.player?.name}</span>
                <span className="badge badge-blue">פעיל</span>
              </div>
              <p className="text-sm mb-1" style={{ color: 'var(--muted)' }}>
                מועלה על ידי: {typedActiveAuction.nominating_team?.name ?? '—'}
              </p>
              <p className="text-sm mb-4" style={{ color: 'var(--muted)' }}>
                חשיפה: {formatTime(typedActiveAuction.reveal_time)}
              </p>
              <Link href="/auction" className="btn btn-primary w-full">
                הגש הצעה
              </Link>
            </div>
          ) : (
            <div className="text-center py-6" style={{ color: 'var(--muted)' }}>
              <p className="text-3xl mb-2">🏀</p>
              <p>אין מכרז פעיל כרגע</p>
              <Link href="/auction" className="btn btn-outline mt-3 text-sm">
                לוח המכרזים
              </Link>
            </div>
          )}
        </div>

        {/* My team card */}
        <div className="card">
          <h2 className="font-bold mb-3">הקבוצה שלי</h2>
          {typedMyTeam ? (
            <div>
              <p className="font-bold text-xl mb-1">{typedMyTeam.name}</p>
              <div className="grid grid-cols-3 gap-3 mt-3">
                <div className="text-center p-3 rounded-lg" style={{ background: 'var(--background)' }}>
                  <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>תקציב</p>
                  <p className="font-bold text-lg" style={{ color: 'var(--success)' }}>
                    ${typedMyTeam.budget_remaining}
                  </p>
                </div>
                <div className="text-center p-3 rounded-lg" style={{ background: 'var(--background)' }}>
                  <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>שחקנים</p>
                  <p className="font-bold text-lg">{typedMyTeam.player_count}</p>
                </div>
                <div className="text-center p-3 rounded-lg" style={{ background: 'var(--background)' }}>
                  <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>פריוריטי</p>
                  <p className="font-bold text-lg">
                    {typedMyTeam.priority_rank ?? (typedMyTeam.is_complete ? '✅' : '—')}
                  </p>
                </div>
              </div>
              <Link href="/teams" className="btn btn-outline w-full mt-3 text-sm">
                צפה בקבוצה
              </Link>
            </div>
          ) : (
            <div className="text-center py-6" style={{ color: 'var(--muted)' }}>
              <p>הקבוצה שלך טרם אושרה</p>
              <p className="text-sm mt-1">פנה לאדמין</p>
            </div>
          )}
        </div>
      </div>

      {/* Draft countdown — shown when draft hasn't started yet */}
      {typedLeague?.draft_start_time && ['setup', 'lottery'].includes(typedLeague.status) && (
        <DraftCountdown targetDate={typedLeague.draft_start_time} />
      )}

      {/* Priority table */}
      <div className="card mt-4">
        <h2 className="font-bold mb-3">טבלת פריוריטי</h2>
        {typedTeams.filter(t => !t.is_complete && t.priority_rank !== null).length === 0 ? (
          <p style={{ color: 'var(--muted)' }}>הגרלה טרם בוצעה</p>
        ) : (
          <div className="flex flex-col gap-1">
            {typedTeams
              .filter(t => !t.is_complete && t.priority_rank !== null)
              .sort((a, b) => (a.priority_rank ?? 99) - (b.priority_rank ?? 99))
              .map((team, i) => (
                <div
                  key={team.id}
                  className="flex items-center justify-between px-3 py-2 rounded-lg"
                  style={{
                    background: team.user_id === user?.id ? 'rgba(99,102,241,0.1)' : 'var(--background)',
                    border: team.user_id === user?.id ? '1px solid rgba(99,102,241,0.3)' : '1px solid transparent',
                  }}
                >
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-bold w-6 text-center" style={{ color: i === 0 ? 'var(--warning)' : 'var(--muted)' }}>
                      {team.priority_rank}
                    </span>
                    <span className="font-medium">{team.name}</span>
                    {team.user_id === user?.id && <span className="badge badge-blue text-xs">אתה</span>}
                  </div>
                  <div className="flex items-center gap-4 text-sm" style={{ color: 'var(--muted)' }}>
                    <span>{team.player_count} שחקנים</span>
                    <span style={{ color: 'var(--success)' }}>${team.budget_remaining}</span>
                  </div>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  )
}
