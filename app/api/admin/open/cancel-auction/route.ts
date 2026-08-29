import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'
import { requireOpenAdmin, leagueOfOpenAuction } from '@/lib/openAuth'

// Pull a player back off the board: bids and passes are discarded and the
// player returns to the pool. Because PASS is final, cancelling and
// re-nominating is the only way to undo a mistaken pass.
//
// The auction row itself is kept as `cancelled` so history still shows the
// player was up and withdrawn.
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
  const { error } = await admin.rpc('open_cancel_auction', { p_auction_id: auctionId })

  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  return NextResponse.json({ success: true })
}
