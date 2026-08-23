import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'

// Recipient redeems an invite link → becomes the team's assistant manager.
export async function POST(req: Request) {
  const supabase = await createClient()
  const user = await getAuthUser(supabase)
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  const { token } = await req.json()
  if (!token) return NextResponse.json({ error: 'חסר טוקן' }, { status: 400 })

  const admin = createAdminClient()

  const { data: invite } = await admin
    .from('team_invites').select('*').eq('token', token).maybeSingle()
  if (!invite) return NextResponse.json({ error: 'ההזמנה אינה תקפה' }, { status: 404 })
  if (invite.used_at) return NextResponse.json({ error: 'ההזמנה כבר נוצלה' }, { status: 400 })
  if (new Date(invite.expires_at).getTime() < Date.now())
    return NextResponse.json({ error: 'תוקף ההזמנה פג' }, { status: 400 })

  const { data: team } = await admin
    .from('teams').select('id, league_id, user_id, assistant_user_id, name')
    .eq('id', invite.team_id).maybeSingle()
  if (!team) return NextResponse.json({ error: 'הקבוצה לא נמצאה' }, { status: 404 })
  if (team.assistant_user_id) return NextResponse.json({ error: 'לקבוצה כבר יש עוזר מנהל' }, { status: 400 })
  if (team.user_id === user.id) return NextResponse.json({ error: 'אתה כבר מנהל הקבוצה' }, { status: 400 })

  // One team per league per user (as owner or assistant) — keeps resolution unambiguous
  const { data: existing } = await admin
    .from('teams').select('id').eq('league_id', team.league_id)
    .or(`user_id.eq.${user.id},assistant_user_id.eq.${user.id}`).limit(1).maybeSingle()
  if (existing) return NextResponse.json({ error: 'אתה כבר משויך לקבוצה בליגה זו' }, { status: 400 })

  const { error: updErr } = await admin.from('teams')
    .update({ assistant_user_id: user.id, updated_at: new Date().toISOString() })
    .eq('id', team.id)
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })

  await admin.from('team_invites')
    .update({ used_at: new Date().toISOString(), used_by: user.id })
    .eq('token', token)

  // Land the assistant in this league
  const cookieStore = await cookies()
  cookieStore.set('selected_league_id', team.league_id, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  })

  return NextResponse.json({ success: true, teamName: team.name })
}
