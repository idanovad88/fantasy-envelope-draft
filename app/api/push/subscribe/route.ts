import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'

// Persist a device's Web Push subscription so the notify cron can reach it.
// Body is the output of PushSubscription.toJSON().
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  let body: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'גוף הבקשה אינו תקין' }, { status: 400 })
  }

  const { endpoint, keys } = body
  // This row is later fed to web-push from a service-role context, so validate
  // rather than trusting whatever the client posted.
  if (typeof endpoint !== 'string' || !endpoint.startsWith('https://')) {
    return NextResponse.json({ error: 'endpoint לא תקין' }, { status: 400 })
  }
  if (typeof keys?.p256dh !== 'string' || !keys.p256dh || typeof keys?.auth !== 'string' || !keys.auth) {
    return NextResponse.json({ error: 'מפתחות הרשמה חסרים' }, { status: 400 })
  }

  const admin = createAdminClient()
  // onConflict endpoint makes a re-POST on every mount idempotent, and re-homes
  // the endpoint if a different user signs in on the same device.
  const { error } = await admin.from('push_subscriptions').upsert({
    user_id: user.id,
    endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
    user_agent: req.headers.get('user-agent'),
    last_seen_at: new Date().toISOString(),
  }, { onConflict: 'endpoint' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
