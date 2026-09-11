import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'
import { NextRequest, NextResponse } from 'next/server'

/** Enough ids per request to keep the round trips down, short enough for a URL. */
const DELETE_CHUNK = 100

export async function POST(req: NextRequest) {
  const userClient = await createClient()
  const user = await getAuthUser(userClient)
  const supabase = createAdminClient()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { league_id, player_id, player_ids, all_available } = await req.json()
  if (!league_id) {
    return NextResponse.json({ error: 'Missing data' }, { status: 400 })
  }

  const { data: league } = await supabase.from('leagues').select('created_by').eq('id', league_id).single()
  if (!league) return NextResponse.json({ error: 'ליגה לא נמצאה' }, { status: 404 })

  // Admin check: row in admin_users OR creator of this league
  const { data: adminRow } = await supabase.from('admin_users').select('role').eq('user_id', user.id).maybeSingle()
  const isAdmin = !!adminRow || league.created_by === user.id
  if (!isAdmin) return NextResponse.json({ error: 'Forbidden — admins only' }, { status: 403 })

  if (all_available) {
    // Only available players — never touch on_auction / drafted rows
    const { error } = await supabase.from('players')
      .delete()
      .eq('league_id', league_id)
      .eq('status', 'available')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  // Several named players at once — what the admin panel's checkboxes send.
  //
  // The league and status guards live in the DELETE itself rather than in a
  // verification read: a drafted player, or a row belonging to another league,
  // simply does not match, so no amount of crafted `player_ids` can reach one.
  // The reply reports what was actually removed rather than what was asked for.
  if (Array.isArray(player_ids)) {
    const ids = [...new Set(player_ids.filter((id: unknown) => typeof id === 'string' && id))]
    if (!ids.length) return NextResponse.json({ error: 'לא נבחרו שחקנים' }, { status: 400 })

    // Chunked because `.in()` is serialised into the query string — the whole
    // pool is ~600 UUIDs, 22KB, past what the URL will carry.
    let deleted = 0
    for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
      const { error, count } = await supabase.from('players')
        .delete({ count: 'exact' })
        .eq('league_id', league_id)
        .eq('status', 'available')
        .in('id', ids.slice(i, i + DELETE_CHUNK))
      if (error) return NextResponse.json({ error: error.message, deleted }, { status: 500 })
      deleted += count ?? 0
    }
    return NextResponse.json({ ok: true, deleted, requested: ids.length })
  }

  if (!player_id) {
    return NextResponse.json({ error: 'Missing data' }, { status: 400 })
  }

  // Verify the player belongs to this league before deleting
  const { data: player } = await supabase.from('players')
    .select('id, league_id, status').eq('id', player_id).maybeSingle()
  if (!player || player.league_id !== league_id) {
    return NextResponse.json({ error: 'שחקן לא נמצא' }, { status: 404 })
  }
  if (player.status !== 'available') {
    return NextResponse.json({ error: 'ניתן להסיר רק שחקנים זמינים' }, { status: 400 })
  }

  const { error } = await supabase.from('players').delete().eq('id', player_id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
