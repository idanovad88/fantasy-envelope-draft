import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'
import { resolveOpenActor, leagueOfOpenAuction } from '@/lib/openAuth'

// Drop out of an open auction. PASS is final — there is no way back in, which
// is what guarantees an auction terminates rather than circling forever.
//
// `open_pass()` refuses the current leader: putting a player up (or outbidding
// everyone) is a commitment, and a leader walking away could leave the auction
// with nobody in it. An admin may pass on behalf of a team via `team_id` — the
// only way to unstick an auction, since a pass can never be undone.
export async function POST(req: Request) {
  const supabase = await createClient()
  const user = await getAuthUser(supabase)
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const auctionId: string | undefined = body?.auction_id
  const requestedTeamId: string | undefined = body?.team_id
  if (!auctionId) return NextResponse.json({ error: 'חסר מזהה מכרז' }, { status: 400 })

  const leagueId = await leagueOfOpenAuction(auctionId)
  if (!leagueId) return NextResponse.json({ error: 'המכרז לא נמצא' }, { status: 404 })

  const actor = await resolveOpenActor(user.id, leagueId, requestedTeamId)
  if (!actor.ok) return NextResponse.json({ error: actor.error }, { status: actor.status })

  const admin = createAdminClient()
  const { error } = await admin.rpc('open_pass', {
    p_auction_id: auctionId,
    p_team_id: actor.teamId,
    p_reason: requestedTeamId ? 'admin' : 'manual',
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  return NextResponse.json({ success: true })
}
