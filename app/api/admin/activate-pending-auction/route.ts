import { createClient, createAdminClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function POST() {
  const userClient = await createClient()
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = createAdminClient()
  const { data: adminRow } = await supabase.from('admin_users').select('role').eq('user_id', user.id).maybeSingle()
  if (!adminRow) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const now = new Date().toISOString()
  const { data: pending } = await supabase
    .from('auctions')
    .select('id, player_id')
    .eq('status', 'pending')
    .lte('scheduled_start', now)
    .order('scheduled_start', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!pending) return NextResponse.json({ activated: false })

  await Promise.all([
    supabase.from('auctions').update({ status: 'active' }).eq('id', pending.id),
    supabase.from('players').update({ status: 'on_auction' }).eq('id', pending.player_id),
  ])

  return NextResponse.json({ activated: true })
}
