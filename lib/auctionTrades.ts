import type { SupabaseClient } from '@supabase/supabase-js'
import { after } from 'next/server'
import { configureWebPush, sendPushToUsers } from '@/lib/push'
import type { ValidationResult } from '@/lib/trades'

/**
 * Trades in an auction draft (envelope + open outcry).
 *
 * Players only, the same number from each side, plus optional cash from either
 * side. What was paid at auction stays paid — only the cash moves a budget.
 *
 * This is the pre-check shown to the user at propose / accept time. The
 * authoritative check is execute_auction_trade() in Postgres, which re-runs
 * all of it under row locks when the admin approves.
 */

export const AUCTION_DRAFT_TYPES = ['envelope', 'open'] as const

export function isAuctionDraft(draftType: string | null | undefined) {
  return draftType === 'envelope' || draftType === 'open'
}

export type AuctionTradeInput = {
  leagueId: string
  proposingTeamId: string
  targetTeamId: string
  /** Players the proposing team gives. */
  proposingPlayerIds: string[]
  /** Players the target team gives. */
  targetPlayerIds: string[]
  cashFromTeamId: string | null
  cashAmount: number
  /**
   * The team whose own sealed envelope bids may count towards its floor. The
   * other team's floor ignores them, so a probing proposal cannot reveal what
   * that team has bid. The admin-time check in SQL counts both.
   */
  sealedFloorFor: string
}

export async function validateAuctionTrade(
  admin: SupabaseClient,
  input: AuctionTradeInput
): Promise<ValidationResult> {
  const { leagueId, proposingTeamId, targetTeamId, proposingPlayerIds, targetPlayerIds, cashFromTeamId, sealedFloorFor } = input
  const cashAmount = input.cashAmount

  if (proposingTeamId === targetTeamId) return { ok: false, error: 'לא ניתן לסחור עם אותה קבוצה' }

  const { data: league } = await admin
    .from('leagues').select('id, draft_type, status, auction_trades_enabled')
    .eq('id', leagueId).maybeSingle()
  if (!league) return { ok: false, error: 'ליגה לא נמצאה' }
  if (!isAuctionDraft(league.draft_type)) return { ok: false, error: 'ליגה זו אינה דראפט אוקשן' }
  if (!league.auction_trades_enabled) return { ok: false, error: 'טריידים כבויים בליגה זו' }
  if (league.status !== 'active' && league.status !== 'paused') {
    return { ok: false, error: 'טריידים אפשריים רק בזמן הדראפט' }
  }

  if (!Number.isInteger(cashAmount) || cashAmount < 0) return { ok: false, error: 'סכום כסף לא תקין' }
  if (cashAmount > 0 && cashFromTeamId !== proposingTeamId && cashFromTeamId !== targetTeamId) {
    return { ok: false, error: 'הכסף חייב לעבור בין שתי הקבוצות שבטרייד' }
  }

  if (proposingPlayerIds.length === 0 || targetPlayerIds.length === 0) {
    return { ok: false, error: 'כל צד חייב לתת לפחות שחקן אחד' }
  }
  if (proposingPlayerIds.length !== targetPlayerIds.length) {
    return { ok: false, error: `כל צד חייב לתת אותו מספר שחקנים (${proposingPlayerIds.length} מול ${targetPlayerIds.length})` }
  }
  const allIds = [...proposingPlayerIds, ...targetPlayerIds]
  if (new Set(allIds).size !== allIds.length) return { ok: false, error: 'שחקן נכלל פעמיים' }

  const { data: teams } = await admin
    .from('teams').select('id, name, approved, budget_remaining')
    .eq('league_id', leagueId).in('id', [proposingTeamId, targetTeamId])
  const teamById = new Map((teams ?? []).map(t => [t.id as string, t]))
  const proposing = teamById.get(proposingTeamId)
  const target = teamById.get(targetTeamId)
  if (!proposing?.approved || !target?.approved) return { ok: false, error: 'אחת הקבוצות אינה חלק מהליגה' }

  const { data: players } = await admin
    .from('players').select('id, name, status, drafted_by_team_id')
    .eq('league_id', leagueId).in('id', allIds)
  const playerById = new Map((players ?? []).map(p => [p.id as string, p]))
  const checkSide = (ids: string[], owner: string): string | null => {
    for (const id of ids) {
      const p = playerById.get(id)
      if (!p) return 'שחקן לא נמצא'
      if (p.status !== 'drafted' || p.drafted_by_team_id !== owner) return `${p.name} אינו שייך לקבוצה`
    }
    return null
  }
  const sideErr = checkSide(proposingPlayerIds, proposingTeamId) ?? checkSide(targetPlayerIds, targetTeamId)
  if (sideErr) return { ok: false, error: sideErr }

  // Budget: only the cash changes a budget. The floor is $1 per empty slot
  // plus what live bids already commit (auction_trade_budget_floor()).
  if (cashAmount > 0) {
    const payer = teamById.get(cashFromTeamId!)!
    const { data: floor, error } = await admin.rpc('auction_trade_budget_floor', {
      p_team_id: payer.id,
      p_include_sealed: payer.id === sealedFloorFor,
    })
    if (error) return { ok: false, error: error.message }
    const remaining = (payer.budget_remaining as number) - cashAmount
    if (remaining < (floor as number)) {
      const who = payer.id === sealedFloorFor ? 'לך' : `ל${payer.name}`
      return {
        ok: false,
        error: `${who} לא יישאר מספיק תקציב: $${remaining} אחרי הטרייד, צריך לפחות $${floor} (דולר לכל מקום פנוי בסגל והצעות פתוחות)`,
      }
    }
  }

  return { ok: true }
}

/** Rebuild the validation input of a stored trade, for the accept-time re-check. */
export async function storedAuctionTradeInput(
  admin: SupabaseClient,
  trade: { id: string; league_id: string; proposing_team_id: string; target_team_id: string; cash_from_team_id: string | null; cash_amount: number },
  sealedFloorFor: string
): Promise<AuctionTradeInput> {
  const { data: assets } = await admin.from('trade_assets').select('from_team_id, player_id').eq('trade_id', trade.id)
  const rows = (assets ?? []) as { from_team_id: string; player_id: string | null }[]
  return {
    leagueId: trade.league_id,
    proposingTeamId: trade.proposing_team_id,
    targetTeamId: trade.target_team_id,
    proposingPlayerIds: rows.filter(a => a.from_team_id === trade.proposing_team_id && a.player_id).map(a => a.player_id!),
    targetPlayerIds: rows.filter(a => a.from_team_id === trade.target_team_id && a.player_id).map(a => a.player_id!),
    cashFromTeamId: trade.cash_from_team_id,
    cashAmount: trade.cash_amount ?? 0,
    sealedFloorFor,
  }
}

/** owner + assistant of each team. */
export async function teamManagerIds(admin: SupabaseClient, teamIds: string[]): Promise<string[]> {
  const { data } = await admin.from('teams').select('user_id, assistant_user_id').in('id', teamIds)
  const ids = new Set<string>()
  for (const t of data ?? []) {
    if (t.user_id) ids.add(t.user_id as string)
    if (t.assistant_user_id) ids.add(t.assistant_user_id as string)
  }
  return [...ids]
}

/** The league's admins: admin_users rows for the league, plus its creator. */
export async function leagueAdminIds(admin: SupabaseClient, leagueId: string): Promise<string[]> {
  const [{ data: rows }, { data: league }] = await Promise.all([
    admin.from('admin_users').select('user_id').eq('league_id', leagueId),
    admin.from('leagues').select('created_by').eq('id', leagueId).maybeSingle(),
  ])
  const ids = new Set<string>((rows ?? []).map(r => r.user_id as string))
  if (league?.created_by) ids.add(league.created_by as string)
  return [...ids]
}

/**
 * Push after the response has gone out. A failed push never fails the action
 * it reports on — the dashboard card is the source of truth.
 */
export function pushTradeUpdate(
  resolveUserIds: () => Promise<string[]>,
  tradeId: string,
  title: string,
  body: string,
  url: string,
  excludeUserId?: string
) {
  after(async () => {
    try {
      if (!configureWebPush()) return
      const ids = (await resolveUserIds()).filter(id => id !== excludeUserId)
      // A day: an offer nobody saw by then is on the dashboard anyway.
      await sendPushToUsers(ids, { title, body, url, tag: `trade-${tradeId}` }, 24 * 60 * 60)
    } catch (err) {
      console.error('[trades] push failed:', err)
    }
  })
}
