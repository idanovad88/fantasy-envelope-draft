import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'
import { requireOpenAdmin, leagueOfOpenAuction } from '@/lib/openAuth'

// Undo an auction that already closed: the player goes back to the pool and the
// winning bid goes back to the winner's budget. `cancel-auction` next door only
// handles an auction that is still open — this is the one for a close that
// should not have happened (closed early by mistake, wrong player nominated, a
// deadline that ran out on a bid that should not have counted).
//
// The auction row survives as `cancelled`, so history still shows the player
// was up and the result was withdrawn. Re-nominating is a separate step.
export async function POST(req: Request) {
  const supabase = await createClient()
  const user = await getAuthUser(supabase)
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const auctionId: string | undefined = body?.auction_id
  if (!auctionId) return NextResponse.json({ error: 'חסר מזהה מכרז' }, { status: 400 })

  const leagueId = await leagueOfOpenAuction(auctionId)
  if (!leagueId) return NextResponse.json({ error: 'המכרז לא נמצא' }, { status: 404 })

  const auth = await requireOpenAdmin(user.id, leagueId)
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const admin = createAdminClient()
  const { error } = await admin.rpc('open_undo_auction', { p_auction_id: auctionId })

  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  return NextResponse.json({ success: true })
}
