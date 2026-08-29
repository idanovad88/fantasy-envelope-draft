import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'
import { requireOpenAdmin, leagueOfOpenAuction } from '@/lib/openAuth'

// Close an open auction now, awarding the player to whoever is leading.
// The normal endings are "everyone passed" and "the deadline ran out"; this is
// for an admin who wants to move the board along without waiting.
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
  const { error } = await admin.rpc('open_close_auction', {
    p_auction_id: auctionId,
    p_reason: 'admin',
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  return NextResponse.json({ success: true })
}
