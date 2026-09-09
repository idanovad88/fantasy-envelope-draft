/**
 * The one place that knows how to read ESPN's draft rankings.
 *
 * Imported by both `scripts/fetch-espn-ranks.mjs` (which writes the files) and
 * `app/api/create-league/route.ts` (which seeds a new league live), so the two
 * can never drift into disagreeing about what a rank is. Plain `.mjs` because
 * the script has no TypeScript runner — `allowJs` lets the route import it.
 */

/** ESPN's `eligibleSlots` 0-4. Verified to reproduce the pool 387/387. */
const SLOT = { 0: 'PG', 1: 'SG', 2: 'SF', 3: 'PF', 4: 'C' }

/**
 * A pool this much smaller than expected means ESPN answered with something
 * other than the full ranked list — a truncated file would quietly seed every
 * future league short, so callers treat it as a failure.
 */
export const MIN_RANKED = 300

/** Enough to cover every ranked player (387 today) without pulling all 900. */
export const FETCH_LIMIT = 450

/**
 * ESPN names a season by the year it ends in, and the next one becomes
 * interesting the moment the previous playoffs are over.
 */
export function defaultSeason(now = new Date()) {
  return now.getMonth() + 1 >= 8 ? now.getFullYear() + 1 : now.getFullYear()
}

/** 2027 -> "2026_27" */
export function seasonSlug(season) {
  return `${season - 1}_${String(season).slice(2)}`
}

/**
 * @typedef {{ name: string, position: string, ranking: number, auction_value: number }} PoolPlayer
 */

/**
 * Fetches the ranked pool, ordered and renumbered 1..N.
 *
 * @param {{ season?: number, limit?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<PoolPlayer[]>}
 */
export async function fetchRankedPlayers(opts = {}) {
  const season = opts.season ?? defaultSeason()
  const limit = opts.limit ?? FETCH_LIMIT

  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/${season}/segments/0/leaguedefaults/3?view=kona_player_info`
  const filter = {
    players: { limit, sortDraftRanks: { sortPriority: 100, sortAsc: true, value: 'STANDARD' } },
  }

  const res = await fetch(url, {
    headers: { 'x-fantasy-filter': JSON.stringify(filter) },
    ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
  })
  if (!res.ok) throw new Error(`ESPN returned ${res.status} ${res.statusText}`)
  const body = await res.json()

  const rows = []
  for (const entry of body.players ?? []) {
    const p = entry.player
    const std = p?.draftRanksByRankType?.STANDARD
    if (!std?.rank) continue
    rows.push({
      name: p.fullName,
      position: (p.eligibleSlots ?? [])
        .filter(s => s in SLOT)
        .sort((a, b) => a - b)
        .map(s => SLOT[s])
        .join('/'),
      espnRank: std.rank,
      auction_value: std.auctionValue ?? 0,
    })
  }

  // ESPN's ranks contain ties — 7 of them today, covering 14 players — and the
  // order it returns tied players in is NOT stable between calls. Renumbering
  // in response order therefore produced a different list every run: two calls
  // minutes apart swapped Mobley/Adebayo, Okongwu/Lillard and two more pairs.
  // A weekly "did the ranks change?" check is worthless against that, so every
  // tie is broken on the data itself.
  rows.sort(
    (a, b) =>
      a.espnRank - b.espnRank ||
      b.auction_value - a.auction_value ||
      a.name.localeCompare(b.name)
  )

  // Rebuilt field by field rather than spread: this object is serialised
  // straight into data/nba-pool.json, so its key order is part of the file and
  // has to stay put for the weekly diff to mean anything.
  return rows.map((r, i) => ({
    name: r.name,
    position: r.position,
    auction_value: r.auction_value,
    ranking: i + 1,
  }))
}

/**
 * Mirrors `normalizePlayerName()` in `lib/utils.ts`. Duplicated rather than
 * imported because that file is TypeScript and `scripts/fetch-espn-ranks.mjs`
 * has no TypeScript runner; keep the two bodies identical.
 */
function poolKey(name) {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[.'`\-]/g, '')
    .replace(/\s+(jr|sr|ii|iii|iv|v)$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Appends the draft class ESPN's `draftRanksByRankType.STANDARD` does not
 * carry.
 *
 * A player with no STANDARD rank is skipped by `fetchRankedPlayers()` — that
 * is what a rank *is* here — and in the preseason that silently drops every
 * rookie: the 2026-27 pool held the whole 2025 class (Flagg, Harper,
 * Edgecombe…) and not one player from the 2026 draft. `rookieData` supplies
 * those names by hand until ESPN ranks them.
 *
 * Two properties this leans on:
 *
 * - **It is a supplement, not an override.** Any rookie ESPN already returned
 *   keeps its ESPN rank, position and auction value; only the genuinely
 *   missing ones are appended. So this file needs no maintenance once ESPN
 *   catches up — the merge quietly becomes a no-op, name by name.
 * - **It is season-scoped.** `rookieData.season` must equal the season being
 *   fetched, so `--season 2028` does not inject the 2026 class into next
 *   year's pool.
 *
 * The appended players land *after* every ESPN-ranked player, in draft order.
 * Putting the No. 1 pick at 388 rather than somewhere in the 60s is
 * deliberate: ESPN has not valued these players yet and inventing a rank for
 * them would be a guess dressed as data. Draft order is the one ordering that
 * is a fact. An admin who disagrees can re-rank from the players tab.
 *
 * @param {PoolPlayer[]} players ranked pool from `fetchRankedPlayers()`
 * @param {{ season: number, players: { pick: number, name: string, position: string }[] }} rookieData
 * @param {number} [season]
 * @returns {PoolPlayer[]}
 */
export function withRookies(players, rookieData, season = defaultSeason()) {
  if (rookieData?.season !== season) return players

  const seen = new Set(players.map(p => poolKey(p.name)))
  const missing = rookieData.players
    .filter(r => !seen.has(poolKey(r.name)))
    .sort((a, b) => a.pick - b.pick)

  // Same field-by-field rebuild as above: key order is part of
  // data/nba-pool.json and the weekly diff compares the file.
  return [
    ...players,
    ...missing.map((r, i) => ({
      name: r.name,
      position: r.position,
      auction_value: 0,
      ranking: players.length + i + 1,
    })),
  ]
}
