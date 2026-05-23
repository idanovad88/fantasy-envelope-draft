import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'

export async function POST(req: Request) {
  const { leagueName, joinCode } = await req.json()
  if (!leagueName?.trim()) {
    return NextResponse.json({ found: false, error: 'חסר שם ליגה' })
  }

  const admin = createAdminClient()

  let query = admin
    .from('leagues')
    .select('id, name, budget_per_team, status')
    .ilike('name', leagueName.trim())

  if (joinCode?.trim()) {
    query = query.eq('join_code', joinCode.trim().toUpperCase())
  }

  const { data: league } = await query.maybeSingle()

  if (!league) {
    return NextResponse.json({
      found: false,
      error: joinCode?.trim() ? 'שם הליגה או הסיסמה שגויים' : 'ליגה לא נמצאה',
    })
  }

  if (league.status === 'completed') {
    return NextResponse.json({ found: false, error: 'הדראפט הסתיים — לא ניתן להצטרף' })
  }

  return NextResponse.json({ found: true, league: { id: league.id, name: league.name, budget_per_team: league.budget_per_team } })
}
