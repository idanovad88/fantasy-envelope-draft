import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'
import { resolveOpenActor } from '@/lib/openAuth'

// Put a player on the open board.
//
// Every rule — board full, player available, whose turn it is, can the team
// cover the $1 auto-bid — is enforced by `open_nominate()` in Postgres, which
// also inserts the opening bid, flips the player to `on_auction` and rotates
// the nomination order. This route only decides which team is acting.
export async function POST(req: Request) {
  const supabase = await createClient()
  const user = await getAuthUser(supabase)
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const { league_id: leagueId, player_id: playerId, team_id: requestedTeamId } = body
  if (!leagueId || !playerId) {
    return NextResponse.json({ error: 'חסרים פרטים' }, { status: 400 })
  }

  const actor = await resolveOpenActor(user.id, leagueId, requestedTeamId)
  if (!actor.ok) return NextResponse.json({ error: actor.error }, { status: actor.status })

  const admin = createAdminClient()
  const { data, error } = await admin.rpc('open_nominate', {
    p_league_id: leagueId,
    p_player_id: playerId,
    p_team_id: actor.teamId,
  })

  // The function's RAISE EXCEPTION messages are already the Hebrew text we want
  // the board to show, so pass them straight through.
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  return NextResponse.json({ success: true, auctionId: data })
}
