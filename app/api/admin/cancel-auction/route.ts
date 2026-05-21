import { createClient, createAdminClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const userClient = await createClient()
  const { data: { user } } = await userClient.auth.getUser()
  const supabase = createAdminClient()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: callerAdmin } = await supabase.from('admin_users').select('role').eq('user_id', user.id).maybeSingle()
  if (!callerAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { auctionId } = await req.json()
  if (!auctionId) return NextResponse.json({ error: 'Missing auctionId' }, { status: 400 })

  const { data: auction, error: fetchErr } = await supabase
    .from('auctions')
    .select('player_id, nominating_team_id, status, winning_team_id, winning_bid')
    .eq('id', auctionId)
    .maybeSingle()

  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 })
  if (!auction) return NextResponse.json({ error: 'Auction not found' }, { status: 404 })

  // If already completed and had a winner — refund budget and fix player count
  if (auction.status === 'completed' && auction.winning_team_id && auction.winning_bid) {
    const { data: team } = await supabase
      .from('teams')
      .select('budget_remaining, player_count')
      .eq('id', auction.winning_team_id)
      .maybeSingle()

    if (team) {
      await supabase.from('teams').update({
        budget_remaining: team.budget_remaining + auction.winning_bid,
        player_count: Math.max(0, team.player_count - 1),
        is_complete: false,
        updated_at: new Date().toISOString(),
      }).eq('id', auction.winning_team_id)
    }
  }

  // Delete all bids
  await supabase.from('bids').delete().eq('auction_id', auctionId)

  // Return player to available pool
  const { error: playerErr } = await supabase.from('players')
    .update({ status: 'available', drafted_by_team_id: null, draft_price: null })
    .eq('id', auction.player_id)

  if (playerErr) return NextResponse.json({ error: 'שגיאה בעדכון שחקן: ' + playerErr.message }, { status: 500 })

  // Delete the auction record entirely
  const { error: deleteErr } = await supabase.from('auctions').delete().eq('id', auctionId)
  if (deleteErr) return NextResponse.json({ error: 'שגיאה במחיקת מכרז: ' + deleteErr.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}

