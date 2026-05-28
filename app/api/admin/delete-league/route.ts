import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { cookies } from 'next/headers'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  const { leagueId } = await req.json()
  if (!leagueId) return NextResponse.json({ error: 'חסר leagueId' }, { status: 400 })

  const admin = createAdminClient()

  const { data: league } = await admin
    .from('leagues').select('id, created_by').eq('id', leagueId).maybeSingle()
  if (!league) return NextResponse.json({ error: 'ליגה לא נמצאה' }, { status: 404 })
  if (league.created_by !== user.id) return NextResponse.json({ error: 'רק יוצר הליגה יכול למחוק אותה' }, { status: 403 })

  // Delete in dependency order to avoid FK violations
  await admin.from('priority_log').delete().eq('league_id', leagueId)
  await admin.from('auctions').delete().eq('league_id', leagueId)  // cascades to bids
  await admin.from('players').delete().eq('league_id', leagueId)
  await admin.from('teams').delete().eq('league_id', leagueId)
  await admin.from('admin_users').delete().eq('league_id', leagueId)

  const { error } = await admin.from('leagues').delete().eq('id', leagueId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Clear league cookie
  const cookieStore = await cookies()
  cookieStore.delete('selected_league_id')

  return NextResponse.json({ success: true })
}
