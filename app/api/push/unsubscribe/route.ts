import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'

// Drop a device's subscription when the user turns notifications off.
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  let body: { endpoint?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'גוף הבקשה אינו תקין' }, { status: 400 })
  }

  const { endpoint } = body
  if (typeof endpoint !== 'string' || !endpoint) {
    return NextResponse.json({ error: 'endpoint חסר' }, { status: 400 })
  }

  const admin = createAdminClient()
  // Scoped to user_id so one user cannot delete another's subscription.
  const { error } = await admin.from('push_subscriptions')
    .delete().eq('endpoint', endpoint).eq('user_id', user.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
