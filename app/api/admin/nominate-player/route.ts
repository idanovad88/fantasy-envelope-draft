import { createClient, createAdminClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const userClient = await createClient()
  const { data: { user } } = await userClient.auth.getUser()
  const supabase = createAdminClient()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: callerAdmin } = await supabase.from('admin_users').select('role').eq('user_id', user.id).maybeSingle()
  if (!callerAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { league_id, player_id, nominating_team_id, slot_number, scheduled_start, reveal_time, status } = await req.json()
  if (!league_id || !player_id || !slot_number || !scheduled_start || !reveal_time || !status) {
    return NextResponse.json({ error: 'Missing data' }, { status: 400 })
  }

  const { data: auction, error: auctionErr } = await supabase.from('auctions').insert({
    league_id,
    player_id,
    nominating_team_id: nominating_team_id || null,
    slot_number,
    scheduled_start,
    reveal_time,
    status,
  }).select('id').single()

  if (auctionErr) return NextResponse.json({ error: auctionErr.message }, { status: 500 })

  await supabase.from('players').update({ status: 'on_auction' }).eq('id', player_id)

  // Auto-bid $1 for the nominating team so they always have a bid in (same as /api/nominate)
  if (nominating_team_id) {
    await supabase.from('bids').insert({ auction_id: auction.id, team_id: nominating_team_id, amount: 1 })
  }

  return NextResponse.json({ success: true })
}
