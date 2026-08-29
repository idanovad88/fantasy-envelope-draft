import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'
import { requireOpenAdmin } from '@/lib/openAuth'

// Stop and restart the draft's clocks.
//
// Pausing stamps `leagues.open_frozen_since`; resuming shifts every open
// auction's deadline forward by the time that elapsed, so nobody loses part of
// their window to a pause. `open_set_pause()` does both in one transaction —
// leaving the stamp to the every-minute tick would leak up to a minute of clock
// onto every auction on the board.
export async function POST(req: Request) {
  const supabase = await createClient()
  const user = await getAuthUser(supabase)
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const leagueId: string | undefined = body?.league_id
  const paused = body?.paused
  if (!leagueId) return NextResponse.json({ error: 'חסר מזהה ליגה' }, { status: 400 })
  if (typeof paused !== 'boolean') {
    return NextResponse.json({ error: 'חסר ערך paused' }, { status: 400 })
  }

  const auth = await requireOpenAdmin(user.id, leagueId)
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const admin = createAdminClient()
  const { error } = await admin.rpc('open_set_pause', {
    p_league_id: leagueId,
    p_paused: paused,
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  return NextResponse.json({ success: true })
}
