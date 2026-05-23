import { createClient } from '@/lib/supabase/server'
import { cookies } from 'next/headers'
import PlayerSearch from '@/components/PlayerSearch'
import type { Player, League, Team } from '@/types'
import { formatTime } from '@/lib/utils'

export const dynamic = 'force-dynamic'
export const revalidate = 0

type PlayerWithTeam = Player & { drafting_team: { id: string; name: string } | null }

export default async function PlayersPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const cookieStore = await cookies()
  const selectedLeagueId = cookieStore.get('selected_league_id')?.value

  const { data: myTeam } = selectedLeagueId
    ? await supabase.from('teams').select('league_id').eq('user_id', user!.id).eq('league_id', selectedLeagueId).maybeSingle()
    : await supabase.from('teams').select('league_id').eq('user_id', user!.id).order('created_at', { ascending: false }).limit(1).maybeSingle()

  const [{ data: adminRow }, { data: createdLeague }] = await Promise.all([
    supabase.from('admin_users').select('league_id').eq('user_id', user!.id).maybeSingle(),
    supabase.from('leagues').select('id').eq('created_by', user!.id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ])

  const leagueId = selectedLeagueId ?? myTeam?.league_id ?? adminRow?.league_id ?? createdLeague?.id ?? null

  const { data: league } = leagueId
    ? await supabase.from('leagues').select('*').eq('id', leagueId).maybeSingle()
    : { data: null }

  const [{ data: players }, { data: activeAuction }, { data: pendingAuctions }] =
    await Promise.all([
      league
        ? supabase.from('players')
            .select('*, drafting_team:teams!drafted_by_team_id(id, name)')
            .eq('league_id', league.id)
            .order('ranking', { ascending: true, nullsFirst: false })
        : Promise.resolve({ data: [] }),
      league
        ? supabase.from('auctions').select('id, player_id').eq('league_id', league.id).eq('status', 'active').maybeSingle()
        : Promise.resolve({ data: null }),
      league
        ? supabase.from('auctions').select('id, player_id, scheduled_start').eq('league_id', league.id).eq('status', 'pending').order('scheduled_start', { ascending: true })
        : Promise.resolve({ data: [] }),
    ])

  const typedLeague = league as League | null
  const typedPlayers = (players || []) as PlayerWithTeam[]

  const activeAuctionPlayerId = (activeAuction as { player_id?: string } | null)?.player_id ?? null
  const pendingPlayerIds = new Set((pendingAuctions || []).map((a: { player_id: string }) => a.player_id))
  const pendingStartByPlayerId = Object.fromEntries(
    (pendingAuctions || []).map((a: { player_id: string; scheduled_start: string }) => [a.player_id, a.scheduled_start])
  )

  const available = typedPlayers.filter(p => p.status === 'available')
  const onAuction = typedPlayers.filter(p => p.status === 'on_auction')
  const drafted = typedPlayers.filter(p => p.status === 'drafted')

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">שחקנים</h1>
        <div className="flex gap-2 text-sm">
          <span className="badge badge-green">{available.length} זמינים</span>
          {onAuction.filter(p => p.id === activeAuctionPlayerId).length > 0 && (
            <span className="badge badge-yellow">{onAuction.filter(p => p.id === activeAuctionPlayerId).length} במכרז</span>
          )}
          {onAuction.filter(p => pendingPlayerIds.has(p.id)).length > 0 && (
            <span className="badge badge-gray">{onAuction.filter(p => pendingPlayerIds.has(p.id)).length} מתוזמן</span>
          )}
          <span className="badge badge-gray">{drafted.length} נרכשו</span>
        </div>
      </div>

      {/* Status banner — draft not active */}
      {typedLeague && typedLeague.status !== 'active' && (
        <div className="card mb-4" style={{ borderColor: 'var(--border)' }}>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            הדראפט טרם החל — כפתורי ההעלאה יופיעו כשהדראפט יהיה פעיל.
          </p>
        </div>
      )}

      {/* Active / scheduled auction highlight */}
      {onAuction.map(p => {
        const isPending = pendingPlayerIds.has(p.id)
        const pendingStart = pendingStartByPlayerId[p.id]
        return (
          <div key={p.id} className="card mb-4" style={{ borderColor: isPending ? 'var(--muted)' : 'var(--warning)', borderWidth: 2 }}>
            <span className={`badge ${isPending ? 'badge-gray' : 'badge-yellow'} mb-2`}>
              {isPending && pendingStart
                ? `מתוזמן — יפתח ב-${formatTime(pendingStart)}`
                : 'במכרז עכשיו'}
            </span>
            <p className="font-bold text-xl">{p.name}</p>
            <p className="text-sm" style={{ color: 'var(--muted)' }}>{p.position} · {p.nba_team}</p>
          </div>
        )
      })}

      {/* Available players */}
      <PlayerSearch
        players={available.map(p => ({ id: p.id, name: p.name, position: p.position, nba_team: p.nba_team, ranking: p.ranking }))}
      />

      {/* Drafted players */}
      {drafted.length > 0 && (
        <div className="card mt-4">
          <h2 className="font-bold mb-3" style={{ color: 'var(--muted)' }}>נרכשו ({drafted.length})</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
                  <th className="text-right pb-2">שחקן</th>
                  <th className="text-right pb-2 w-14">מחיר</th>
                  <th className="text-right pb-2">קבוצה</th>
                </tr>
              </thead>
              <tbody>
                {drafted.map(p => (
                  <tr key={p.id} className="border-t" style={{ borderColor: 'var(--border)', opacity: 0.65 }}>
                    <td className="py-2">
                      <div className="flex items-center gap-2">
                        {p.position && (
                          <span className="badge badge-gray text-xs w-8 text-center flex-shrink-0">{p.position}</span>
                        )}
                        <span className="font-medium" dir="ltr">{p.name}</span>
                      </div>
                    </td>
                    <td className="py-2 font-bold" style={{ color: 'var(--danger)' }}>
                      ${p.draft_price}
                    </td>
                    <td className="py-2 font-medium" style={{ color: 'var(--success)' }}>
                      {p.drafting_team?.name ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
