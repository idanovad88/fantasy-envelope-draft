import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'
import {
  validateAuctionTrade, isAuctionDraft, storedAuctionTradeInput,
  teamManagerIds, leagueAdminIds, pushTradeUpdate,
} from '@/lib/auctionTrades'

// web-push (auction trades) needs Node's crypto.
export const runtime = 'nodejs'

export async function POST(req: Request) {
  const supabase = await createClient()
  const user = await getAuthUser(supabase)
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  const { trade_id, action } = await req.json()
  if (!trade_id || (action !== 'accept' && action !== 'reject')) {
    return NextResponse.json({ error: 'בקשה לא תקינה' }, { status: 400 })
  }

  const admin = createAdminClient()

  const { data: trade } = await admin
    .from('trades')
    .select('id, status, league_id, proposing_team_id, target_team_id, cash_from_team_id, cash_amount')
    .eq('id', trade_id).maybeSingle()
  if (!trade) return NextResponse.json({ error: 'הטרייד לא נמצא' }, { status: 404 })
  if (trade.status !== 'pending_target') {
    return NextResponse.json({ error: 'הטרייד כבר טופל' }, { status: 400 })
  }

  // Only the target team's user may respond.
  const { data: targetTeam } = await admin
    .from('teams').select('user_id, name').eq('id', trade.target_team_id).maybeSingle()
  if (!targetTeam || targetTeam.user_id !== user.id) {
    return NextResponse.json({ error: 'רק הקבוצה שקיבלה את ההצעה יכולה להגיב' }, { status: 403 })
  }

  const { data: league } = await admin.from('leagues').select('draft_type').eq('id', trade.league_id).maybeSingle()
  const isAuction = isAuctionDraft(league?.draft_type)

  // Accepting an auction trade re-checks it now — a player may have moved or a
  // budget shrunk since the offer went out. The target's own sealed bids count.
  if (isAuction && action === 'accept') {
    const valid = await validateAuctionTrade(admin, await storedAuctionTradeInput(admin, trade, trade.target_team_id))
    if (!valid.ok) return NextResponse.json({ error: `הטרייד אינו תקין יותר: ${valid.error}` }, { status: 400 })
  }

  const newStatus = action === 'accept' ? 'pending_admin' : 'rejected'
  const { data: updated, error } = await admin
    .from('trades')
    .update({ status: newStatus, target_responded_at: new Date().toISOString() })
    .eq('id', trade_id).eq('status', 'pending_target')
    .select('id')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!updated || updated.length === 0) return NextResponse.json({ error: 'הטרייד כבר טופל' }, { status: 409 })

  if (isAuction) {
    if (action === 'accept') {
      pushTradeUpdate(() => teamManagerIds(admin, [trade.proposing_team_id]), trade.id,
        '✅ ההצעה שלך התקבלה', `${targetTeam.name} אישרו — הטרייד ממתין לאישור מנהל הליגה`, '/trades', user.id)
      pushTradeUpdate(() => leagueAdminIds(admin, trade.league_id), `${trade.id}-admin`,
        '🔄 טרייד ממתין לאישורך', 'שתי הקבוצות הסכימו — נדרש אישור מנהל', '/admin?tab=trades', user.id)
    } else {
      pushTradeUpdate(() => teamManagerIds(admin, [trade.proposing_team_id]), trade.id,
        '❌ ההצעה נדחתה', `${targetTeam.name} דחו את הצעת הטרייד`, '/trades', user.id)
    }
  }

  return NextResponse.json({ success: true, status: newStatus })
}
