import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createClient, createAdminClient } from '@/lib/supabase/server'

// Owner generates a shareable invite link to attach an assistant manager to their team.
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  const cookieStore = await cookies()
  const leagueId = cookieStore.get('selected_league_id')?.value
  if (!leagueId) return NextResponse.json({ error: 'לא נבחרה ליגה' }, { status: 400 })

  const admin = createAdminClient()

  // Caller must own a team in the selected league
  const { data: team } = await admin
    .from('teams').select('id, league_id, assistant_user_id')
    .eq('user_id', user.id).eq('league_id', leagueId).maybeSingle()
  if (!team) return NextResponse.json({ error: 'אין לך קבוצה בליגה זו' }, { status: 403 })
  if (team.assistant_user_id) return NextResponse.json({ error: 'לקבוצה כבר יש עוזר מנהל' }, { status: 400 })

  // Keep a single active invite per team — clear prior unused ones
  await admin.from('team_invites').delete().eq('team_id', team.id).is('used_at', null)

  const { data: invite, error } = await admin.from('team_invites').insert({
    team_id: team.id,
    league_id: team.league_id,
    created_by: user.id,
  }).select('token').single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const origin = new URL(req.url).origin
  return NextResponse.json({ url: `${origin}/assist/${invite.token}` })
}
