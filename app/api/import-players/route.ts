import { createAdminClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const supabase = await createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const adminRow = await supabase.from('admin_users').select('role').eq('user_id', user.id).maybeSingle()
  if (!adminRow.data) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json()
  const { league_id, players } = body as {
    league_id: string
    players: { name: string; nba_team?: string; position?: string; ranking?: number; auction_value?: number; stats?: Record<string, number> }[]
  }

  if (!league_id || !players?.length) return NextResponse.json({ error: 'Missing data' }, { status: 400 })

  const rows = players.map(p => ({
    league_id,
    name: p.name,
    nba_team: p.nba_team ?? null,
    position: p.position ?? null,
    ranking: p.ranking ?? null,
    auction_value: p.auction_value ?? null,
    stats: p.stats ?? {},
    status: 'available',
  }))

  const { error, count } = await supabase.from('players').insert(rows, { count: 'exact' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ imported: count })
}
