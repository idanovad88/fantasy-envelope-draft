import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  const { leagueName, joinCode } = await req.json()
  if (!leagueName?.trim()) return NextResponse.json({ error: 'שם ליגה נדרש' }, { status: 400 })

  // Check whitelist via user's session (RLS: can only see own email row)
  const { data: allowed } = await supabase
    .from('league_creator_whitelist')
    .select('email')
    .eq('email', user.email!)
    .maybeSingle()

  if (!allowed) {
    return NextResponse.json({ error: 'אינך מורשה להקים ליגה. פנה למנהל המערכת.' }, { status: 403 })
  }

  const admin = createAdminClient()

  const { data: league, error: leagueErr } = await admin
    .from('leagues')
    .insert({
      name: leagueName.trim(),
      join_code: joinCode?.trim().toUpperCase() || null,
      created_by: user.id,
    })
    .select()
    .single()

  if (leagueErr) return NextResponse.json({ error: leagueErr.message }, { status: 500 })

  const { error: adminErr } = await admin.from('admin_users').insert({
    user_id: user.id,
    league_id: league.id,
    role: 'admin',
  })

  if (adminErr) return NextResponse.json({ error: adminErr.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
