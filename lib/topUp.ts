import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizePlayerName, matchPlayerName } from '@/lib/utils'

export type IncomingPlayer = {
  name: string
  position?: string | null
  ranking?: number | null
  auction_value?: number | null
}

export type TopUpResult = {
  inLeague: number
  inList: number
  willAdd: number
  names: string[]
  /** Rows actually written. 0 on a dry run. */
  added: number
}

/** Big enough to keep the round trips down, small enough to stay under any payload limit. */
const INSERT_CHUNK = 200

/**
 * Inserts the players from a list that a league does not have yet, and nothing
 * else.
 *
 * Shared by `/api/admin/add-missing-players` (an admin pasting a list) and
 * `/api/cron/top-up-pools` (the nightly sweep over every unfinished league).
 * One implementation on purpose: the nightly job writes to live drafts with
 * nobody watching, so it must behave exactly as the reviewed, dry-runnable
 * path an admin can see the output of first.
 *
 * It is the gap between the other two import routes. `/api/import-players`
 * inserts *everything* with `status: 'available'` and no dedupe, so re-running
 * it against a live league creates a second, undrafted copy of every player
 * already sold. `/api/admin/update-player-rankings` only ever UPDATEs, so a
 * player the league never had stays missing.
 *
 * Existing rows are never written to. A name that matches an existing player is
 * skipped whatever its position or rank says, so this can be pointed at the
 * whole pool as safely as at a handful of names — and running it twice adds
 * nothing the second time, which is what makes it safe on a timer.
 *
 * Matching runs in the same direction as `update-player-rankings`: over the
 * stored rows, against the keys of the incoming list. That direction is what
 * makes `matchPlayerName()`'s wildcard work — the corrupted names are the
 * stored ones (`Nikola Joki?`, from a Latin-1 CSV read as UTF-8), and matching
 * the other way round would re-add Jokić and Dončić as duplicates.
 *
 * @param supabase must be the service-role client; `players` has no policy for
 *   an admin INSERT from the browser.
 */
export async function topUpLeague(
  supabase: SupabaseClient,
  leagueId: string,
  players: IncomingPlayer[],
  opts: { dryRun?: boolean } = {}
): Promise<TopUpResult> {
  // Page around the 1000-row PostgREST cap. A truncated read here would look
  // like "those players are missing" and insert duplicates of every one of them.
  const existing: { name: string; ranking: number | null }[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('players').select('name, ranking')
      .eq('league_id', leagueId).range(from, from + 999)
    if (error) throw new Error(error.message)
    if (!data?.length) break
    existing.push(...data)
    if (data.length < 1000) break
  }

  // One entry per incoming name, first occurrence winning, so a list that
  // repeats a name cannot insert it twice.
  const byKey = new Map<string, IncomingPlayer>()
  for (const p of players) {
    const key = p.name?.trim() && normalizePlayerName(p.name)
    if (key && !byKey.has(key)) byKey.set(key, p)
  }
  const keys = [...byKey.keys()]

  for (const row of existing) {
    const hit = matchPlayerName(row.name, keys)
    if (hit) byKey.delete(hit)
  }

  const missing = [...byKey.values()]

  // A league's ranking scale is its own — the live pool runs to 474, an older
  // one to 265 — so a player arriving without a rank is numbered from the top
  // of *this* league's list rather than from whatever the source called him.
  // Everything unranked still sorts below him, and every ranked player above.
  let nextRank = existing.reduce((max, p) => Math.max(max, p.ranking ?? 0), 0)

  const rows = missing.map(p => ({
    league_id: leagueId,
    name: p.name.trim(),
    // Never written from a pool file: ESPN's team mapping was wrong and put
    // 250 bogus teams into the live league on 2026-09-04.
    nba_team: null,
    position: p.position ?? null,
    ranking: p.ranking ?? ++nextRank,
    auction_value: p.auction_value ?? null,
    stats: {},
    status: 'available',
  }))

  const result: TopUpResult = {
    inLeague: existing.length,
    inList: keys.length,
    willAdd: rows.length,
    names: rows.map(r => r.name),
    added: 0,
  }
  if (opts.dryRun) return result

  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const { error, count } = await supabase
      .from('players')
      .insert(rows.slice(i, i + INSERT_CHUNK), { count: 'exact' })
    if (error) throw Object.assign(new Error(error.message), { added: result.added })
    result.added += count ?? 0
  }
  return result
}
