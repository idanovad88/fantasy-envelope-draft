import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'
import { validateTrade, type TradeAssetInput } from '@/lib/trades'
import { validateAuctionTrade, isAuctionDraft, teamManagerIds, pushTradeUpdate } from '@/lib/auctionTrades'

// web-push (auction trades) needs Node's crypto.
export const runtime = 'nodejs'

export async function POST(req: Request) {
  const supabase = await createClient()
  const user = await getAuthUser(supabase)
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  const body = await req.json()
  const league_id: string = body.league_id
  const target_team_id: string = body.target_team_id
  const note: string | null = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 300) : null

  if (!league_id || !target_team_id) {
    return NextResponse.json({ error: 'חסרים פרטים' }, { status: 400 })
  }

  const admin = createAdminClient()

  // The proposing team is the caller's team in this league. Owner only —
  // assistant managers never trade.
  const { data: myTeam } = await admin
    .from('teams').select('id, name')
    .eq('league_id', league_id).eq('user_id', user.id).maybeSingle()
  if (!myTeam) return NextResponse.json({ error: 'אינך חלק מהליגה' }, { status: 403 })

  const proposingTeamId = myTeam.id
  if (proposingTeamId === target_team_id) {
    return NextResponse.json({ error: 'לא ניתן לסחור עם עצמך' }, { status: 400 })
  }

  const { data: league } = await admin.from('leagues').select('draft_type').eq('id', league_id).maybeSingle()
  if (!league) return NextResponse.json({ error: 'ליגה לא נמצאה' }, { status: 404 })
  const isAuction = isAuctionDraft(league.draft_type)

  let assets: TradeAssetInput[]
  let cashFromTeamId: string | null = null
  let cashAmount = 0

  if (isAuction) {
    const give: string[] = Array.isArray(body.give_player_ids) ? body.give_player_ids : []
    const get: string[] = Array.isArray(body.get_player_ids) ? body.get_player_ids : []
    cashAmount = Number(body.cash_amount ?? 0)
    if (cashAmount > 0) {
      if (body.cash_direction !== 'give' && body.cash_direction !== 'get') {
        return NextResponse.json({ error: 'כיוון הכסף לא תקין' }, { status: 400 })
      }
      cashFromTeamId = body.cash_direction === 'give' ? proposingTeamId : target_team_id
    }

    const valid = await validateAuctionTrade(admin, {
      leagueId: league_id,
      proposingTeamId,
      targetTeamId: target_team_id,
      proposingPlayerIds: give,
      targetPlayerIds: get,
      cashFromTeamId,
      cashAmount,
      sealedFloorFor: proposingTeamId,
    })
    if (!valid.ok) return NextResponse.json({ error: valid.error }, { status: 400 })

    assets = [
      ...give.map(id => ({ from_team_id: proposingTeamId, asset_type: 'player' as const, player_id: id })),
      ...get.map(id => ({ from_team_id: target_team_id, asset_type: 'player' as const, player_id: id })),
    ]
  } else {
    assets = body.assets
    if (!Array.isArray(assets)) return NextResponse.json({ error: 'חסרים פרטים' }, { status: 400 })
    const valid = await validateTrade(admin, {
      leagueId: league_id,
      proposingTeamId,
      targetTeamId: target_team_id,
      assets,
    })
    if (!valid.ok) return NextResponse.json({ error: valid.error }, { status: 400 })
  }

  const { data: trade, error: tErr } = await admin.from('trades').insert({
    league_id,
    proposing_team_id: proposingTeamId,
    target_team_id,
    note,
    status: 'pending_target',
    cash_from_team_id: cashAmount > 0 ? cashFromTeamId : null,
    cash_amount: cashAmount,
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

  if (isAuction) {
    pushTradeUpdate(
      () => teamManagerIds(admin, [target_team_id]),
      trade.id,
      '🔄 הצעת טרייד חדשה',
      `${myTeam.name} שלחו לך הצעת טרייד`,
      '/',
      user.id
    )
  }

  return NextResponse.json({ success: true, trade_id: trade.id })
}
