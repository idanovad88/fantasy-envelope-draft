import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getSnakeTeamForPick } from '@/lib/utils'
import type { Team } from '@/types'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  const { league_id, player_id, team_id: requestedTeamId } = await req.json()
  if (!league_id || !player_id) return NextResponse.json({ error: 'חסרים פרטים' }, { status: 400 })

  const admin = createAdminClient()

  // Load league
  const { data: league } = await admin.from('leagues').select('*').eq('id', league_id).single()
  if (!league) return NextResponse.json({ error: 'ליגה לא נמצאה' }, { status: 404 })
  if (league.draft_type !== 'snake') return NextResponse.json({ error: 'ליגה זו אינה דראפט סנייק' }, { status: 400 })
  if (league.status !== 'active') return NextResponse.json({ error: 'הדראפט אינו פעיל' }, { status: 400 })

  // Check if user is admin
  const { data: adminRow } = await admin.from('admin_users').select('user_id').eq('user_id', user.id).eq('league_id', league_id).maybeSingle()
  const isLeagueCreator = league.created_by === user.id
  const isAdmin = !!adminRow || isLeagueCreator

  // Load teams sorted by priority_rank
  const { data: teams } = await admin
    .from('teams')
    .select('*')
    .eq('league_id', league_id)
    .eq('approved', true)
    .not('priority_rank', 'is', null)
    .order('priority_rank', { ascending: true })

  if (!teams || teams.length === 0) return NextResponse.json({ error: 'אין קבוצות בליגה' }, { status: 400 })

  // Count completed picks
  const { count: completedCount } = await admin
    .from('snake_picks')
    .select('id', { count: 'exact', head: true })
    .eq('league_id', league_id)

  const totalPicks = league.num_teams * league.players_per_team
  if ((completedCount ?? 0) >= totalPicks) {
    return NextResponse.json({ error: 'הדראפט הסתיים' }, { status: 400 })
  }

  const nextPickNumber = (completedCount ?? 0) + 1
  const currentTeam = getSnakeTeamForPick(nextPickNumber, league.num_teams, teams as Team[], league.snake_round_config as boolean[] | null)
  if (!currentTeam) return NextResponse.json({ error: 'לא ניתן לקבוע קבוצה בתור' }, { status: 500 })

  // Determine which team is picking
  let pickingTeamId: string
  if (isAdmin && requestedTeamId) {
    pickingTeamId = requestedTeamId
    if (requestedTeamId !== currentTeam.id) {
      return NextResponse.json({ error: `לא תור הקבוצה הזו. תור: ${currentTeam.name}` }, { status: 400 })
    }
  } else {
    // Non-admin: must be the current team's user
    const { data: myTeam } = await admin
      .from('teams')
      .select('id')
      .eq('league_id', league_id)
      .eq('user_id', user.id)
      .maybeSingle()

    if (!myTeam) return NextResponse.json({ error: 'אינך חלק מהליגה' }, { status: 403 })
    if (myTeam.id !== currentTeam.id) return NextResponse.json({ error: `לא התורה שלך. תור: ${currentTeam.name}` }, { status: 400 })
    pickingTeamId = myTeam.id
  }

  // Validate player is available
  const { data: player } = await admin.from('players').select('id, status, name').eq('id', player_id).eq('league_id', league_id).single()
  if (!player) return NextResponse.json({ error: 'שחקן לא נמצא' }, { status: 404 })
  if (player.status !== 'available') return NextResponse.json({ error: 'שחקן אינו זמין' }, { status: 400 })

  // Calculate round and pick_in_round
  const round = Math.ceil(nextPickNumber / league.num_teams)
  const pickInRound = ((nextPickNumber - 1) % league.num_teams) + 1

  // Insert snake pick
  const { error: pickErr } = await admin.from('snake_picks').insert({
    league_id,
    team_id: pickingTeamId,
    player_id,
    overall_pick_number: nextPickNumber,
    round,
    pick_in_round: pickInRound,
  })
  if (pickErr) return NextResponse.json({ error: pickErr.message }, { status: 500 })

  // Update player status
  await admin.from('players').update({
    status: 'drafted',
    drafted_by_team_id: pickingTeamId,
    draft_price: null,
  }).eq('id', player_id)

  // Update team player_count and is_complete
  const pickingTeam = (teams as Team[]).find(t => t.id === pickingTeamId)
  const newCount = (pickingTeam?.player_count ?? 0) + 1
  const isComplete = newCount >= league.players_per_team
  await admin.from('teams').update({
    player_count: newCount,
    is_complete: isComplete,
  }).eq('id', pickingTeamId)

  // Assign roster slot (reuse existing Supabase function)
  await admin.rpc('assign_roster_slot', {
    p_player_id: player_id,
    p_team_id: pickingTeamId,
    p_league_id: league_id,
  }).maybeSingle()

  // Check if draft is complete (all teams done)
  const { count: completedTeams } = await admin
    .from('teams')
    .select('id', { count: 'exact', head: true })
    .eq('league_id', league_id)
    .eq('is_complete', true)

  const { count: totalTeams } = await admin
    .from('teams')
    .select('id', { count: 'exact', head: true })
    .eq('league_id', league_id)
    .eq('approved', true)

  if ((completedTeams ?? 0) >= (totalTeams ?? 1)) {
    await admin.from('leagues').update({ status: 'completed' }).eq('id', league_id)
  }

  return NextResponse.json({ success: true, pick: nextPickNumber, team: currentTeam.name, player: player.name })
}
