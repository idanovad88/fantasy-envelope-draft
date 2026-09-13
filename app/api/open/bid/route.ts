import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'
import { resolveOpenActor, leagueOfOpenAuction } from '@/lib/openAuth'

// Raise the bid on an open auction.
//
// Unlike the envelope's BidForm — which upserts into `bids` straight from the
// browser under RLS — this goes through a route: `open_bids` has no write
// policy at all, and the budget ceiling here depends on every other auction the
// team is currently leading, which is not something a WITH CHECK can express.
// `open_place_bid()` does the validating, resets the deadline, and settles.
export async function POST(req: Request) {
  const supabase = await createClient()
  const user = await getAuthUser(supabase)
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const auctionId: string | undefined = body?.auction_id
  const teamId: string | undefined = body?.team_id
  const amount = Number(body?.amount)

  if (!auctionId) return NextResponse.json({ error: 'חסר מזהה מכרז' }, { status: 400 })
  if (!Number.isInteger(amount) || amount < 1) {
    return NextResponse.json({ error: 'סכום ההצעה אינו תקין' }, { status: 400 })
  }

  const leagueId = await leagueOfOpenAuction(auctionId)
  if (!leagueId) return NextResponse.json({ error: 'המכרז לא נמצא' }, { status: 404 })

  // `team_id` is the admin-on-behalf path, for a manager who cannot reach the
  // board — resolveOpenActor refuses it for everyone else. The bid it writes is
  // an ordinary bid: nothing records that an admin typed it, so an admin who
  // uses this is speaking for the team and had better have been asked to.
  const actor = await resolveOpenActor(user.id, leagueId, teamId)
  if (!actor.ok) return NextResponse.json({ error: actor.error }, { status: actor.status })

  const admin = createAdminClient()
  const { error } = await admin.rpc('open_place_bid', {
    p_auction_id: auctionId,
    p_team_id: actor.teamId,
    p_amount: amount,
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  return NextResponse.json({ success: true })
}
