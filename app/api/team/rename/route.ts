import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'

const MAX_NAME_LENGTH = 40
const TAKEN = 'שם קבוצה זה כבר תפוס — בחר שם אחר'

// Rename a team. Allowed for the team owner OR the league admin/creator —
// deliberately NOT the assistant manager: a team name doubles as a credential in
// /api/join-league (a matching name re-links the team to whoever types it), so an
// assistant who could free the old name could then claim a second team with it.
export async function POST(req: Request) {
  const supabase = await createClient()
  const user = await getAuthUser(supabase)
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  const { teamId, name } = await req.json()
  if (!teamId) return NextResponse.json({ error: 'חסר מזהה קבוצה' }, { status: 400 })

  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (!trimmed || trimmed.length > MAX_NAME_LENGTH) {
    return NextResponse.json({ error: 'שם קבוצה לא תקין' }, { status: 400 })
  }

  const admin = createAdminClient()

  const { data: team } = await admin
    .from('teams').select('id, league_id, name, user_id').eq('id', teamId).maybeSingle()
  if (!team) return NextResponse.json({ error: 'קבוצה לא נמצאה' }, { status: 404 })

  // Authorize: team owner OR admin/creator for this league
  let allowed = team.user_id === user.id
  if (!allowed) {
    const { data: callerAdmin } = await supabase
      .from('admin_users').select('league_id').eq('user_id', user.id).eq('league_id', team.league_id).maybeSingle()
    const { data: ownedLeague } = !callerAdmin
      ? await supabase.from('leagues').select('id').eq('id', team.league_id).eq('created_by', user.id).maybeSingle()
      : { data: null }
    allowed = !!callerAdmin || !!ownedLeague
  }
  if (!allowed) return NextResponse.json({ error: 'אין הרשאה לליגה זו' }, { status: 403 })

  if (trimmed === team.name) return NextResponse.json({ success: true, name: trimmed })

  // UNIQUE(league_id, name) is case-sensitive but /api/join-league matches with
  // ilike — two case variants would pass the constraint and then break that
  // route's .maybeSingle(). Check case-insensitively here instead.
  // Read as an array, not maybeSingle(): a league that already holds two variants
  // must still get a clean 409 rather than a crash.
  const { data: clashes } = await admin
    .from('teams').select('id')
    .eq('league_id', team.league_id)
    .ilike('name', trimmed)
    .neq('id', teamId)
    .limit(1)
  if (clashes && clashes.length > 0) return NextResponse.json({ error: TAKEN }, { status: 409 })

  const { error } = await admin.from('teams')
    .update({ name: trimmed, updated_at: new Date().toISOString() })
    .eq('id', teamId)
  if (error) {
    // 23505 = the unique constraint, i.e. an exact-case race with another rename
    if (error.code === '23505') return NextResponse.json({ error: TAKEN }, { status: 409 })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, name: trimmed })
}
