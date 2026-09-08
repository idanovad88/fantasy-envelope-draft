import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'
import { resolveOpenActor } from '@/lib/openAuth'

type Entry = { player_id: string; position: number; opening_bid: number }

// Rewrite the team's whole queue — order and per-player opening bids — in one
// call. The editor sends the list it is showing, so a row the manager removed
// is simply absent and gets deleted here.
//
// Whether an opening bid is affordable is deliberately NOT checked: the ceiling
// moves with every auction the team leads, and an entry that is too expensive
// today is skipped by open_queue_next_entry() rather than rejected outright.
// Blocking it at save time would mean a manager could not write down what a
// player is worth to them while their money is temporarily parked elsewhere.
export async function POST(req: Request) {
  const supabase = await createClient()
  const user = await getAuthUser(supabase)
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const { league_id: leagueId, team_id: requestedTeamId, entries } = body
  if (!leagueId || !Array.isArray(entries)) {
    return NextResponse.json({ error: 'פרמטרים חסרים' }, { status: 400 })
  }

  const clean: Entry[] = []
  for (const e of entries as Entry[]) {
    const bid = Number(e?.opening_bid)
    if (!e?.player_id || !Number.isInteger(bid) || bid < 1) {
      return NextResponse.json({ error: 'הצעת הפתיחה אינה תקינה' }, { status: 400 })
    }
    clean.push({ player_id: e.player_id, position: clean.length + 1, opening_bid: bid })
  }

  const actor = await resolveOpenActor(user.id, leagueId, requestedTeamId)
  if (!actor.ok) return NextResponse.json({ error: actor.error }, { status: actor.status })

  const admin = createAdminClient()

  // Delete-then-insert rather than an update per row: the incoming list is the
  // whole truth, and this is the only way a removal is expressed. There is no
  // transaction across PostgREST calls, so the worst case is a queue that is
  // briefly empty — it holds no draft state, and the manager is looking at the
  // page that is about to re-render from the new rows.
  const { error: delError } = await admin
    .from('open_nomination_queue')
    .delete()
    .eq('team_id', actor.teamId)
  if (delError) return NextResponse.json({ error: delError.message }, { status: 500 })

  if (clean.length > 0) {
    const { error } = await admin.from('open_nomination_queue').insert(
      clean.map(e => ({
        league_id: leagueId,
        team_id: actor.teamId,
        player_id: e.player_id,
        position: e.position,
        opening_bid: e.opening_bid,
      }))
    )
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
