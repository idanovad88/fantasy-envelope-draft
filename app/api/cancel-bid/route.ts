import { createClient, createAdminClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { myTeamOr } from '@/lib/team'

// Withdraw a team's sealed bid from an active auction.
// Lowering a bid is not enough: the minimum is $1, so without this a team that
// bid the floor is locked in. Deletion runs through the service-role client —
// `bids` has no DELETE policy and this route enforces the same conditions the
// bids_team_update policy does (own team, auction still active, deadline not
// passed) plus the nominator rule below.
export async function POST(req: Request) {
  const userClient = await createClient()
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const auctionId: string | undefined = body?.auctionId
  if (!auctionId) return NextResponse.json({ error: 'חסר מזהה מכרז' }, { status: 400 })

  const supabase = createAdminClient()

  const { data: auction } = await supabase
    .from('auctions')
    .select('id, league_id, status, reveal_time, nominating_team_id')
    .eq('id', auctionId)
    .maybeSingle()
  if (!auction) return NextResponse.json({ error: 'מכרז לא נמצא' }, { status: 404 })

  if (auction.status !== 'active') {
    return NextResponse.json({ error: 'המכרז אינו פעיל' }, { status: 400 })
  }
  if (new Date(auction.reveal_time).getTime() <= Date.now()) {
    return NextResponse.json({ error: 'המועד להגשת הצעות עבר' }, { status: 400 })
  }

  // Owner or assistant manager, same resolution as the bid form itself.
  const { data: team } = await supabase
    .from('teams')
    .select('id')
    .or(myTeamOr(user.id))
    .eq('league_id', auction.league_id)
    .limit(1)
    .maybeSingle()
  if (!team) return NextResponse.json({ error: 'אין לך קבוצה בליגה הזו' }, { status: 403 })

  // The nominating team's $1 auto-bid (trg_auto_bid_nominating_team) is
  // mandatory: nominating a player commits you to at least $1 for it, and
  // removing it could leave the auction with no bids at all.
  if (auction.nominating_team_id === team.id) {
    return NextResponse.json(
      { error: 'הקבוצה שהעלתה את השחקן לא יכולה לבטל את ההצעה' },
      { status: 403 }
    )
  }

  const { error } = await supabase
    .from('bids')
    .delete()
    .eq('auction_id', auctionId)
    .eq('team_id', team.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
