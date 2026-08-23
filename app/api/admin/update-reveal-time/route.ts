import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const userClient = await createClient()
  const user = await getAuthUser(userClient)
  const supabase = createAdminClient()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { auctionId, revealTime } = await req.json()
  if (!auctionId || !revealTime) return NextResponse.json({ error: 'Missing auctionId or revealTime' }, { status: 400 })

  const iso = new Date(revealTime)
  if (isNaN(iso.getTime())) return NextResponse.json({ error: 'זמן לא תקין' }, { status: 400 })

  const { data: auction } = await supabase
    .from('auctions')
    .select('league_id')
    .eq('id', auctionId)
    .maybeSingle()
  if (!auction) return NextResponse.json({ error: 'Auction not found' }, { status: 404 })

  // Admin check: row in admin_users OR creator of this auction's league.
  // League creators may have no admin_users row (they reach the admin panel via
  // leagues.created_by), so admin_users alone would silently update 0 rows.
  const { data: callerAdmin } = await supabase.from('admin_users').select('role').eq('user_id', user.id).maybeSingle()
  const { data: league } = await supabase.from('leagues').select('created_by').eq('id', auction.league_id).maybeSingle()
  const isAdmin = !!callerAdmin || league?.created_by === user.id
  if (!isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { error } = await supabase
    .from('auctions')
    .update({ reveal_time: iso.toISOString(), updated_at: new Date().toISOString() })
    .eq('id', auctionId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
