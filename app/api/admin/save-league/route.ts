import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'
import { NextRequest, NextResponse } from 'next/server'

// League settings are saved through this route rather than a direct
// browser-side `leagues` update. Two reasons the direct write was unreliable:
//  1. RLS: `leagues_admin_write` only recognises rows in `admin_users`, so a
//     league *creator* who is not in that table (created_by only) had their
//     update silently filtered to 0 rows — the value reverted on reload with
//     no error. The service-role client here bypasses RLS after we verify the
//     caller is an admin or the creator, matching the rest of app/api/admin.
//  2. The browser code swallowed every error; here a rejection is returned so
//     the panel can surface it instead of falsely reporting "saved".
export async function POST(req: NextRequest) {
  const userClient = await createClient()
  const user = await getAuthUser(userClient)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { leagueId } = body
  if (!leagueId) return NextResponse.json({ error: 'Missing leagueId' }, { status: 400 })

  const supabase = createAdminClient()

  const { data: league } = await supabase
    .from('leagues')
    .select('id, created_by, players_per_team, roster_slots')
    .eq('id', leagueId)
    .maybeSingle()
  if (!league) return NextResponse.json({ error: 'ליגה לא נמצאה' }, { status: 404 })

  // Admin check: row in admin_users for this league OR creator of this league.
  const { data: adminRow } = await supabase
    .from('admin_users').select('role').eq('user_id', user.id).eq('league_id', leagueId).maybeSingle()
  const isAdmin = !!adminRow || league.created_by === user.id
  if (!isAdmin) return NextResponse.json({ error: 'Forbidden — admins only' }, { status: 403 })

  // Whitelist the columns the settings form owns. Never trust the body to set
  // id / created_by / status / rank columns.
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if ('name' in body) {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return NextResponse.json({ error: 'שם הליגה חסר' }, { status: 400 })
    update.name = name
  }
  if ('num_teams' in body) update.num_teams = body.num_teams
  if ('players_per_team' in body) update.players_per_team = body.players_per_team
  if ('budget_per_team' in body) update.budget_per_team = body.budget_per_team
  if ('join_code' in body) update.join_code = body.join_code || null
  if ('draft_start_time' in body) update.draft_start_time = body.draft_start_time || null
  if ('auction_duration_hours' in body) update.auction_duration_hours = body.auction_duration_hours
  if ('roster_slots' in body) update.roster_slots = body.roster_slots ?? null
  if ('pick_timeout_minutes' in body) update.pick_timeout_minutes = body.pick_timeout_minutes
  if ('snake_round_config' in body) update.snake_round_config = body.snake_round_config

  if ('notify_before_minutes' in body) {
    const n = Number(body.notify_before_minutes)
    // Matches the DB CHECK (BETWEEN 1 AND 60). A bad value here would otherwise
    // reject the entire update — the exact silent-failure this route fixes.
    if (!Number.isInteger(n) || n < 1 || n > 60) {
      return NextResponse.json({ error: 'התראה לפני חשיפה חייבת להיות בין 1 ל-60 דקות' }, { status: 400 })
    }
    update.notify_before_minutes = n
  }

  if ('reveal_mode' in body) {
    if (!['random', 'weighted'].includes(body.reveal_mode)) {
      return NextResponse.json({ error: 'מצב חשיפה לא תקין' }, { status: 400 })
    }
    update.reveal_mode = body.reveal_mode
  }

  // Open outcry draft. Each range matches its DB CHECK — a value the constraint
  // would reject rolls back the whole settings save, the silent failure this
  // route exists to prevent.
  if ('open_board_size' in body) {
    const n = Number(body.open_board_size)
    if (!Number.isInteger(n) || n < 1 || n > 30) {
      return NextResponse.json({ error: 'מספר השחקנים על הלוח חייב להיות בין 1 ל-30' }, { status: 400 })
    }
    update.open_board_size = n
  }

  if ('open_pass_timeout_minutes' in body) {
    const n = Number(body.open_pass_timeout_minutes)
    if (!Number.isInteger(n) || n < 5 || n > 2880) {
      return NextResponse.json({ error: 'זמן ההמתנה למכרז חייב להיות בין 5 ל-2880 דקות' }, { status: 400 })
    }
    update.open_pass_timeout_minutes = n
  }

  // Active hours. These two columns have lived on `leagues` unused since the
  // original schema; the open draft is what finally reads them.
  for (const key of ['draft_start_hour', 'draft_end_hour'] as const) {
    if (key in body) {
      const n = Number(body[key])
      if (!Number.isInteger(n) || n < 0 || n > 23) {
        return NextResponse.json({ error: 'שעות הפעילות חייבות להיות בין 0 ל-23' }, { status: 400 })
      }
      update[key] = n
    }
  }

  // players_per_team and roster_slots are two halves of one setting: when a
  // slot config exists it is what the team page draws, so a league saved with
  // six players and three slots silently shows three roster rows and pushes the
  // rest into "no matching position". The panel already turns the total red;
  // this is what makes it stick. Either side may be absent from the payload, so
  // both fall back to what is already stored.
  const nextSlots = ('roster_slots' in update ? update.roster_slots : league.roster_slots) as
    Record<string, number> | null
  const nextPlayersPerTeam = Number(
    'players_per_team' in update ? update.players_per_team : league.players_per_team
  )

  if (nextSlots && typeof nextSlots === 'object') {
    const counts = Object.values(nextSlots).map(Number)
    if (counts.some(v => !Number.isInteger(v) || v < 0)) {
      return NextResponse.json({ error: 'עמדות ההרכב חייבות להיות מספרים שלמים אי-שליליים' }, { status: 400 })
    }
    const total = counts.reduce((a, b) => a + b, 0)
    // All zeros means "no slot config" — the same thing the panel sends as null.
    if (total > 0 && total !== nextPlayersPerTeam) {
      return NextResponse.json({
        error: `סכום עמדות ההרכב (${total}) חייב להיות שווה למספר השחקנים לקבוצה (${nextPlayersPerTeam})`,
      }, { status: 400 })
    }
  }

  const { error } = await supabase.from('leagues').update(update).eq('id', leagueId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
