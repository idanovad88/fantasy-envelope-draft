import { createAdminClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const supabase = await createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: callerAdmin } = await supabase.from('admin_users').select('role').eq('user_id', user.id).maybeSingle()
  if (!callerAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { auctionId } = await req.json()
  if (!auctionId) return NextResponse.json({ error: 'Missing auctionId' }, { status: 400 })

  const { data: auction } = await supabase
    .from('auctions')
    .select('player_id, nominating_team_id')
    .eq('id', auctionId)
    .maybeSingle()

  if (!auction) return NextResponse.json({ error: 'Auction not found' }, { status: 404 })

  // Delete all bids for this auction (including auto $1)
  await supabase.from('bids').delete().eq('auction_id', auctionId)

  // Return player to available pool
  await supabase.from('players')
    .update({ status: 'available', drafted_by_team_id: null, draft_price: null })
    .eq('id', auction.player_id)

  // Mark auction as cancelled
  await supabase.from('auctions')
    .update({ status: 'completed', updated_at: new Date().toISOString() })
    .eq('id', auctionId)

  return NextResponse.json({ ok: true })
}
