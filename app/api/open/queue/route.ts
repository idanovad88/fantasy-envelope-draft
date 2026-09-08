import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'
import { resolveOpenActor } from '@/lib/openAuth'

// Add / remove a player from the team's automatic nomination queue.
//
// The queue is per TEAM — an owner and their assistant share one list — which
// is why the caller is resolved with resolveOpenActor() rather than the inline
// membership block /api/players/watch uses for the per-user star. It already
// checks the league is an open draft, counts an assistant as the team, and
// gives a league admin the act-on-behalf path for free.
//
// `open_nomination_queue` has a SELECT-only policy and no write policy at all,
// so this route (service role) is the only way in.
export async function POST(req: Request) {
  const supabase = await createClient()
  const user = await getAuthUser(supabase)
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const { league_id: leagueId, player_id: playerId, team_id: requestedTeamId, queued } = body
  if (!leagueId || !playerId || typeof queued !== 'boolean') {
    return NextResponse.json({ error: 'פרמטרים חסרים' }, { status: 400 })
  }

  const actor = await resolveOpenActor(user.id, leagueId, requestedTeamId)
  if (!actor.ok) return NextResponse.json({ error: actor.error }, { status: actor.status })

  const admin = createAdminClient()

  if (!queued) {
    const { error } = await admin
      .from('open_nomination_queue')
      .delete()
      .eq('team_id', actor.teamId)
      .eq('player_id', playerId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  }

  // The player must be in this league. Checked here rather than left to the FK,
  // which would happily accept a player from another league entirely.
  const { data: player } = await admin
    .from('players')
    .select('id, league_id')
    .eq('id', playerId)
    .maybeSingle()
  if (!player || player.league_id !== leagueId) {
    return NextResponse.json({ error: 'שחקן לא נמצא בליגה הזו' }, { status: 404 })
  }

  // Append. Positions are only ever read as an ordering, so a gap left by a
  // removal is harmless — the reorder route renumbers when the manager cares.
  const { data: last } = await admin
    .from('open_nomination_queue')
    .select('position')
    .eq('team_id', actor.teamId)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { error } = await admin.from('open_nomination_queue').upsert(
    {
      league_id: leagueId,
      team_id: actor.teamId,
      player_id: playerId,
      position: (last?.position ?? 0) + 1,
      opening_bid: 1,
    },
    { onConflict: 'team_id,player_id', ignoreDuplicates: true }
  )
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
