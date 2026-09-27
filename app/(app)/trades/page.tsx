import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'
import { cookies } from 'next/headers'
import RealtimeRefresher from '@/components/RealtimeRefresher'
import TradeCenter, { type TeamAssets, type TradeView, type AssetLabel } from '@/components/TradeCenter'
import type { League, Team, Trade, TradeAsset } from '@/types'
import { buildPickOverridesMap, getFuturePickNumbersForTeam, describePick } from '@/lib/utils'
import { activateOverdueSnakeDraft } from '@/lib/activateDraft'
import TradeInbox from '@/components/TradeInbox'
import { loadAuctionTradeViews, sideSummary } from '@/lib/auctionTradeViews'
import { formatDateTime } from '@/lib/utils'

export const dynamic = 'force-dynamic'
export const revalidate = 0

type DraftedPlayer = { id: string; name: string; position: string | null; drafted_by_team_id: string | null; status: string }

export default async function TradesPage() {
  const supabase = await createClient()
  const user = await getAuthUser(supabase)

  const cookieStore = await cookies()
  const selectedLeagueId = cookieStore.get('selected_league_id')?.value

  const { data: myTeamRow } = selectedLeagueId
    ? await supabase.from('teams').select('*').eq('user_id', user!.id).eq('league_id', selectedLeagueId).maybeSingle()
    : await supabase.from('teams').select('*').eq('user_id', user!.id).order('created_at', { ascending: false }).limit(1).maybeSingle()

  const myTeam = myTeamRow as Team | null
  const leagueId = selectedLeagueId ?? myTeam?.league_id ?? null

  if (leagueId) await activateOverdueSnakeDraft(leagueId)

  const { data: leagueRow } = leagueId
    ? await supabase.from('leagues').select('*').eq('id', leagueId).maybeSingle()
    : { data: null }
  const league = leagueRow as League | null

  if (league && (league.draft_type === 'envelope' || league.draft_type === 'open')) {
    return <AuctionTrades league={league} myTeam={myTeam} />
  }

  if (!league || league.draft_type !== 'snake') {
    return <Shell><p className="text-sm" style={{ color: 'var(--muted)' }}>אין ליגה נבחרת.</p></Shell>
  }
  if (!myTeam) {
    return <Shell><p className="text-sm" style={{ color: 'var(--muted)' }}>אין לך קבוצה בליגה זו.</p></Shell>
  }

  const [{ data: teams }, { data: players }, { data: snakePicks }, { data: overrideRows }, { data: tradeRows }] =
    await Promise.all([
      supabase.from('teams').select('*').eq('league_id', league.id).eq('approved', true).not('priority_rank', 'is', null).order('priority_rank', { ascending: true }),
      supabase.from('players').select('id, name, position, drafted_by_team_id, status').eq('league_id', league.id).eq('status', 'drafted'),
      supabase.from('snake_picks').select('id', { count: 'exact' }).eq('league_id', league.id),
      supabase.from('pick_overrides').select('overall_pick_number, owner_team_id').eq('league_id', league.id),
      supabase.from('trades').select('*, assets:trade_assets(*)').eq('league_id', league.id).order('created_at', { ascending: false }),
    ])

  const typedTeams = (teams || []) as Team[]
  const draftedPlayers = (players || []) as DraftedPlayer[]
  const overridesMap = buildPickOverridesMap(overrideRows as { overall_pick_number: number; owner_team_id: string }[] | null)
  const config = league.snake_round_config as boolean[] | null

  const completedCount = snakePicks?.length ?? 0
  const totalPicks = league.num_teams * league.players_per_team
  const isActive = league.status === 'active'

  const teamNameById = new Map(typedTeams.map(t => [t.id, t.name]))
  const playerNameById = new Map(draftedPlayers.map(p => [p.id, p.name]))

  // Build the tradeable-asset catalog for every team.
  const catalog: Record<string, TeamAssets> = {}
  for (const t of typedTeams) {
    const pickNums = getFuturePickNumbersForTeam(
      t.id, completedCount, totalPicks, league.num_teams, typedTeams, config, overridesMap, isActive
    )
    catalog[t.id] = {
      teamId: t.id,
      teamName: t.name,
      picks: pickNums.map(n => {
        const { round, pickInRound } = describePick(n, league.num_teams)
        return { overall_pick_number: n, round, pickInRound }
      }),
      players: draftedPlayers
        .filter(p => p.drafted_by_team_id === t.id)
        .map(p => ({ id: p.id, name: p.name, position: p.position })),
    }
  }

  // Build display views for existing trades.
  const labelFor = (a: TradeAsset): AssetLabel => {
    if (a.asset_type === 'pick' && a.overall_pick_number != null) {
      const { round, pickInRound } = describePick(a.overall_pick_number, league.num_teams)
      return { type: 'pick', label: `סיבוב ${round}, בחירה ${pickInRound} (#${a.overall_pick_number})` }
    }
    return { type: 'player', label: a.player_id ? (playerNameById.get(a.player_id) ?? 'שחקן') : 'שחקן' }
  }

  // Assets tied up in OPEN trades — cannot be offered again (no overlap).
  // Read with the service role: RLS hides other teams' open offers from this
  // user, and only the keys leave this function, never who offered what.
  const { data: openTradeRows } = await createAdminClient()
    .from('trades').select('assets:trade_assets(asset_type, overall_pick_number, player_id)')
    .eq('league_id', league.id).in('status', ['pending_target', 'pending_admin'])
  const lockedKeys = new Set<string>()
  for (const tr of (openTradeRows || []) as unknown as { assets: TradeAsset[] }[]) {
    for (const a of tr.assets ?? []) {
      if (a.asset_type === 'pick' && a.overall_pick_number != null) lockedKeys.add(`pick:${a.overall_pick_number}`)
      else if (a.asset_type === 'player' && a.player_id) lockedKeys.add(`player:${a.player_id}`)
    }
  }

  const tradeViews: TradeView[] = ((tradeRows || []) as (Trade & { assets: TradeAsset[] })[]).map(tr => {
    const assets = tr.assets ?? []
    return {
      id: tr.id,
      status: tr.status,
      note: tr.note,
      rejection_reason: tr.rejection_reason,
      created_at: tr.created_at,
      proposingTeamId: tr.proposing_team_id,
      targetTeamId: tr.target_team_id,
      proposingName: teamNameById.get(tr.proposing_team_id) ?? '—',
      targetName: teamNameById.get(tr.target_team_id) ?? '—',
      proposingGives: assets.filter(a => a.from_team_id === tr.proposing_team_id).map(labelFor),
      targetGives: assets.filter(a => a.from_team_id === tr.target_team_id).map(labelFor),
    }
  })

  return (
    <Shell>
      <RealtimeRefresher leagueId={league.id} />
      <TradeCenter
        leagueId={league.id}
        myTeamId={myTeam.id}
        teams={typedTeams.map(t => ({ id: t.id, name: t.name }))}
        catalog={catalog}
        trades={tradeViews}
        lockedKeys={[...lockedKeys]}
      />
    </Shell>
  )
}

async function AuctionTrades({ league, myTeam }: { league: League; myTeam: Team | null }) {
  if (!league.auction_trades_enabled) {
    return <Shell><p className="text-sm" style={{ color: 'var(--muted)' }}>מנהל הליגה לא הפעיל טריידים בליגה זו.</p></Shell>
  }

  const supabase = await createClient()
  // RLS returns approved trades plus the caller's own.
  const trades = await loadAuctionTradeViews(supabase, league.id)
  const approved = trades.filter(t => t.status === 'approved')
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  const running = league.status === 'active' || league.status === 'paused'

  return (
    <Shell>
      <RealtimeRefresher leagueId={league.id} />
      <div className="flex flex-col gap-4">
        {running && (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            כדי להציע טרייד: טאב <b>קבוצות</b> ← לחץ על שחקן של קבוצה אחרת.
          </p>
        )}

        {myTeam && <TradeInbox myTeamId={myTeam.id} trades={trades} showHistory title="הטריידים שלי" />}

        <div className="card">
          <h2 className="font-bold text-lg mb-3">טריידים שבוצעו בליגה</h2>
          {approved.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--muted)' }}>עדיין לא בוצעו טריידים</p>
          ) : (
            <div className="flex flex-col gap-2">
              {approved.map(t => (
                <div key={t.id} className="rounded-lg p-3" style={{ background: 'var(--background)', border: '1px solid var(--border)' }}>
                  <p className="text-xs mb-2" style={{ color: 'var(--muted)' }}>{formatDateTime(t.updated_at)}</p>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <Side name={t.proposingName} items={sideSummary(t, t.proposingTeamId)} />
                    <Side name={t.targetName} items={sideSummary(t, t.targetTeamId)} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Shell>
  )
}

function Side({ name, items }: { name: string; items: string[] }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium mb-1 truncate">{name} נתנו</p>
      {items.map((s, i) => <p key={i} className="truncate" dir="ltr" style={{ textAlign: 'right' }}>{s}</p>)}
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">טריידים</h1>
      {children}
    </div>
  )
}
