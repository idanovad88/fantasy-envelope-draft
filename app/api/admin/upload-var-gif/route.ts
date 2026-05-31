import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'לא מחובר' }, { status: 401 })

  const { data: adminRow } = await supabase
    .from('admin_users').select('league_id').eq('user_id', user.id).maybeSingle()
  if (!adminRow) return NextResponse.json({ error: 'אין הרשאה' }, { status: 403 })

  const formData = await req.formData()
  const file = formData.get('file') as File | null
  const leagueId = formData.get('leagueId') as string | null

  if (!file || !leagueId) return NextResponse.json({ error: 'חסרים פרמטרים' }, { status: 400 })
  if (leagueId !== adminRow.league_id) return NextResponse.json({ error: 'אין הרשאה' }, { status: 403 })

  const bytes = await file.arrayBuffer()
  const buffer = Buffer.from(bytes)

  // Preserve extension so the client can detect video vs image
  const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : 'gif'
  const path = `var-gifs/${leagueId}.${ext}`

  const admin = createAdminClient()

  const { error: uploadError } = await admin.storage
    .from('draft-media')
    .upload(path, buffer, { contentType: file.type, upsert: true })

  if (uploadError) return NextResponse.json({ error: uploadError.message }, { status: 500 })

  const { data: urlData } = admin.storage.from('draft-media').getPublicUrl(path)
  const gifUrl = urlData.publicUrl

  await admin.from('leagues').update({ var_gif_url: gifUrl }).eq('id', leagueId)

  return NextResponse.json({ url: gifUrl })
}
