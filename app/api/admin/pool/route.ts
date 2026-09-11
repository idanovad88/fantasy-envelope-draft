import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'
import { loadPool } from '@/lib/pool'
import { NextResponse } from 'next/server'

/** Same reason as `create-league`: the ranked fetch alone is ~15MB to parse. */
export const maxDuration = 30

/**
 * The current player pool, as a `name,pos` CSV for the admin panel's textarea.
 *
 * `create-league` seeds a new league from `loadPool()`, but a league that
 * already exists had no way to pick up what has appeared since — ESPN ranks
 * more players as the season starts, rookies get ranked, and a player who was
 * on nobody's roster in September is rostered in November. The admin's only
 * option was finding a CSV and pasting it.
 *
 * Deliberately **no rank column.** `add-missing-players` numbers a player who
 * arrives without one from `MAX(ranking) + 1` *of that league*, which is the
 * right answer: a league's ranking scale is its own — the live pool runs to
 * 474, an older league to 265 — so handing it ESPN's number would drop the new
 * player into the middle of a scale that means something different. Positions
 * come through because `assign_roster_slot()` needs them.
 *
 * Reads nothing from any league, so there is no league to check admin rights
 * against; a signed-in user is the gate, and the content is public NBA data
 * either way. The write that follows is `add-missing-players`, which does check.
 */
export async function GET() {
  const userClient = await createClient()
  const user = await getAuthUser(userClient)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Only to confirm the caller administers *something*; which league the pool
  // is destined for is the next request's problem.
  const supabase = createAdminClient()
  const [{ data: adminRow }, { data: createdLeague }] = await Promise.all([
    supabase.from('admin_users').select('user_id').eq('user_id', user.id).maybeSingle(),
    supabase.from('leagues').select('id').eq('created_by', user.id).limit(1).maybeSingle(),
  ])
  if (!adminRow && !createdLeague) {
    return NextResponse.json({ error: 'Forbidden — admins only' }, { status: 403 })
  }

  try {
    const { players, source } = await loadPool()
    const csv = ['name,pos', ...players.map(p => `${p.name},${p.position}`)].join('\n')
    return NextResponse.json({ csv, count: players.length, source })
  } catch (err) {
    console.error('admin/pool: could not build the pool', err)
    return NextResponse.json({ error: 'לא הצלחנו למשוך את המאגר' }, { status: 502 })
  }
}
