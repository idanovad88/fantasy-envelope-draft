import { createAdminClient } from '@/lib/supabase/server'

/**
 * Idempotent server-side clock tick for an open-outcry draft.
 *
 * Runs `open_draft_tick()` in Postgres, which does two things: freezes or thaws
 * the league's deadlines around pauses and night hours, then closes any auction
 * whose deadline has passed (writing a `timeout` pass row for every team that
 * never answered) to its current leader.
 *
 * The every-minute `open-draft-tick` pg_cron job is what actually keeps a draft
 * moving; this exists so a page load shows settled state instead of an auction
 * that visibly expired up to a minute ago. Same arrangement as
 * {@link import('./auctions').activateOverduePendingAuctions}.
 *
 * Safe to call on every request: it no-ops unless something is due.
 */
export async function settleOpenDraft(leagueId: string): Promise<void> {
  const admin = createAdminClient()
  const { error } = await admin.rpc('open_draft_tick', { p_league_id: leagueId })
  // Never fail a page render over the clock — the cron will catch up. Surfacing
  // it in the runtime log is what makes a stuck tick findable at all, since the
  // cron itself reports `succeeded` even when a league throws.
  if (error) console.error('settleOpenDraft failed', leagueId, error.message)
}
