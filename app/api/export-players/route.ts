import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'
import { myTeamOr } from '@/lib/team'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import * as XLSX from 'xlsx'

type Row = Record<string, string | number>

const ENVELOPE_HEADERS = ['שחקן', 'קבוצת NBA', 'עמדה', 'עמדה בהרכב', 'קבוצה', 'מחיר']
const SNAKE_HEADERS = ['פיק', 'סיבוב', 'שחקן', 'קבוצת NBA', 'עמדה', 'עמדה בהרכב', 'קבוצה']

// Excel only reads a UTF-8 CSV as Hebrew if it starts with a BOM.
function toCsv(headers: string[], rows: Row[]): string {
  const cell = (v: string | number | undefined) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [headers.join(','), ...rows.map(r => headers.map(h => cell(r[h])).join(','))]
  return '﻿' + lines.join('\r\n')
}

export async function GET(request: Request) {
  const userClient = await createClient()
  const user = await getAuthUser(userClient)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const format = new URL(request.url).searchParams.get('format') === 'csv' ? 'csv' : 'xlsx'

  const supabase = createAdminClient()

  // Same league resolution as the pages: cookie first, then team → admin → creator.
  const cookieStore = await cookies()
  const selectedLeagueId = cookieStore.get('selected_league_id')?.value

  const [{ data: myTeam }, { data: adminRow }, { data: createdLeague }] = await Promise.all([
    selectedLeagueId
      ? supabase.from('teams').select('league_id').or(myTeamOr(user.id)).eq('league_id', selectedLeagueId).limit(1).maybeSingle()
      : supabase.from('teams').select('league_id').or(myTeamOr(user.id)).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('admin_users').select('league_id').eq('user_id', user.id).maybeSingle(),
    supabase.from('leagues').select('id').eq('created_by', user.id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ])

  const leagueId = selectedLeagueId ?? myTeam?.league_id ?? adminRow?.league_id ?? createdLeague?.id ?? null
  if (!leagueId) return NextResponse.json({ error: 'No league' }, { status: 404 })

  const { data: league } = await supabase
    .from('leagues').select('id, name, draft_type, created_by').eq('id', leagueId).maybeSingle()
  if (!league) return NextResponse.json({ error: 'No league' }, { status: 404 })

  // The cookie is user-supplied — confirm the caller actually belongs to that league.
  const isMember =
    myTeam?.league_id === leagueId ||
    adminRow?.league_id === leagueId ||
    league.created_by === user.id
  if (!isMember) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const isSnake = league.draft_type === 'snake'

  type Pick = { player_id: string; overall_pick_number: number; round: number }
  const [{ data: players }, { data: picks }] = await Promise.all([
    supabase.from('players')
      .select('id, name, position, nba_team, draft_price, roster_slot, drafting_team:teams!drafted_by_team_id(name)')
      .eq('league_id', leagueId)
      .eq('status', 'drafted'),
    isSnake
      ? supabase.from('snake_picks').select('player_id, overall_pick_number, round').eq('league_id', leagueId)
      : Promise.resolve({ data: [] as Pick[] }),
  ])

  type P = {
    id: string
    name: string
    position: string | null
    nba_team: string | null
    draft_price: number | null
    roster_slot: string | null
    drafting_team: { name: string } | { name: string }[] | null
  }
  const teamName = (p: P) =>
    (Array.isArray(p.drafting_team) ? p.drafting_team[0]?.name : p.drafting_team?.name) ?? '—'

  const pickByPlayer = new Map(((picks || []) as Pick[]).map(p => [p.player_id, p]))
  const typedPlayers = ((players || []) as unknown as P[])

  const headers = isSnake ? SNAKE_HEADERS : ENVELOPE_HEADERS
  const rows: Row[] = isSnake
    ? typedPlayers
        .slice()
        .sort((a, b) => (pickByPlayer.get(a.id)?.overall_pick_number ?? 0) - (pickByPlayer.get(b.id)?.overall_pick_number ?? 0))
        .map(p => {
          const pick = pickByPlayer.get(p.id)
          return {
            'פיק': pick?.overall_pick_number ?? '—',
            'סיבוב': pick?.round ?? '—',
            'שחקן': p.name,
            'קבוצת NBA': p.nba_team ?? '—',
            'עמדה': p.position ?? '—',
            'עמדה בהרכב': p.roster_slot ?? '—',
            'קבוצה': teamName(p),
          }
        })
    : typedPlayers
        .slice()
        .sort((a, b) => (b.draft_price ?? 0) - (a.draft_price ?? 0))
        .map(p => ({
          'שחקן': p.name,
          'קבוצת NBA': p.nba_team ?? '—',
          'עמדה': p.position ?? '—',
          'עמדה בהרכב': p.roster_slot ?? '—',
          'קבוצה': teamName(p),
          'מחיר': p.draft_price ?? 0,
        }))

  const fileBase = `${league.name}-players`.replace(/[^\w֐-׿]+/g, '_').slice(0, 60)

  if (format === 'csv') {
    return new NextResponse(toCsv(headers, rows), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="players.csv"; filename*=UTF-8''${encodeURIComponent(fileBase)}.csv`,
      },
    })
  }

  const ws = XLSX.utils.json_to_sheet(rows, { header: headers })
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'שחקנים')
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })

  return new NextResponse(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="players.xlsx"; filename*=UTF-8''${encodeURIComponent(fileBase)}.xlsx`,
    },
  })
}
