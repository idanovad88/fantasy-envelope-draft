import { createAdminClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const supabase = await createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: callerAdmin } = await supabase.from('admin_users').select('role').eq('user_id', user.id).maybeSingle()
  if (!callerAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { email } = await req.json()
  if (!email) return NextResponse.json({ error: 'חסר אימייל' }, { status: 400 })

  const { data: { users }, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 })
  if (listErr) return NextResponse.json({ error: listErr.message }, { status: 500 })

  const target = users?.find(u => u.email?.toLowerCase() === email.toLowerCase())
  if (!target) return NextResponse.json({ error: 'משתמש עם אימייל זה לא נמצא במערכת' }, { status: 404 })

  const { error } = await supabase.from('admin_users').insert({ user_id: target.id, role: 'admin' })
  if (error) {
    if (error.code === '23505') return NextResponse.json({ error: 'משתמש זה כבר מנהל' }, { status: 409 })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
