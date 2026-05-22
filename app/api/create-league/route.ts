import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  const { leagueName, joinCode, numTeams, playersPerTeam, budgetPerTeam, minBid, teamName } = await req.json()
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

  const { data: existing } = await admin
    .from('leagues')
    .select('id')
    .ilike('name', leagueName.trim())
    .maybeSingle()

  if (existing) {
    return NextResponse.json({ error: 'ליגה בשם זה כבר קיימת — בחר שם אחר' }, { status: 400 })
  }

  const { data: league, error: leagueErr } = await admin
    .from('leagues')
    .insert({
      name: leagueName.trim(),
      join_code: joinCode?.trim().toUpperCase() || null,
      created_by: user.id,
      ...(numTeams != null && { num_teams: numTeams }),
      ...(playersPerTeam != null && { players_per_team: playersPerTeam }),
      ...(budgetPerTeam != null && { budget_per_team: budgetPerTeam }),
      ...(minBid != null && { min_bid: minBid }),
    })
    .select()
    .single()

  if (leagueErr) return NextResponse.json({ error: leagueErr.message }, { status: 500 })

  const { error: adminErr } = await admin.from('admin_users').upsert({
    user_id: user.id,
    league_id: league.id,
    role: 'admin',
  }, { onConflict: 'user_id' })

  if (adminErr) return NextResponse.json({ error: adminErr.message }, { status: 500 })

  if (teamName?.trim()) {
    await admin.from('teams').insert({
      league_id: league.id,
      name: teamName.trim(),
      user_id: user.id,
      budget_remaining: budgetPerTeam ?? 200,
      approved: true,
    })
  }

  return NextResponse.json({ success: true })
}
