import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  const { trade_id } = await req.json()
  if (!trade_id) return NextResponse.json({ error: 'חסר מזהה טרייד' }, { status: 400 })

  const admin = createAdminClient()

  const { data: trade } = await admin
    .from('trades').select('id, status, proposing_team_id').eq('id', trade_id).maybeSingle()
  if (!trade) return NextResponse.json({ error: 'הטרייד לא נמצא' }, { status: 404 })
  if (!['pending_target', 'pending_admin'].includes(trade.status)) {
    return NextResponse.json({ error: 'לא ניתן לבטל טרייד שכבר טופל' }, { status: 400 })
  }

  // Only the proposing team's user may cancel.
  const { data: proposingTeam } = await admin
    .from('teams').select('user_id').eq('id', trade.proposing_team_id).maybeSingle()
  if (!proposingTeam || proposingTeam.user_id !== user.id) {
    return NextResponse.json({ error: 'רק מי שהציע את הטרייד יכול לבטל' }, { status: 403 })
  }

  const { error } = await admin.from('trades').update({ status: 'cancelled' }).eq('id', trade_id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
