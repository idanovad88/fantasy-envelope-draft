import { createClient, createAdminClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { activateOverduePendingAuctions } from '@/lib/auctions'

export async function POST(req: Request) {
  const userClient = await createClient()
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = createAdminClient()
  const { data: adminRow } = await supabase.from('admin_users').select('role, league_id').eq('user_id', user.id).maybeSingle()
  if (!adminRow) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  // admin_users.league_id is nullable, so the caller passes its league; fall
  // back to the admin's own. Never activate across leagues blindly.
  const leagueId: string | undefined = body?.leagueId ?? adminRow.league_id ?? undefined
  if (!leagueId) return NextResponse.json({ error: 'לא נבחרה ליגה' }, { status: 400 })

  // The league id comes from the client, so confirm this admin actually runs
  // that league rather than trusting the body.
  if (leagueId !== adminRow.league_id) {
    const { data: created } = await supabase
      .from('leagues').select('id').eq('id', leagueId).eq('created_by', user.id).maybeSingle()
    if (!created) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const activated = await activateOverduePendingAuctions(leagueId)
  return NextResponse.json({ activated })
}
