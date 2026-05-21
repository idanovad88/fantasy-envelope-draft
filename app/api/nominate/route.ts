import { createClient, createAdminClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const userClient = await createClient()
  const { data: { user } } = await userClient.auth.getUser()
  const supabase = createAdminClient()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { player_id, league_id } = await req.json()
  if (!player_id || !league_id) return NextResponse.json({ error: 'Missing data' }, { status: 400 })

  const [{ data: league }, { data: myTeam }, { data: adminRow }, { count: activeCount }, { data: teams }] = await Promise.all([
    supabase.from('leagues').select('*').eq('id', league_id).single(),
    supabase.from('teams').select('*').eq('user_id', user.id).eq('league_id', league_id).maybeSingle(),
    supabase.from('admin_users').select('role').eq('user_id', user.id).maybeSingle(),
    supabase.from('auctions').select('id', { count: 'exact', head: true }).eq('league_id', league_id).eq('status', 'active'),
    supabase.from('teams').select('id, priority_rank').eq('league_id', league_id).eq('approved', true).eq('is_complete', false).not('priority_rank', 'is', null).order('priority_rank', { ascending: true }),
  ])

  const isAdmin = !!adminRow

  if (!league) return NextResponse.json({ error: 'ליגה לא נמצאה' }, { status: 404 })
  if (league.status !== 'active') return NextResponse.json({ error: 'הליגה לא פעילה' }, { status: 400 })
  if (activeCount && activeCount > 0) return NextResponse.json({ error: 'יש מכרז פעיל כרגע — המתן לסיומו' }, { status: 400 })

  if (!isAdmin) {
    if (!myTeam) return NextResponse.json({ error: 'לא נמצאה קבוצה עבורך' }, { status: 404 })
    if (myTeam.is_complete) return NextResponse.json({ error: 'הקבוצה שלך הושלמה' }, { status: 400 })
    const currentNominator = teams?.[0]
    if (!currentNominator || currentNominator.id !== myTeam.id) {
      return NextResponse.json({ error: 'לא התורך להעלות שחקן' }, { status: 403 })
    }
  }

  // The nominating team is always the current front-of-queue team
  const nominatingTeamId = teams?.[0]?.id ?? myTeam?.id ?? null

  const { data: player } = await supabase.from('players').select('*').eq('id', player_id).eq('league_id', league_id).maybeSingle()
  if (!player) return NextResponse.json({ error: 'שחקן לא נמצא' }, { status: 404 })
  if (player.status !== 'available') return NextResponse.json({ error: 'שחקן לא זמין' }, { status: 400 })

  const now = new Date()
  const revealMinutes = league.reveal_before_minutes ?? 30
  const nextNomination = new Date(now.getTime() + league.nomination_interval_hours * 60 * 60 * 1000)
  const revealTime = new Date(nextNomination.getTime() - revealMinutes * 60 * 1000)

  const { count: slotCount } = await supabase.from('auctions').select('id', { count: 'exact', head: true }).eq('league_id', league_id)
  const slotNum = (slotCount ?? 0) + 1

  const { data: auction, error: auctionErr } = await supabase.from('auctions').insert({
    league_id,
    player_id,
    nominating_team_id: nominatingTeamId,
    slot_number: slotNum,
    scheduled_start: now.toISOString(),
    reveal_time: revealTime.toISOString(),
    status: 'active',
  }).select().single()

  if (auctionErr) return NextResponse.json({ error: auctionErr.message }, { status: 500 })

  await supabase.from('players').update({ status: 'on_auction' }).eq('id', player_id)

  // Auto $1 bid for the nominating team (only if there is one)
  if (!nominatingTeamId) return NextResponse.json({ success: true })
  const { error: bidErr } = await supabase.from('bids').insert({
    auction_id: auction.id,
    team_id: nominatingTeamId,
    amount: 1,
  })

  if (bidErr) return NextResponse.json({ error: bidErr.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
