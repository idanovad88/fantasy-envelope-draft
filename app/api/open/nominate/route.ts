import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'
import { resolveOpenActor } from '@/lib/openAuth'

// Put a player on the open board.
//
// Every rule — board full, player available, whose turn it is, whether the team
// can cover the opening bid it named — is enforced by `open_nominate()` in
// Postgres, which also inserts that opening bid, flips the player to
// `on_auction` and rotates the nomination order. This route only decides which
// team is acting.
//
// `opening_bid` is optional and defaults to $1, the old fixed floor, so a
// client that omits it behaves exactly as before.
export async function POST(req: Request) {
  const supabase = await createClient()
  const user = await getAuthUser(supabase)
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const { league_id: leagueId, player_id: playerId, team_id: requestedTeamId } = body
  if (!leagueId || !playerId) {
    return NextResponse.json({ error: 'חסרים פרטים' }, { status: 400 })
  }

  // Shape only. Whether the team can actually afford it is open_nominate()'s
  // call, which has the other auctions this team leads in front of it.
  const openingBid = body?.opening_bid === undefined ? 1 : Number(body.opening_bid)
  if (!Number.isInteger(openingBid) || openingBid < 1) {
    return NextResponse.json({ error: 'הצעת הפתיחה אינה תקינה' }, { status: 400 })
  }

  const actor = await resolveOpenActor(user.id, leagueId, requestedTeamId)
  if (!actor.ok) return NextResponse.json({ error: actor.error }, { status: actor.status })

  const admin = createAdminClient()
  const { data, error } = await admin.rpc('open_nominate', {
    p_league_id: leagueId,
    p_player_id: playerId,
    p_team_id: actor.teamId,
    p_opening_bid: openingBid,
  })

  // The function's RAISE EXCEPTION messages are already the Hebrew text we want
  // the board to show, so pass them straight through.
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  return NextResponse.json({ success: true, auctionId: data })
}
