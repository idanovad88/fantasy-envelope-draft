import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  const { trade_id, action } = await req.json()
  if (!trade_id || (action !== 'accept' && action !== 'reject')) {
    return NextResponse.json({ error: 'בקשה לא תקינה' }, { status: 400 })
  }

  const admin = createAdminClient()

  const { data: trade } = await admin
    .from('trades').select('id, status, target_team_id').eq('id', trade_id).maybeSingle()
  if (!trade) return NextResponse.json({ error: 'הטרייד לא נמצא' }, { status: 404 })
  if (trade.status !== 'pending_target') {
    return NextResponse.json({ error: 'הטרייד כבר טופל' }, { status: 400 })
  }

  // Only the target team's user may respond.
  const { data: targetTeam } = await admin
    .from('teams').select('user_id').eq('id', trade.target_team_id).maybeSingle()
  if (!targetTeam || targetTeam.user_id !== user.id) {
    return NextResponse.json({ error: 'רק הקבוצה שקיבלה את ההצעה יכולה להגיב' }, { status: 403 })
  }

  const newStatus = action === 'accept' ? 'pending_admin' : 'rejected'
  const { error } = await admin
    .from('trades')
    .update({ status: newStatus, target_responded_at: new Date().toISOString() })
    .eq('id', trade_id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, status: newStatus })
}
