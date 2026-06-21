import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { validateTrade, type TradeAssetInput } from '@/lib/trades'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  const body = await req.json()
  const league_id: string = body.league_id
  const target_team_id: string = body.target_team_id
  const assets: TradeAssetInput[] = body.assets
  const note: string | null = body.note ?? null

  if (!league_id || !target_team_id || !Array.isArray(assets)) {
    return NextResponse.json({ error: 'חסרים פרטים' }, { status: 400 })
  }

  const admin = createAdminClient()

  // The proposing team is the caller's team in this league.
  const { data: myTeam } = await admin
    .from('teams').select('id')
    .eq('league_id', league_id).eq('user_id', user.id).maybeSingle()
  if (!myTeam) return NextResponse.json({ error: 'אינך חלק מהליגה' }, { status: 403 })

  const proposingTeamId = myTeam.id
  if (proposingTeamId === target_team_id) {
    return NextResponse.json({ error: 'לא ניתן לסחור עם עצמך' }, { status: 400 })
  }

  const valid = await validateTrade(admin, {
    leagueId: league_id,
    proposingTeamId,
    targetTeamId: target_team_id,
    assets,
  })
  if (!valid.ok) return NextResponse.json({ error: valid.error }, { status: 400 })

  const { data: trade, error: tErr } = await admin.from('trades').insert({
    league_id,
    proposing_team_id: proposingTeamId,
    target_team_id,
    note,
    status: 'pending_target',
  }).select('id').single()
  if (tErr || !trade) {
    return NextResponse.json({ error: tErr?.message ?? 'שגיאה ביצירת הטרייד' }, { status: 500 })
  }

  const rows = assets.map(a => ({
    trade_id: trade.id,
    from_team_id: a.from_team_id,
    asset_type: a.asset_type,
    overall_pick_number: a.asset_type === 'pick' ? a.overall_pick_number : null,
    player_id: a.asset_type === 'player' ? a.player_id : null,
  }))
  const { error: aErr } = await admin.from('trade_assets').insert(rows)
  if (aErr) {
    await admin.from('trades').delete().eq('id', trade.id)
    return NextResponse.json({ error: aErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, trade_id: trade.id })
}
