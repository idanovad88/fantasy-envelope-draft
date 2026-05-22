import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { formatTime, formatDateTime } from '@/lib/utils'
import type { League, Team, Auction } from '@/types'
import DraftCountdown from '@/components/DraftCountdown'
import BidForm from '@/components/BidForm'
import RealtimeRefresher from '@/components/RealtimeRefresher'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const [{ data: league }, { data: myTeam }, { data: featuredAuction }, { data: teams }] =
    await Promise.all([
      supabase.from('leagues').select('*').order('created_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('teams').select('*').eq('user_id', user!.id).maybeSingle(),
      // Active auction first (earliest scheduled_start = active), otherwise soonest pending
      supabase.from('auctions')
        .select('*, player:players(*), nominating_team:teams!nominating_team_id(name)')
        .in('status', ['active', 'pending'])
        .order('scheduled_start', { ascending: true })
        .limit(1)
        .maybeSingle(),
      supabase.from('teams').select('*').order('priority_rank', { ascending: true, nullsFirst: false }),
    ])

  const myTeamId = (myTeam as Team | null)?.id
  const typedFeatured = featuredAuction as (Auction & { player: { name: string }; nominating_team: { name: string } | null }) | null
  const isActive = typedFeatured?.status === 'active'

  const { data: myActiveBid } = myTeamId && isActive && typedFeatured?.id
    ? await supabase.from('bids').select('amount').eq('auction_id', typedFeatured.id).eq('team_id', myTeamId).maybeSingle()
    : { data: null }

  const typedLeague = league as League | null
  const typedMyTeam = myTeam as Team | null
  const typedTeams = (teams || []) as Team[]

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1">
          {typedLeague ? typedLeague.name : 'פנטזי דראפט מעטפות 🏀'}
        </h1>
        {typedLeague && (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            <span>{typedTeams.filter(t => t.approved).length}/{typedLeague.num_teams} הצטרפו</span>
            {typedTeams.filter(t => !t.approved).length > 0 && (
              <span style={{ color: 'var(--warning)' }}> · {typedTeams.filter(t => !t.approved).length} ממתינים לאישור</span>
            )}
            {typedTeams.filter(t => t.is_complete).length > 0 && (
              <span> · {typedTeams.filter(t => t.is_complete).length} השלימו דראפט</span>
            )}
          </p>
        )}
      </div>

      <div className={`grid gap-4 ${typedFeatured && isActive ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-2'}`}>
        {/* Current / upcoming auction card */}
        <div className="card">
          <h2 className="font-bold mb-3">מכרז נוכחי</h2>
          {typedFeatured ? (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="font-bold text-2xl">{typedFeatured.player?.name}</span>
                {isActive
                  ? <span className="badge badge-green">פעיל</span>
                  : <span className="badge badge-gray">⏰ מתוזמן</span>
                }
              </div>
              {isActive ? (
                <p className="text-sm mb-3" style={{ color: 'var(--muted)' }}>
                  חשיפה: {formatTime(typedFeatured.reveal_time)}
                </p>
              ) : (
                <p className="text-sm mb-3" style={{ color: 'var(--muted)' }}>
                  פתיחת הגשות: {formatDateTime(typedFeatured.scheduled_start)}
                </p>
              )}
              {isActive && typedMyTeam && typedLeague && !typedMyTeam.is_complete ? (
                <BidForm
                  auctionId={typedFeatured.id}
                  team={typedMyTeam}
                  league={typedLeague}
                  existingBid={myActiveBid?.amount}
                  revealTime={typedFeatured.reveal_time}
                />
              ) : (
                <Link href="/auction" className="btn btn-outline w-full text-sm">
                  לוח המכרזים
                </Link>
              )}
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
              <div className="grid grid-cols-2 gap-3 mt-3">
                <div className="text-center p-3 rounded-lg" style={{ background: 'var(--background)' }}>
                  <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>תקציב</p>
                  <p className="font-bold text-lg" style={{ color: 'var(--success)' }}>
                    ${typedMyTeam.budget_remaining}
                  </p>
                </div>
                <div className="text-center p-3 rounded-lg" style={{ background: 'var(--background)' }}>
                  <p className="text-xs mb-0.5" style={{ color: 'var(--muted)' }}>שחקנים</p>
                  <p className="font-bold text-lg">
                    {typedMyTeam.player_count}/{typedLeague?.players_per_team ?? '—'}
                  </p>
                </div>
              </div>
              <Link href="/teams" className="btn btn-outline w-full mt-3 text-sm">
                צפה בקבוצה
              </Link>
            </div>
          ) : (
            <div className="text-center py-6">
              <p className="text-3xl mb-3">🏀</p>
              <p className="font-medium mb-4">ברוך הבא!</p>
              <div className="flex flex-col gap-2">
                <Link href="/join" className="btn btn-primary">הצטרף לליגה קיימת</Link>
                <Link href="/create-league" className="btn btn-outline">הקם ליגה חדשה</Link>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Draft countdown — shown when draft hasn't started yet */}
      {typedLeague?.draft_start_time && ['setup', 'lottery'].includes(typedLeague.status) && (
        <DraftCountdown targetDate={typedLeague.draft_start_time} />
      )}

      {typedLeague && <RealtimeRefresher leagueId={typedLeague.id} />}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
        {/* Nomination order */}
        <div className="card">
          <h2 className="font-bold mb-1">סדר העלאות</h2>
          <p className="text-xs mb-3" style={{ color: 'var(--muted)' }}>מי מעלה שחקן למכרז עכשיו</p>
          {typedTeams.filter(t => !t.is_complete && t.priority_rank !== null).length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--muted)' }}>הגרלה טרם בוצעה</p>
          ) : (
            <div className="flex flex-col gap-1">
              {typedTeams
                .filter(t => !t.is_complete && t.priority_rank !== null)
                .sort((a, b) => (a.priority_rank ?? 99) - (b.priority_rank ?? 99))
                .map((team, i) => {
                  const isFirst = i === 0
                  const isMe = team.user_id === user?.id
                  return (
                    <div key={team.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm"
                      style={{
                        background: isMe ? 'rgba(99,102,241,0.1)' : isFirst ? 'rgba(234,179,8,0.08)' : 'var(--background)',
                        border: isMe ? '1px solid rgba(99,102,241,0.3)' : isFirst ? '1px solid rgba(234,179,8,0.25)' : '1px solid transparent',
                      }}>
                      <span className="font-bold w-5 text-center" style={{ color: isFirst ? 'var(--warning)' : 'var(--muted)' }}>{i + 1}</span>
                      <span className="font-medium flex-1">{team.name}</span>
                      {isFirst && <span className="badge badge-yellow text-xs">הבא</span>}
                      {isMe && <span className="badge badge-blue text-xs">אתה</span>}
                    </div>
                  )
                })}
            </div>
          )}
        </div>

        {/* Tiebreak priority order */}
        <div className="card">
          <h2 className="font-bold mb-1">סדר פריוריטי</h2>
          <p className="text-xs mb-3" style={{ color: 'var(--muted)' }}>מי זוכה בהצעות שוות</p>
          {typedTeams.filter(t => t.tiebreak_rank !== null).length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--muted)' }}>הגרלה טרם בוצעה</p>
          ) : (
            <div className="flex flex-col gap-1">
              {typedTeams
                .filter(t => t.tiebreak_rank !== null)
                .sort((a, b) => (a.tiebreak_rank ?? 99) - (b.tiebreak_rank ?? 99))
                .map((team, i) => {
                  const isFirst = i === 0
                  const isMe = team.user_id === user?.id
                  return (
                    <div key={team.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm"
                      style={{
                        background: isMe ? 'rgba(99,102,241,0.1)' : 'var(--background)',
                        border: isMe ? '1px solid rgba(99,102,241,0.3)' : '1px solid transparent',
                      }}>
                      <span className="font-bold w-5 text-center" style={{ color: isFirst ? 'var(--success)' : 'var(--muted)' }}>{i + 1}</span>
                      <span className="font-medium flex-1">{team.name}</span>
                      {team.is_complete && <span className="badge badge-gray text-xs">הושלם</span>}
                      {isMe && <span className="badge badge-blue text-xs">אתה</span>}
                    </div>
                  )
                })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
