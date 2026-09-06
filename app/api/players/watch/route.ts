import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'
import { myTeamOr } from '@/lib/team'

/**
 * Star / unstar a player.
 *
 * The list is per USER, not per team — an owner and their assistant manager
 * each keep their own, and nobody sees anyone else's. It is what the open-draft
 * cron reads to decide who to notify when a player goes up or is raised.
 *
 * `player_watch` has own-rows-only RLS, so the browser could write it directly;
 * it goes through here instead to also check that the caller is actually in the
 * player's league, the same membership test as /api/leagues/hide.
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const user = await getAuthUser(supabase)
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  const { player_id, watched } = await req.json()
  if (!player_id || typeof watched !== 'boolean') {
    return NextResponse.json({ error: 'פרמטרים חסרים' }, { status: 400 })
  }

  const admin = createAdminClient()

  const { data: player } = await admin
    .from('players')
    .select('id, league_id')
    .eq('id', player_id)
    .maybeSingle()
  if (!player) return NextResponse.json({ error: 'שחקן לא נמצא' }, { status: 404 })

  const leagueId = player.league_id as string
  const [{ data: myTeam }, { data: adminRow }, { data: league }] = await Promise.all([
    admin.from('teams').select('id').or(myTeamOr(user.id)).eq('league_id', leagueId).limit(1).maybeSingle(),
    admin.from('admin_users').select('user_id').eq('user_id', user.id).eq('league_id', leagueId).maybeSingle(),
    admin.from('leagues').select('created_by').eq('id', leagueId).maybeSingle(),
  ])
  const isMember = !!myTeam || !!adminRow || league?.created_by === user.id
  if (!isMember) return NextResponse.json({ error: 'אין הרשאה' }, { status: 403 })

  if (watched) {
    const { error } = await admin
      .from('player_watch')
      .upsert(
        { user_id: user.id, league_id: leagueId, player_id },
        { onConflict: 'user_id,player_id', ignoreDuplicates: true }
      )
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  } else {
    const { error } = await admin
      .from('player_watch')
      .delete()
      .eq('user_id', user.id)
      .eq('player_id', player_id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
