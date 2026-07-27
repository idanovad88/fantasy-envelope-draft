import { createAdminClient } from '@/lib/supabase/server'

/**
 * Idempotent server-side pending → active flip for envelope auctions.
 *
 * An auction queued with a future `scheduled_start` stays `pending` until
 * something notices its start time has passed. Nothing does so on a timer, so
 * this runs opportunistically: on auction-page loads, on the admin's reveal
 * action, and every minute from the notify cron.
 *
 * Scoped per league and guarded by the "one active auction at a time" rule —
 * activating a second auction while one is live would let two sealed bids run
 * concurrently.
 *
 * Safe to call on every request: it no-ops unless a transition is due.
 * Returns true if an auction was activated.
 */
export async function activateOverduePendingAuctions(leagueId: string): Promise<boolean> {
  const admin = createAdminClient()
  const now = new Date().toISOString()

  const [{ data: alreadyActive }, { data: overdue }] = await Promise.all([
    admin.from('auctions').select('id').eq('league_id', leagueId).eq('status', 'active').limit(1).maybeSingle(),
    admin.from('auctions').select('id, player_id').eq('league_id', leagueId).eq('status', 'pending')
      .lte('scheduled_start', now).order('scheduled_start', { ascending: true }).limit(1).maybeSingle(),
  ])

  if (alreadyActive || !overdue) return false

  // The status filter guards against a race with a concurrent activation.
  const { data: claimed } = await admin
    .from('auctions')
    .update({ status: 'active' })
    .eq('id', overdue.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle()

  if (!claimed) return false

  await admin.from('players').update({ status: 'on_auction' }).eq('id', overdue.player_id)
  return true
}

/**
 * Runs {@link activateOverduePendingAuctions} for every league that currently
 * has an overdue pending auction. Used by the notify cron, which has no single
 * league context.
 */
export async function activateAllOverduePendingAuctions(): Promise<number> {
  const admin = createAdminClient()
  const now = new Date().toISOString()

  const { data: overdue } = await admin
    .from('auctions')
    .select('league_id')
    .eq('status', 'pending')
    .lte('scheduled_start', now)

  const leagueIds = [...new Set((overdue ?? []).map(a => a.league_id as string))]

  let activated = 0
  for (const leagueId of leagueIds) {
    if (await activateOverduePendingAuctions(leagueId)) activated++
  }
  return activated
}
