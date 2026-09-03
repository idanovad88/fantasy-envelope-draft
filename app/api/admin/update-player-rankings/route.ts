import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'
import { normalizePlayerName, matchPlayerName } from '@/lib/utils'
import { NextRequest, NextResponse } from 'next/server'

type IncomingPlayer = { name: string; ranking?: number | null; nba_team?: string | null }

/**
 * Fills `ranking` on players that already exist in a league, matched by name.
 *
 * Deliberately NOT part of `/api/import-players`: that route inserts with
 * `status: 'available'` hardcoded and has no dedupe, so re-importing a pool
 * into a running league would create a second, undrafted copy of every
 * player — including the ones already sold. This route only ever UPDATEs,
 * and only ever touches `ranking` (plus `nba_team` where it is still blank).
 * `status`, `drafted_by_team_id`, `draft_price` and `roster_slot` are never
 * written, so a player who has already been bought keeps his team and price.
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

  // Same check as /api/admin/add-player — admin row or creator of *this*
  // league, rather than the league-blind `admin_users` lookup in
  // /api/import-players.
  const { data: adminRow } = await supabase
    .from('admin_users').select('role').eq('user_id', user.id).maybeSingle()
  if (!adminRow && league.created_by !== user.id) {
    return NextResponse.json({ error: 'Forbidden — admins only' }, { status: 403 })
  }

  // Page around the 1000-row PostgREST cap: a pool bigger than that would
  // otherwise come back silently truncated and leave the tail unranked.
  const existing: { id: string; name: string; ranking: number | null; nba_team: string | null }[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('players').select('id, name, ranking, nba_team')
      .eq('league_id', league_id).range(from, from + 999)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data?.length) break
    existing.push(...data)
    if (data.length < 1000) break
  }

  const byKey = new Map<string, IncomingPlayer>()
  for (const p of players) {
    if (p.name?.trim()) byKey.set(normalizePlayerName(p.name), p)
  }
  const keys = [...byKey.keys()]

  const updates: { id: string; ranking: number | null; nba_team?: string }[] = []
  const unmatched: string[] = []

  for (const row of existing) {
    const key = matchPlayerName(row.name, keys)
    if (!key) { unmatched.push(row.name); continue }
    const src = byKey.get(key)!
    const ranking = src.ranking ?? null
    // Only fill a blank team; an admin may have corrected it by hand.
    const team = !row.nba_team && src.nba_team ? src.nba_team : undefined
    if (ranking === row.ranking && team === undefined) continue
    updates.push({ id: row.id, ranking, ...(team ? { nba_team: team } : {}) })
  }

  const matched = existing.length - unmatched.length

  if (dry_run) {
    return NextResponse.json({ dry_run: true, total: existing.length, matched, willUpdate: updates.length, unmatched })
  }

  for (let i = 0; i < updates.length; i += 25) {
    const results = await Promise.all(
      updates.slice(i, i + 25).map(u => {
        const { id, ...fields } = u
        return supabase.from('players').update(fields).eq('id', id)
      })
    )
    const failed = results.find(r => r.error)
    if (failed?.error) return NextResponse.json({ error: failed.error.message }, { status: 500 })
  }

  return NextResponse.json({ total: existing.length, matched, updated: updates.length, unmatched })
}
