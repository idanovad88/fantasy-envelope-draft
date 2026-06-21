import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'

const BUCKET = 'draft-media'

async function assertAdmin(leagueId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'לא מחובר', status: 401 as const }

  const admin = createAdminClient()
  const [{ data: adminRow }, { data: league }] = await Promise.all([
    admin.from('admin_users').select('league_id').eq('user_id', user.id).eq('league_id', leagueId).maybeSingle(),
    admin.from('leagues').select('created_by, var_gif_urls').eq('id', leagueId).maybeSingle(),
  ])

  const isAdmin = !!adminRow || league?.created_by === user.id
  if (!isAdmin) return { error: 'אין הרשאה', status: 403 as const }
  return { admin, league }
}

// Append a new VAR GIF to the league's gallery.
export async function POST(req: Request) {
  const formData = await req.formData()
  const file = formData.get('file') as File | null
  const leagueId = formData.get('leagueId') as string | null
  if (!file || !leagueId) return NextResponse.json({ error: 'חסרים פרמטרים' }, { status: 400 })

  const auth = await assertAdmin(leagueId)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const { admin, league } = auth

  const bytes = await file.arrayBuffer()
  const buffer = Buffer.from(bytes)

  const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : 'gif'
  // Unique path so multiple GIFs don't overwrite each other.
  const path = `var-gifs/${leagueId}-${Date.now()}.${ext}`

  const { error: uploadError } = await admin!.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType: file.type, upsert: true })

  if (uploadError) return NextResponse.json({ error: uploadError.message }, { status: 500 })

  const { data: urlData } = admin!.storage.from(BUCKET).getPublicUrl(path)
  const gifUrl = urlData.publicUrl

  const existing = (league?.var_gif_urls as string[] | null) ?? []
  const urls = [...existing, gifUrl]

  // Keep var_gif_url in sync (first item) for backwards compatibility.
  await admin!.from('leagues').update({ var_gif_urls: urls, var_gif_url: urls[0] }).eq('id', leagueId)

  return NextResponse.json({ url: gifUrl, urls })
}

// Remove a VAR GIF from the league's gallery.
export async function DELETE(req: Request) {
  const { leagueId, url } = await req.json().catch(() => ({}))
  if (!leagueId || !url) return NextResponse.json({ error: 'חסרים פרמטרים' }, { status: 400 })

  const auth = await assertAdmin(leagueId)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const { admin, league } = auth

  const existing = (league?.var_gif_urls as string[] | null) ?? []
  const urls = existing.filter(u => u !== url)

  // Best-effort removal from storage (derive the object path from the public URL).
  const marker = `/${BUCKET}/`
  const idx = (url as string).indexOf(marker)
  if (idx !== -1) {
    const objectPath = (url as string).slice(idx + marker.length)
    await admin!.storage.from(BUCKET).remove([objectPath])
  }

  await admin!.from('leagues').update({ var_gif_urls: urls, var_gif_url: urls[0] ?? null }).eq('id', leagueId)

  return NextResponse.json({ urls })
}
