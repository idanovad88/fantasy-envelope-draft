import { createClient } from '@/lib/supabase/server'
import NominateButton from '@/components/NominateButton'
import type { Player, League, Team } from '@/types'

export const dynamic = 'force-dynamic'

type PlayerWithTeam = Player & { drafting_team: { id: string; name: string } | null }

export default async function PlayersPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const [{ data: players }, { data: league }, { data: myTeamRow }, { data: allTeams }, { data: activeAuction }, { data: adminRow }] =
    await Promise.all([
      supabase.from('players')
        .select('*, drafting_team:teams!drafted_by_team_id(id, name)')
        .order('ranking', { ascending: true, nullsFirst: false }),
      supabase.from('leagues').select('*').order('created_at', { ascending: false }).limit(1).maybeSingle(),
      user
        ? supabase.from('teams').select('*').eq('user_id', user.id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      supabase.from('teams')
        .select('id, priority_rank')
        .eq('approved', true)
        .eq('is_complete', false)
        .not('priority_rank', 'is', null)
        .order('priority_rank', { ascending: true }),
      supabase.from('auctions').select('id').eq('status', 'active').maybeSingle(),
      user
        ? supabase.from('admin_users').select('role').eq('user_id', user.id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ])

  const typedLeague = league as League | null
  const typedMyTeam = myTeamRow as Team | null
  const typedPlayers = (players || []) as PlayerWithTeam[]

  const isAdmin = !!adminRow
  const currentNominatorId = allTeams?.[0]?.id ?? null
  const isMyTurn = !!typedMyTeam && typedMyTeam.id === currentNominatorId && !typedMyTeam.is_complete
  const canNominate = (isMyTurn || isAdmin) && typedLeague?.status === 'active' && !activeAuction && !!currentNominatorId

  const available = typedPlayers.filter(p => p.status === 'available')
  const onAuction = typedPlayers.filter(p => p.status === 'on_auction')
  const drafted = typedPlayers.filter(p => p.status === 'drafted')

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">שחקנים</h1>
        <div className="flex gap-2 text-sm">
          <span className="badge badge-green">{available.length} זמינים</span>
          {onAuction.length > 0 && <span className="badge badge-yellow">{onAuction.length} במכרז</span>}
          <span className="badge badge-gray">{drafted.length} נרכשו</span>
        </div>
      </div>

      {/* Status / turn banners */}
      {typedLeague && typedLeague.status !== 'active' && typedMyTeam && (
        <div className="card mb-4" style={{ borderColor: 'var(--border)' }}>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            הדראפט טרם החל — כפתורי ההעלאה יופיעו כשהדראפט יהיה פעיל.
          </p>
        </div>
      )}
      {canNominate && (
        <div className="card mb-4" style={{ borderColor: 'var(--success)', background: 'rgba(34,197,94,0.08)' }}>
          <p className="font-bold" style={{ color: 'var(--success)' }}>
            זה התורך! לחץ + ליד שחקן להעלאה למכרז ב-$1
          </p>
        </div>
      )}
      {isMyTurn && !canNominate && activeAuction && (
        <div className="card mb-4" style={{ borderColor: 'var(--warning)' }}>
          <p className="text-sm" style={{ color: 'var(--warning)' }}>
            זה התורך — אך יש מכרז פעיל כרגע. המתן לסיומו.
          </p>
        </div>
      )}

      {/* Active auction highlight */}
      {onAuction.map(p => (
        <div key={p.id} className="card mb-4" style={{ borderColor: 'var(--warning)', borderWidth: 2 }}>
          <span className="badge badge-yellow mb-2">במכרז עכשיו</span>
          <p className="font-bold text-xl">{p.name}</p>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>{p.position} · {p.nba_team}</p>
        </div>
      ))}

      {/* Available players */}
      <div className="card">
        <h2 className="font-bold mb-3">שחקנים זמינים ({available.length})</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
                <th className="text-right pb-2 pr-2 w-8">#</th>
                <th className="text-right pb-2">שחקן</th>
                <th className="pb-2 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {available.map((p, i) => (
                <tr key={p.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="py-2 pr-2" style={{ color: 'var(--muted)' }}>{p.ranking ?? i + 1}</td>
                  <td className="py-2">
                    <div className="flex items-center gap-2" dir="ltr">
                      {p.position && (
                        <span style={{ background: 'rgba(99,102,241,0.2)', color: 'var(--primary)', fontSize: '11px', padding: '1px 5px', borderRadius: '4px', flexShrink: 0, minWidth: 28, textAlign: 'center' }}>
                          {p.position}
                        </span>
                      )}
                      <span className="font-medium">{p.name}</span>
                    </div>
                  </td>
                  <td className="py-1 pl-1">
                    {canNominate && typedLeague ? (
                      <NominateButton
                        playerId={p.id}
                        leagueId={typedLeague.id}
                        playerName={p.name}
                      />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

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
