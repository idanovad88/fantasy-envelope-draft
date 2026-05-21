import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { formatTime } from '@/lib/utils'
import type { League, Team, Auction } from '@/types'
import DraftCountdown from '@/components/DraftCountdown'
import BidForm from '@/components/BidForm'

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

  const myTeamId = (myTeam as Team | null)?.id
  const { data: myActiveBid } = myTeamId && (activeAuction as Auction | null)?.id
    ? await supabase.from('bids').select('amount').eq('auction_id', (activeAuction as Auction).id).eq('team_id', myTeamId).maybeSingle()
    : { data: null }

  const typedLeague = league as League | null
  const typedMyTeam = myTeam as Team | null
  const typedActiveAuction = activeAuction as (Auction & { player: { name: string }; nominating_team: { name: string } | null }) | null
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

      <div className={`grid gap-4 ${typedActiveAuction ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-2'}`}>
        {/* Current auction card */}
        <div className="card">
          <h2 className="font-bold mb-3">מכרז נוכחי</h2>
          {typedActiveAuction ? (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="font-bold text-2xl">{typedActiveAuction.player?.name}</span>
                <span className="badge badge-green">פעיל</span>
              </div>
              <p className="text-sm mb-3" style={{ color: 'var(--muted)' }}>
                מועלה על ידי: {typedActiveAuction.nominating_team?.name ?? '—'} · חשיפה: {formatTime(typedActiveAuction.reveal_time)}
              </p>
              {typedMyTeam && typedLeague && !typedMyTeam.is_complete ? (
                <BidForm
                  auctionId={typedActiveAuction.id}
                  team={typedMyTeam}
                  league={typedLeague}
                  existingBid={myActiveBid?.amount}
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
        <h2 className="font-bold mb-3">סדר העלאות</h2>
        {typedTeams.filter(t => !t.is_complete && t.priority_rank !== null).length === 0 ? (
          <p style={{ color: 'var(--muted)' }}>הגרלה טרם בוצעה</p>
        ) : (
          <div className="flex flex-col gap-1">
            {typedTeams
              .filter(t => !t.is_complete && t.priority_rank !== null)
              .sort((a, b) => (a.priority_rank ?? 99) - (b.priority_rank ?? 99))
              .map((team, i, arr) => {
                const isFirst = i === 0
                const isLast = i === arr.length - 1
                const isMe = team.user_id === user?.id
                return (
                  <div
                    key={team.id}
                    className="flex items-center justify-between px-3 py-2 rounded-lg"
                    style={{
                      background: isMe ? 'rgba(99,102,241,0.1)' : isFirst ? 'rgba(234,179,8,0.08)' : 'var(--background)',
                      border: isMe ? '1px solid rgba(99,102,241,0.3)' : isFirst ? '1px solid rgba(234,179,8,0.3)' : '1px solid transparent',
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-bold w-6 text-center" style={{ color: isFirst ? 'var(--warning)' : 'var(--muted)' }}>
                        {i + 1}
                      </span>
                      <span className="font-medium">{team.name}</span>
                      {isFirst && <span className="badge badge-yellow text-xs">עולה הבא</span>}
                      {isLast && !isFirst && <span className="text-xs" style={{ color: 'var(--muted)' }}>העלה אחרון</span>}
                      {isMe && <span className="badge badge-blue text-xs">אתה</span>}
                    </div>
                    <div className="flex items-center gap-4 text-sm" style={{ color: 'var(--muted)' }}>
                      <span>{team.player_count} שחקנים</span>
                      <span style={{ color: 'var(--success)' }}>${team.budget_remaining}</span>
                    </div>
                  </div>
                )
              })}
          </div>
        )}
      </div>
    </div>
  )
}
