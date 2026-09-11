import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { loadPool } from '@/lib/pool'
import { topUpLeague } from '@/lib/topUp'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
/** One ~15MB ESPN parse, then a paged read and an insert per league. */
export const maxDuration = 60

/**
 * Statuses a league can be in and still want its pool kept current. Everything
 * except `completed` — a finished draft has nothing to add a player to, and
 * four of the six leagues in production are exactly that.
 */
const OPEN_STATUSES = ['setup', 'lottery', 'active', 'paused']

/**
 * Called once a day by Supabase pg_cron (see supabase/cron_top_up_pools.sql).
 *
 * Adds to every unfinished league whatever has appeared in the pool since it
 * was seeded, and nothing else.
 *
 * Seeding runs once, at creation. The pool moves afterwards: ESPN ranks 387
 * players in the preseason and more as the season starts, and someone nobody
 * rostered in September is rostered in November. Before this, a league was
 * complete on the day it was created and never again — the 27 rostered
 * players added to the pool on 2026-09-11 would have reached no league that
 * already existed.
 *
 * Three things make this safe to run unattended against a live draft:
 *
 * - **It only ever INSERTs.** `topUpLeague()` is the same function behind the
 *   admin panel's reviewable "add missing" button, deliberately shared rather
 *   than reimplemented: a name already in the league is skipped whatever its
 *   rank or position says, and `status`, `drafted_by_team_id`, `draft_price`
 *   and `roster_slot` are never written.
 * - **It is idempotent.** A second run adds nothing, so a quiet day costs one
 *   ESPN fetch and a read per league.
 * - **It refuses to act on a pool it does not trust.** `loadPool()` already
 *   rejects a truncated ESPN answer (`MIN_RANKED`); on top of that this route
 *   will not write from the bundled fallback. The bundle is a snapshot of a
 *   past fetch, so a day when ESPN is unreachable should change nothing at
 *   all rather than replay an old list into a running draft. Tomorrow's run
 *   picks it up.
 *
 * Deliberately *not* filtered to leagues whose draft has not started: a league
 * mid-draft is exactly the one that has been open longest and drifted furthest.
 *
 * `?dry=1` reports what it would add and writes nothing — the way to check the
 * schedule is wired up correctly without waiting for 04:00, and the way to see
 * what tonight's run is about to do to a live league.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  // A missing secret must not leave the route open.
  if (!secret) {
    console.error('[top-up-pools] CRON_SECRET is not set')
    return NextResponse.json({ error: 'Not configured' }, { status: 500 })
  }
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const dryRun = new URL(req.url).searchParams.get('dry') === '1'
  const supabase = createAdminClient()

  const { data: leagues, error } = await supabase
    .from('leagues').select('id, name, status').in('status', OPEN_STATUSES)
  if (error) {
    console.error('[top-up-pools] could not list leagues', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!leagues?.length) return NextResponse.json({ leagues: 0, added: 0 })

  let pool
  try {
    pool = await loadPool()
  } catch (err) {
    console.error('[top-up-pools] could not build the pool', err)
    return NextResponse.json({ error: 'pool unavailable' }, { status: 502 })
  }

  if (pool.source !== 'espn') {
    console.warn('[top-up-pools] ESPN unavailable — skipping rather than replaying the bundled pool')
    return NextResponse.json({ skipped: 'fallback', leagues: leagues.length, added: 0 })
  }

  // One league failing must not stop the rest: they are independent, and the
  // next run retries whatever was missed anyway.
  const results: { league: string; status: string; added: number; names?: string[]; error?: string }[] = []
  let total = 0
  for (const l of leagues) {
    try {
      const r = await topUpLeague(supabase, l.id, pool.players, { dryRun })
      const n = dryRun ? r.willAdd : r.added
      total += n
      results.push({ league: l.name, status: l.status, added: n, ...(n ? { names: r.names } : {}) })
      if (n && !dryRun) {
        console.log(`[top-up-pools] ${l.name}: added ${n} — ${r.names.join(', ')}`)
      }
    } catch (err) {
      console.error(`[top-up-pools] ${l.name} failed`, err)
      results.push({ league: l.name, status: l.status, added: 0, error: (err as Error).message })
    }
  }

  return NextResponse.json({
    ...(dryRun ? { dry_run: true } : {}),
    poolSize: pool.players.length,
    leagues: leagues.length,
    added: total,
    results,
  })
}
