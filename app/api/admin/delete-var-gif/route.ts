import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { getAuthUser } from '@/lib/supabase/auth'

export async function POST(req: Request) {
  const supabase = await createClient()
  const user = await getAuthUser(supabase)
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  const { leagueId, url } = await req.json()
  if (!leagueId || !url) return NextResponse.json({ error: 'חסרים פרמטרים' }, { status: 400 })

  // Use admin client to bypass RLS for permission check
  const admin = createAdminClient()
  const [{ data: adminRow }, { data: league }] = await Promise.all([
    admin.from('admin_users').select('league_id').eq('user_id', user.id).eq('league_id', leagueId).maybeSingle(),
    admin.from('leagues').select('created_by, var_gif_urls').eq('id', leagueId).maybeSingle(),
  ])

  const isAdmin = !!adminRow || league?.created_by === user.id
  if (!isAdmin) return NextResponse.json({ error: 'אין הרשאה' }, { status: 403 })

  const existing = Array.isArray(league?.var_gif_urls) ? (league!.var_gif_urls as string[]) : []
  const urls = existing.filter((u) => u !== url)

  await admin.from('leagues').update({ var_gif_urls: urls, var_gif_url: urls[0] ?? null }).eq('id', leagueId)

  // Best-effort cleanup from storage
  const marker = '/draft-media/'
  const idx = (url as string).indexOf(marker)
  if (idx !== -1) {
    const storagePath = (url as string).slice(idx + marker.length)
    await admin.storage.from('draft-media').remove([storagePath])
  }

  return NextResponse.json({ urls })
}
