import type { SupabaseClient } from '@supabase/supabase-js'
import { resolvePickOwner, buildPickOverridesMap } from '@/lib/utils'
import type { Team } from '@/types'

export type TradeAssetInput = {
  from_team_id: string
  asset_type: 'pick' | 'player'
  overall_pick_number?: number | null
  player_id?: string | null
}

export type ValidationResult = { ok: true } | { ok: false; error: string }

/**
 * Validates a trade against the current league state. Used both when a trade is
 * proposed and again (re-validated) when the admin approves it, since ownership
 * may have changed in the meantime.
 *
 * Rules enforced:
 * - both teams belong to the league and are distinct
 * - count-neutral: each side gives the same number of assets (≥ 1) so roster
 *   sizes stay at players_per_team
 * - every pick is strictly future and currently owned by the stated from_team
 * - every player is currently drafted by the stated from_team
 */
export async function validateTrade(
  admin: SupabaseClient,
  opts: { leagueId: string; proposingTeamId: string; targetTeamId: string; assets: TradeAssetInput[]; excludeTradeId?: string }
): Promise<ValidationResult> {
  const { leagueId, proposingTeamId, targetTeamId, assets, excludeTradeId } = opts

  if (proposingTeamId === targetTeamId) return { ok: false, error: 'לא ניתן לסחור עם אותה קבוצה' }
  if (!Array.isArray(assets) || assets.length === 0) return { ok: false, error: 'הטרייד ריק' }

  const { data: league } = await admin.from('leagues').select('*').eq('id', leagueId).single()
  if (!league) return { ok: false, error: 'ליגה לא נמצאה' }
  if (league.draft_type !== 'snake') return { ok: false, error: 'ליגה זו אינה דראפט סנייק' }

  const { data: teams } = await admin
    .from('teams').select('*')
    .eq('league_id', leagueId).eq('approved', true)
    .not('priority_rank', 'is', null)
    .order('priority_rank', { ascending: true })
  const typedTeams = (teams || []) as Team[]
  const teamIds = new Set(typedTeams.map(t => t.id))
  if (!teamIds.has(proposingTeamId) || !teamIds.has(targetTeamId)) {
    return { ok: false, error: 'אחת הקבוצות אינה חלק מהליגה' }
  }

  const { count: completedCount } = await admin
    .from('snake_picks').select('id', { count: 'exact', head: true }).eq('league_id', leagueId)
  const completed = completedCount ?? 0
  const totalPicks = league.num_teams * league.players_per_team
  const isActive = league.status === 'active'
  const draftComplete = league.status === 'completed' || completed >= totalPicks
  const firstTradeable = isActive ? completed + 2 : completed + 1

  const { data: overrideRows } = await admin
    .from('pick_overrides').select('overall_pick_number, owner_team_id').eq('league_id', leagueId)
  const overrides = buildPickOverridesMap(overrideRows as { overall_pick_number: number; owner_team_id: string }[] | null)
  const config = (league.snake_round_config ?? null) as boolean[] | null

  // Assets already committed to other OPEN trades are locked — no overlap allowed.
  // (excludeTradeId skips the trade being re-validated at admin-approval time.)
  const { data: openTrades } = await admin
    .from('trades')
    .select('id, assets:trade_assets(asset_type, overall_pick_number, player_id)')
    .eq('league_id', leagueId)
    .in('status', ['pending_target', 'pending_admin'])
  const lockedPicks = new Set<number>()
  const lockedPlayers = new Set<string>()
  for (const t of (openTrades ?? []) as { id: string; assets: { asset_type: string; overall_pick_number: number | null; player_id: string | null }[] }[]) {
    if (excludeTradeId && t.id === excludeTradeId) continue
    for (const a of t.assets ?? []) {
      if (a.asset_type === 'pick' && a.overall_pick_number != null) lockedPicks.add(a.overall_pick_number)
      else if (a.asset_type === 'player' && a.player_id) lockedPlayers.add(a.player_id)
    }
  }

  if (assets.some(a => a.asset_type === 'pick') && draftComplete) {
    return { ok: false, error: 'הדראפט הסתיים — לא ניתן לסחור בבחירות' }
  }

  let fromProposing = 0
  let fromTarget = 0
  const seenPicks = new Set<number>()
  const seenPlayers = new Set<string>()

  for (const a of assets) {
    if (a.from_team_id !== proposingTeamId && a.from_team_id !== targetTeamId) {
      return { ok: false, error: 'נכס שייך לקבוצה שאינה חלק בטרייד' }
    }
    if (a.from_team_id === proposingTeamId) fromProposing++
    else fromTarget++

    if (a.asset_type === 'pick') {
      const n = a.overall_pick_number
      if (!n || n < 1) return { ok: false, error: 'מספר בחירה לא תקין' }
      if (seenPicks.has(n)) return { ok: false, error: `בחירה #${n} נכללת פעמיים` }
      seenPicks.add(n)
      if (n > totalPicks) return { ok: false, error: `בחירה #${n} מחוץ לטווח` }
      if (n < firstTradeable) return { ok: false, error: `בחירה #${n} כבר אינה עתידית` }
      const owner = resolvePickOwner(n, league.num_teams, typedTeams, config, overrides)
      if (!owner || owner.id !== a.from_team_id) {
        return { ok: false, error: `בחירה #${n} אינה בבעלות הקבוצה` }
      }
      if (lockedPicks.has(n)) return { ok: false, error: `בחירה #${n} כבר נמצאת בהצעת טרייד פתוחה` }
    } else if (a.asset_type === 'player') {
      const pid = a.player_id
      if (!pid) return { ok: false, error: 'מזהה שחקן חסר' }
      if (seenPlayers.has(pid)) return { ok: false, error: 'שחקן נכלל פעמיים' }
      seenPlayers.add(pid)
      const { data: player } = await admin
        .from('players').select('id, name, status, drafted_by_team_id')
        .eq('id', pid).eq('league_id', leagueId).maybeSingle()
      if (!player) return { ok: false, error: 'שחקן לא נמצא' }
      if (player.status !== 'drafted' || player.drafted_by_team_id !== a.from_team_id) {
        return { ok: false, error: `${player.name} אינו שייך לקבוצה` }
      }
      if (lockedPlayers.has(pid)) return { ok: false, error: `${player.name} כבר נמצא בהצעת טרייד פתוחה` }
    } else {
      return { ok: false, error: 'סוג נכס לא תקין' }
    }
  }

  if (fromProposing === 0 || fromTarget === 0) {
    return { ok: false, error: 'כל צד חייב לתת לפחות נכס אחד' }
  }
  if (fromProposing !== fromTarget) {
    return { ok: false, error: `כל צד חייב לתת אותו מספר נכסים (${fromProposing} מול ${fromTarget})` }
  }

  return { ok: true }
}
