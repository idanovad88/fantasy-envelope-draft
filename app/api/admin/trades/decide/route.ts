import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { validateTrade, type TradeAssetInput } from '@/lib/trades'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  const { trade_id, action, rejection_reason } = await req.json()
  if (!trade_id || (action !== 'approve' && action !== 'reject')) {
    return NextResponse.json({ error: 'בקשה לא תקינה' }, { status: 400 })
  }

  const admin = createAdminClient()

  const { data: trade } = await admin
    .from('trades')
    .select('id, status, league_id, proposing_team_id, target_team_id')
    .eq('id', trade_id).maybeSingle()
  if (!trade) return NextResponse.json({ error: 'הטרייד לא נמצא' }, { status: 404 })

  // Caller must be an admin of the league (row in admin_users) or its creator.
  const { data: league } = await admin.from('leagues').select('created_by').eq('id', trade.league_id).single()
  const { data: adminRow } = await admin
    .from('admin_users').select('user_id')
    .eq('user_id', user.id).eq('league_id', trade.league_id).maybeSingle()
  const isAdmin = !!adminRow || league?.created_by === user.id
  if (!isAdmin) return NextResponse.json({ error: 'רק מנהל הליגה יכול לאשר טריידים' }, { status: 403 })

  if (trade.status !== 'pending_admin') {
    return NextResponse.json({ error: 'הטרייד אינו ממתין לאישור מנהל' }, { status: 400 })
  }

  if (action === 'reject') {
    const { error } = await admin.from('trades').update({
      status: 'rejected',
      rejection_reason: rejection_reason ?? null,
      admin_user_id: user.id,
      admin_responded_at: new Date().toISOString(),
    }).eq('id', trade_id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, status: 'rejected' })
  }

  // Approve: re-validate against current state (ownership may have changed).
  const { data: assetRows } = await admin
    .from('trade_assets').select('from_team_id, asset_type, overall_pick_number, player_id')
    .eq('trade_id', trade_id)
  const assets = (assetRows ?? []) as TradeAssetInput[]

  const valid = await validateTrade(admin, {
    leagueId: trade.league_id,
    proposingTeamId: trade.proposing_team_id,
    targetTeamId: trade.target_team_id,
    assets,
    excludeTradeId: trade_id,
  })
  if (!valid.ok) {
    return NextResponse.json({ error: `הטרייד אינו תקין יותר: ${valid.error}` }, { status: 400 })
  }

  await admin.from('trades').update({ admin_user_id: user.id }).eq('id', trade_id)

  const { error: execErr } = await admin.rpc('execute_trade', { p_trade_id: trade_id })
  if (execErr) return NextResponse.json({ error: execErr.message }, { status: 500 })

  return NextResponse.json({ success: true, status: 'approved' })
}
