import { createClient, createAdminClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const userClient = await createClient()
  const { data: { user } } = await userClient.auth.getUser()
  const supabase = createAdminClient()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { player_id, league_id, nominating_team_id, scheduled_start } = await req.json()
  if (!player_id || !league_id || !scheduled_start) {
    return NextResponse.json({ error: 'Missing data' }, { status: 400 })
  }

  const { data: league } = await supabase.from('leagues').select('*').eq('id', league_id).single()
  if (!league) return NextResponse.json({ error: 'ליגה לא נמצאה' }, { status: 404 })

  // Admin check: row in admin_users OR creator of this league
  const { data: adminRow } = await supabase.from('admin_users').select('role').eq('user_id', user.id).maybeSingle()
  const isAdmin = !!adminRow || league.created_by === user.id
  if (!isAdmin) return NextResponse.json({ error: 'Forbidden — admins only' }, { status: 403 })

  if (league.status !== 'active') return NextResponse.json({ error: 'הליגה לא פעילה' }, { status: 400 })

  const { data: player } = await supabase.from('players').select('status').eq('id', player_id).eq('league_id', league_id).maybeSingle()
  if (!player) return NextResponse.json({ error: 'שחקן לא נמצא' }, { status: 404 })
  if (player.status !== 'available') return NextResponse.json({ error: 'שחקן לא זמין' }, { status: 400 })

  const scheduledStart = new Date(scheduled_start)
  if (isNaN(scheduledStart.getTime())) return NextResponse.json({ error: 'שעת פתיחה לא תקינה' }, { status: 400 })

  const durationHours = league.auction_duration_hours ?? 1.5
  const revealTime = new Date(scheduledStart.getTime() + durationHours * 60 * 60 * 1000)

  // Re-validate server-side: start must not precede the latest reveal of existing
  // active/pending auctions in this league.
  const { data: existing } = await supabase
    .from('auctions')
    .select('reveal_time')
    .eq('league_id', league_id)
    .in('status', ['active', 'pending'])
  const revealTimes = (existing ?? []).map(a => new Date(a.reveal_time).getTime())
  if (revealTimes.length > 0) {
    const latestReveal = Math.max(...revealTimes)
    if (scheduledStart.getTime() < latestReveal) {
      return NextResponse.json({ error: 'שעת הפתיחה חייבת להיות אחרי המכרז האחרון בתור' }, { status: 400 })
    }
  }

  const { count: slotCount } = await supabase.from('auctions').select('id', { count: 'exact', head: true }).eq('league_id', league_id)
  const slotNum = (slotCount ?? 0) + 1
  const status = scheduledStart > new Date() ? 'pending' : 'active'

  // Auto-bid for the nominating team is handled by the trg_auto_bid_nominating_team DB trigger.
  const { error: auctionErr } = await supabase.from('auctions').insert({
    league_id,
    player_id,
    nominating_team_id: nominating_team_id || null,
    slot_number: slotNum,
    scheduled_start: scheduledStart.toISOString(),
    reveal_time: revealTime.toISOString(),
    status,
  })
  if (auctionErr) return NextResponse.json({ error: auctionErr.message }, { status: 500 })

  const { error: playerErr } = await supabase.from('players').update({ status: 'on_auction' }).eq('id', player_id)
  if (playerErr) return NextResponse.json({ error: playerErr.message }, { status: 500 })

  return NextResponse.json({ success: true, status })
}
