import { createAdminClient } from '@/lib/supabase/server'

/**
 * Idempotent server-side auto-start for snake and open-outcry drafts.
 *
 * When the league's `draft_start_time` has passed and the order lottery has
 * been run, flips `status` from setup/lottery → active so that any page load
 * (including the DraftCountdown refresh when it hits zero) starts the draft
 * automatically. Without this, such a league stays stuck in `setup` forever —
 * nothing else transitions it to `active`.
 *
 * Envelope leagues are excluded: they are started by the admin and their
 * auctions carry their own schedule.
 *
 * Mirrors the per-auction auto-activation in app/(app)/auction/page.tsx.
 * Safe to call on every request: it no-ops unless the transition is due.
 */
export async function activateOverdueSnakeDraft(leagueId: string): Promise<void> {
  const admin = createAdminClient()

  const { data: league } = await admin
    .from('leagues')
    .select('id, draft_type, status, draft_start_time')
    .eq('id', leagueId)
    .maybeSingle()

  if (!league) return
  if (!['snake', 'open'].includes(league.draft_type)) return
  if (!['setup', 'lottery'].includes(league.status)) return
  if (!league.draft_start_time) return
  if (new Date(league.draft_start_time).getTime() > Date.now()) return

  // Never start a draft with no pick order — the order lottery must have run.
  const { count } = await admin
    .from('teams')
    .select('id', { count: 'exact', head: true })
    .eq('league_id', leagueId)
    .eq('approved', true)
    .not('priority_rank', 'is', null)

  if (!count) return

  // The status filter guards against a race with a concurrent activation.
  await admin
    .from('leagues')
    .update({ status: 'active', updated_at: new Date().toISOString() })
    .eq('id', leagueId)
    .in('status', ['setup', 'lottery'])
}
