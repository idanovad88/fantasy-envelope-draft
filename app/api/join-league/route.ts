import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  const { leagueName, joinCode, teamName } = await req.json()
  if (!leagueName?.trim() || !teamName?.trim()) {
    return NextResponse.json({ error: 'חסרים פרטים' }, { status: 400 })
  }

  const admin = createAdminClient()

  // Find league by name + join code
  const { data: league } = await admin
    .from('leagues')
    .select('id, budget_per_team, num_teams, status')
    .ilike('name', leagueName.trim())
    .eq('join_code', joinCode.trim().toUpperCase())
    .maybeSingle()

  if (!league) return NextResponse.json({ error: 'שם הליגה או הסיסמה שגויים' }, { status: 400 })
  if (league.status === 'completed') return NextResponse.json({ error: 'הדראפט הסתיים — לא ניתן להצטרף' }, { status: 400 })

  // Already in league by current user_id → nothing to do
  const { data: existingByUser } = await admin
    .from('teams').select('id').eq('user_id', user.id).eq('league_id', league.id).maybeSingle()
  if (existingByUser) return NextResponse.json({ success: true })

  // Team name exists → re-link to current user (admin client bypasses RLS)
  const { data: existingByName } = await admin
    .from('teams').select('id, user_id').eq('league_id', league.id).ilike('name', teamName.trim()).maybeSingle()
  if (existingByName) {
    const oldUserId = existingByName.user_id
    await admin.from('teams').update({ user_id: user.id }).eq('id', existingByName.id)

    // Transfer admin permissions from old session to new session
    if (oldUserId && oldUserId !== user.id) {
      const { data: oldAdminRow } = await admin
        .from('admin_users').select('league_id, role').eq('user_id', oldUserId).maybeSingle()
      if (oldAdminRow) {
        await admin.from('admin_users').upsert(
          { user_id: user.id, league_id: oldAdminRow.league_id, role: oldAdminRow.role },
          { onConflict: 'user_id' }
        )
        await admin.from('admin_users').delete().eq('user_id', oldUserId)
      }
    }

    return NextResponse.json({ success: true })
  }

  // Check capacity
  const { count: teamCount } = await admin
    .from('teams').select('id', { count: 'exact', head: true }).eq('league_id', league.id)
  if (teamCount !== null && league.num_teams !== null && teamCount >= league.num_teams) {
    return NextResponse.json({ error: 'הליגה מלאה — לא ניתן להצטרף' }, { status: 400 })
  }

  // Create new team
  const { error: insertErr } = await admin.from('teams').insert({
    league_id: league.id,
    name: teamName.trim(),
    user_id: user.id,
    budget_remaining: league.budget_per_team,
    approved: true,
  })

  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
