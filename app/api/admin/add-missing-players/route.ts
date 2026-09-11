import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'
import { topUpLeague, type IncomingPlayer } from '@/lib/topUp'
import { NextRequest, NextResponse } from 'next/server'

/**
 * Inserts the players from a list that a league does not have yet.
 *
 * The work itself is `topUpLeague()` in `lib/topUp.ts`, shared with the
 * nightly `/api/cron/top-up-pools` sweep — see the comment there for why the
 * two must not have separate implementations. This route is the reviewed path:
 * an admin pastes a list, runs it with `dry_run` to see every name it would
 * add, and confirms.
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

  try {
    const r = await topUpLeague(supabase, league_id, players, { dryRun: !!dry_run })
    if (dry_run) {
      return NextResponse.json({
        dry_run: true,
        inLeague: r.inLeague,
        inFile: r.inList,
        willAdd: r.willAdd,
        names: r.names,
      })
    }
    return NextResponse.json({ inLeague: r.inLeague, inFile: r.inList, added: r.added })
  } catch (err) {
    const added = (err as { added?: number }).added ?? 0
    return NextResponse.json({ error: (err as Error).message, added }, { status: 500 })
  }
}
