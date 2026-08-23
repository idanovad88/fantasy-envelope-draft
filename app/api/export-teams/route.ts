import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'
import { cookies } from 'next/headers'
import { myTeamOr } from '@/lib/team'
import { NextResponse } from 'next/server'
import * as XLSX from 'xlsx'

// Export teams + rosters to .xlsx for the user's currently selected league.
// Available to any authenticated user — the /teams page already shows this data
// publicly. League is resolved the same way the /teams page resolves it.
export async function GET() {
  const userClient = await createClient()
  const user = await getAuthUser(userClient)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const cookieStore = await cookies()
  const selectedLeagueId = cookieStore.get('selected_league_id')?.value

  const supabase = createAdminClient()

  const [{ data: myTeam }, { data: adminRow }, { data: createdLeague }] = await Promise.all([
    supabase.from('teams').select('league_id').or(myTeamOr(user.id)).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('admin_users').select('league_id').eq('user_id', user.id).maybeSingle(),
    supabase.from('leagues').select('id').eq('created_by', user.id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ])

  const leagueId = selectedLeagueId ?? myTeam?.league_id ?? adminRow?.league_id ?? createdLeague?.id ?? null
  const { data: league } = leagueId
    ? await supabase.from('leagues').select('*').eq('id', leagueId).maybeSingle()
    : { data: null }
  if (!league) return NextResponse.json({ error: 'לא נמצאה ליגה' }, { status: 404 })

  const [{ data: teams }, { data: players }] = await Promise.all([
    supabase.from('teams').select('*')
      .eq('league_id', league.id)
      .order('priority_rank', { ascending: true, nullsFirst: false }),
    supabase.from('players')
      .select('name, position, draft_price, drafted_by_team_id')
      .eq('league_id', league.id)
      .eq('status', 'drafted')
      .order('draft_price', { ascending: false }),
  ])

  const wb = XLSX.utils.book_new()

  // Sheet 1: Teams summary
  const teamsRows = (teams || []).map(t => ({
    'קבוצה': t.name,
    'שחקנים': t.player_count,
    'תקציב נותר': t.budget_remaining,
    'תקציב שהוצא': (league.budget_per_team ?? 0) - t.budget_remaining,
    'פריוריטי (העלאות)': t.priority_rank ?? '—',
    'פריוריטי (שוויון)': t.tiebreak_rank ?? '—',
    'הושלם': t.is_complete ? 'כן' : 'לא',
  }))
  const wsTeams = XLSX.utils.json_to_sheet(teamsRows)
  XLSX.utils.book_append_sheet(wb, wsTeams, 'קבוצות')

  // Sheet per team: their players
  for (const team of (teams || [])) {
    const teamPlayers = (players || []).filter(p => p.drafted_by_team_id === team.id)
    if (teamPlayers.length === 0) continue
    const rows = teamPlayers.map(p => ({
      'שחקן': p.name,
      'עמדה': p.position ?? '—',
      'מחיר': p.draft_price ?? 0,
    }))
    const ws = XLSX.utils.json_to_sheet(rows)
    const sheetName = team.name.slice(0, 31) // sheet name max 31 chars
    XLSX.utils.book_append_sheet(wb, ws, sheetName)
  }

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })

  return new NextResponse(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="draft-teams.xlsx"`,
    },
  })
}
