import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  const { data: adminRow } = await supabase
    .from('admin_users').select('league_id').eq('user_id', user.id).maybeSingle()
  if (!adminRow) return NextResponse.json({ error: 'אין הרשאה' }, { status: 403 })

  const { teamId } = await req.json()
  if (!teamId) return NextResponse.json({ error: 'חסר teamId' }, { status: 400 })

  const admin = createAdminClient()

  // Verify team belongs to admin's league
  const { data: team } = await admin
    .from('teams').select('id, league_id').eq('id', teamId).maybeSingle()
  if (!team || team.league_id !== adminRow.league_id) {
    return NextResponse.json({ error: 'קבוצה לא נמצאה' }, { status: 404 })
  }

  // Reset players drafted by this team back to available
  await admin.from('players')
    .update({ status: 'available', draft_price: null, drafted_by_team_id: null })
    .eq('drafted_by_team_id', teamId)

  // Delete bids by this team
  await admin.from('bids').delete().eq('team_id', teamId)

  // Delete the team
  const { error } = await admin.from('teams').delete().eq('id', teamId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
