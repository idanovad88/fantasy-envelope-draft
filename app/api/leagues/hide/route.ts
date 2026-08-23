import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'
import { myTeamOr } from '@/lib/team'

export async function POST(req: Request) {
  const supabase = await createClient()
  const user = await getAuthUser(supabase)
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  const { leagueId, hidden } = await req.json()
  if (!leagueId || typeof hidden !== 'boolean') {
    return NextResponse.json({ error: 'פרמטרים חסרים' }, { status: 400 })
  }

  const admin = createAdminClient()

  // Only a member of the league (team owner/assistant, admin, or creator) may hide it.
  const [{ data: myTeam }, { data: adminRow }, { data: league }] = await Promise.all([
    admin.from('teams').select('id').or(myTeamOr(user.id)).eq('league_id', leagueId).limit(1).maybeSingle(),
    admin.from('admin_users').select('user_id').eq('user_id', user.id).eq('league_id', leagueId).maybeSingle(),
    admin.from('leagues').select('created_by').eq('id', leagueId).maybeSingle(),
  ])
  if (!league) return NextResponse.json({ error: 'ליגה לא נמצאה' }, { status: 404 })
  const isMember = !!myTeam || !!adminRow || league.created_by === user.id
  if (!isMember) return NextResponse.json({ error: 'אין הרשאה' }, { status: 403 })

  if (hidden) {
    const { error } = await admin
      .from('league_hidden')
      .upsert({ user_id: user.id, league_id: leagueId }, { onConflict: 'user_id,league_id', ignoreDuplicates: true })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  } else {
    const { error } = await admin
      .from('league_hidden')
      .delete()
      .eq('user_id', user.id)
      .eq('league_id', leagueId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
