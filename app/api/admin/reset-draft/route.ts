import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'

export async function POST(req: Request) {
  const supabase = await createClient()
  const user = await getAuthUser(supabase)
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  const { leagueId } = await req.json()
  if (!leagueId) return NextResponse.json({ error: 'חסר leagueId' }, { status: 400 })

  const admin = createAdminClient()

  const { data: league } = await admin
    .from('leagues').select('id, created_by, budget_per_team, draft_type').eq('id', leagueId).maybeSingle()
  if (!league) return NextResponse.json({ error: 'ליגה לא נמצאה' }, { status: 404 })
  if (league.created_by !== user.id) {
    return NextResponse.json({ error: 'רק יוצר הליגה יכול לאפס את הדראפט' }, { status: 403 })
  }

  const now = new Date().toISOString()

  // Delete draft artifacts first (child rows before parents).
  // Envelope: auctions (bids cascade) + priority_log audit trail.
  await admin.from('auctions').delete().eq('league_id', leagueId) // cascades to bids
  await admin.from('priority_log').delete().eq('league_id', leagueId)

  // Snake: picks + trade system.
  if (league.draft_type === 'snake') {
    await admin.from('trades').delete().eq('league_id', leagueId) // cascades to trade_assets
    await admin.from('pick_overrides').delete().eq('league_id', leagueId)
    await admin.from('snake_picks').delete().eq('league_id', leagueId)
  }

  // Return every player to the available pool.
  const { error: playersErr } = await admin.from('players')
    .update({ status: 'available', drafted_by_team_id: null, draft_price: null, roster_slot: null })
    .eq('league_id', leagueId)
  if (playersErr) return NextResponse.json({ error: 'שגיאה באיפוס שחקנים: ' + playersErr.message }, { status: 500 })

  // Reset every team's draft state — keep the team, owner, assistant and approval.
  const { error: teamsErr } = await admin.from('teams')
    .update({
      budget_remaining: league.budget_per_team,
      player_count: 0,
      is_complete: false,
      priority_rank: null,
      tiebreak_rank: null,
      updated_at: now,
    })
    .eq('league_id', leagueId)
  if (teamsErr) return NextResponse.json({ error: 'שגיאה באיפוס קבוצות: ' + teamsErr.message }, { status: 500 })

  // Back to pre-draft; lottery must be re-run.
  const { error: leagueErr } = await admin.from('leagues')
    .update({ status: 'setup', updated_at: now })
    .eq('id', leagueId)
  if (leagueErr) return NextResponse.json({ error: 'שגיאה בעדכון סטטוס ליגה: ' + leagueErr.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
