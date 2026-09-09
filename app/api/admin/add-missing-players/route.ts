import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'
import { normalizePlayerName, matchPlayerName } from '@/lib/utils'
import { NextRequest, NextResponse } from 'next/server'

type IncomingPlayer = {
  name: string
  position?: string | null
  ranking?: number | null
  auction_value?: number | null
}

/** Big enough to keep the round trips down, small enough to stay under any payload limit. */
const INSERT_CHUNK = 200

/**
 * Inserts the players from a list that a league does not have yet, and nothing
 * else.
 *
 * The third of the three import routes, and the gap between the other two.
 * `/api/import-players` inserts *everything* with `status: 'available'` and no
 * dedupe, so re-running it against a live league creates a second, undrafted
 * copy of every player already sold. `/api/admin/update-player-rankings` only
 * ever UPDATEs, so a player the league never had stays missing. Topping up a
 * running league — the 2026 rookies ESPN had not ranked, say — needed the
 * third shape: insert the missing, touch nothing that exists.
 *
 * Existing rows are never written to. A name that matches an existing player is
 * skipped whatever its position or rank says, so this can be pointed at the
 * whole pool CSV as safely as at a handful of names.
 *
 * Matching runs in the same direction as `update-player-rankings`: over the
 * stored rows, against the keys of the incoming list. That direction is what
 * makes `matchPlayerName()`'s wildcard work — the corrupted names are the
 * stored ones (`Nikola Joki?`, from a Latin-1 CSV read as UTF-8), and matching
 * the other way round would re-add Jokić and Dončić as duplicates.
 */
export async function POST(req: NextRequest) {
  const userClient = await createClient()
  const user = await getAuthUser(userClient)
  const supabase = createAdminClient()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { league_id, players, dry_run } = (await req.json()) as {
    league_id: string
    players: IncomingPlayer[]
    dry_run?: boolean
  }

  if (!league_id || !players?.length) {
    return NextResponse.json({ error: 'Missing data' }, { status: 400 })
  }

  const { data: league } = await supabase
    .from('leagues').select('created_by').eq('id', league_id).single()
  if (!league) return NextResponse.json({ error: 'ליגה לא נמצאה' }, { status: 404 })

  const { data: adminRow } = await supabase
    .from('admin_users').select('role').eq('user_id', user.id).maybeSingle()
  if (!adminRow && league.created_by !== user.id) {
    return NextResponse.json({ error: 'Forbidden — admins only' }, { status: 403 })
  }

  // Page around the 1000-row PostgREST cap. A truncated read here would look
  // like "those players are missing" and insert duplicates of every one of them.
  const existing: { name: string; ranking: number | null }[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('players').select('name, ranking')
      .eq('league_id', league_id).range(from, from + 999)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
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

  // A league's ranking scale is whatever file it was last ranked from, which
  // is not the same as how many of its players are ranked: the live open
  // league has 265 ranked rows but drew them from a 387-row ESPN list, so its
  // top rank is near 387. Reading MAX(ranking) off the league is what makes
  // that difference stop mattering — a player arriving without a rank is
  // numbered from the top of *this* league's list rather than from whatever
  // the source file happened to call him. Everything unranked still sorts
  // below him, and every ranked player above.
  let nextRank = existing.reduce((max, p) => Math.max(max, p.ranking ?? 0), 0)

  const rows = missing.map(p => ({
    league_id,
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

  if (dry_run) {
    return NextResponse.json({
      dry_run: true,
      inLeague: existing.length,
      inFile: keys.length,
      willAdd: rows.length,
      names: rows.map(r => r.name),
    })
  }

  let added = 0
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const { error, count } = await supabase
      .from('players')
      .insert(rows.slice(i, i + INSERT_CHUNK), { count: 'exact' })
    if (error) return NextResponse.json({ error: error.message, added }, { status: 500 })
    added += count ?? 0
  }

  return NextResponse.json({ inLeague: existing.length, inFile: keys.length, added })
}
