import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'

// Remove a team's assistant manager. Allowed for the team owner, the assistant
// themselves (stepping down), OR the league admin/creator.
export async function POST(req: Request) {
  const supabase = await createClient()
  const user = await getAuthUser(supabase)
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  const { teamId } = await req.json()
  if (!teamId) return NextResponse.json({ error: 'חסר מזהה קבוצה' }, { status: 400 })

  const admin = createAdminClient()

  const { data: team } = await admin
    .from('teams').select('id, league_id, user_id, assistant_user_id').eq('id', teamId).maybeSingle()
  if (!team) return NextResponse.json({ error: 'קבוצה לא נמצאה' }, { status: 404 })

  // Authorize: team owner, the assistant stepping down, OR admin/creator for this league
  let allowed = team.user_id === user.id || team.assistant_user_id === user.id
  if (!allowed) {
    const { data: callerAdmin } = await supabase
      .from('admin_users').select('league_id').eq('user_id', user.id).eq('league_id', team.league_id).maybeSingle()
    const { data: ownedLeague } = !callerAdmin
      ? await supabase.from('leagues').select('id').eq('id', team.league_id).eq('created_by', user.id).maybeSingle()
      : { data: null }
    allowed = !!callerAdmin || !!ownedLeague
  }
  if (!allowed) return NextResponse.json({ error: 'אין הרשאה לליגה זו' }, { status: 403 })

  const { error } = await admin.from('teams')
    .update({ assistant_user_id: null, updated_at: new Date().toISOString() })
    .eq('id', teamId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Drop any outstanding unused invites for this team
  await admin.from('team_invites').delete().eq('team_id', teamId).is('used_at', null)

  return NextResponse.json({ success: true })
}
