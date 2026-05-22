import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  const { data: callerAdmin } = await supabase
    .from('admin_users').select('league_id').eq('user_id', user.id).maybeSingle()
  if (!callerAdmin) return NextResponse.json({ error: 'אין הרשאה' }, { status: 403 })

  const { teamId, grant } = await req.json()
  if (!teamId || grant === undefined) return NextResponse.json({ error: 'חסרים פרטים' }, { status: 400 })

  const admin = createAdminClient()

  // Fetch team to get its user_id and league_id
  const { data: team } = await admin
    .from('teams').select('user_id, league_id').eq('id', teamId).maybeSingle()
  if (!team) return NextResponse.json({ error: 'קבוצה לא נמצאה' }, { status: 404 })
  if (team.league_id !== callerAdmin.league_id) {
    return NextResponse.json({ error: 'אין הרשאה לליגה זו' }, { status: 403 })
  }

  if (grant) {
    const { error } = await admin.from('admin_users').upsert(
      { user_id: team.user_id, league_id: team.league_id, role: 'admin' },
      { onConflict: 'user_id' }
    )
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  } else {
    const { error } = await admin.from('admin_users').delete().eq('user_id', team.user_id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
