import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const userClient = await createClient()
  const user = await getAuthUser(userClient)
  const supabase = createAdminClient()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { league_id, player_id, all_available } = await req.json()
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
