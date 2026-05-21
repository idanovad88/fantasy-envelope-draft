import { createClient, createAdminClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import * as XLSX from 'xlsx'

export async function GET() {
  const userClient = await createClient()
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = createAdminClient()
  const { data: adminRow } = await supabase.from('admin_users').select('role').eq('user_id', user.id).maybeSingle()
  if (!adminRow) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { data: league } = await supabase
    .from('leagues').select('*').order('created_at', { ascending: false }).limit(1).maybeSingle()

  const { data: teams } = await supabase
    .from('teams').select('*').order('priority_rank', { ascending: true, nullsFirst: false })

  const { data: players } = await supabase
    .from('players')
    .select('name, position, draft_price, drafted_by_team_id')
    .eq('status', 'drafted')
    .order('draft_price', { ascending: false })

  const wb = XLSX.utils.book_new()

  // Sheet 1: Teams summary
  const teamsRows = (teams || []).map(t => ({
    'קבוצה': t.name,
    'שחקנים': t.player_count,
    'תקציב נותר': t.budget_remaining,
    'תקציב שהוצא': (league?.budget_per_team ?? 0) - t.budget_remaining,
    'פריוריטי (העלאות)': t.priority_rank ?? '—',
    'פריוריטי (שוויון)': t.tiebreak_rank ?? '—',
    'הושלם': t.is_complete ? 'כן' : 'לא',
    'מאושר': t.approved ? 'כן' : 'לא',
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
    // Sheet name max 31 chars
    const sheetName = team.name.slice(0, 31)
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
