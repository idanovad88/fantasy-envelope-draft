import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizePlayerName } from '@/lib/utils'

/**
 * Players an admin has deliberately removed from a league.
 *
 * The nightly `/api/cron/top-up-pools` sweep adds whatever the pool has gained
 * since a league was seeded. Without this it would also add back everything an
 * admin had trimmed out — the live league went from 474 players to 317 by hand
 * on 2026-09-11, and a dry run of the job showed it about to restore all 157
 * the next morning, silently. A deletion is a decision, and the timer has to
 * be able to see it.
 *
 * Keys are `normalizePlayerName()`, computed here rather than in SQL so the
 * code that writes a key and the code that matches against it are the same
 * one, and a table with RLS on and no policies keeps the whole thing
 * service-role only.
 *
 * ⚠️ Deliberately *not* consulted by the manual "add missing" path. An admin
 * pasting a list and confirming a dry run is overruling an earlier decision on
 * purpose; that path clears the exclusion instead, so the name stays.
 */

/** Every excluded name key for a league. */
export async function loadExclusions(
  supabase: SupabaseClient,
  leagueId: string
): Promise<Set<string>> {
  const keys = new Set<string>()
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('league_player_exclusions').select('name_key')
      .eq('league_id', leagueId).range(from, from + 999)
    if (error) {
      // A league on a database where the migration has not been applied yet
      // must not break deleting or importing players. It does mean the nightly
      // job would re-add trimmed players, which is why the cron route treats
      // this as fatal rather than carrying on — see its own handling.
      throw new Error(error.message)
    }
    if (!data?.length) break
    for (const r of data) keys.add(r.name_key as string)
    if (data.length < 1000) break
  }
  return keys
}

/**
 * Records names as removed from a league. Called after a successful delete.
 *
 * Never throws: failing to remember an exclusion must not fail the delete the
 * admin actually asked for. The cost of a miss is one player reappearing on a
 * later sweep, which they can delete again.
 */
export async function recordExclusions(
  supabase: SupabaseClient,
  leagueId: string,
  names: string[]
): Promise<void> {
  if (!names.length) return
  const rows = [...new Map(
    names.filter(Boolean).map(n => [normalizePlayerName(n), { league_id: leagueId, name_key: normalizePlayerName(n), name: n }])
  ).values()]
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabase
      .from('league_player_exclusions')
      .upsert(rows.slice(i, i + 200), { onConflict: 'league_id,name_key', ignoreDuplicates: true })
    if (error) {
      console.error('[exclusions] could not record removals', error.message)
      return
    }
  }
}

/**
 * Forgets exclusions for names that are being added back deliberately.
 *
 * Without this, an admin who removed a player and later re-added him by hand
 * would find the nightly job treating him as excluded forever — harmless while
 * he is in the league, and a trap the day he is removed for an unrelated
 * reason. Never throws, for the same reason as above.
 */
export async function clearExclusions(
  supabase: SupabaseClient,
  leagueId: string,
  names: string[]
): Promise<void> {
  if (!names.length) return
  const keys = [...new Set(names.filter(Boolean).map(normalizePlayerName))]
  for (let i = 0; i < keys.length; i += 100) {
    const { error } = await supabase
      .from('league_player_exclusions')
      .delete().eq('league_id', leagueId).in('name_key', keys.slice(i, i + 100))
    if (error) {
      console.error('[exclusions] could not clear removals', error.message)
      return
    }
  }
}
