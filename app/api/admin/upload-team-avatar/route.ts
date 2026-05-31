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
  const teamId = formData.get('teamId') as string | null

  if (!file || !teamId) return NextResponse.json({ error: 'חסרים פרמטרים' }, { status: 400 })

  const admin = createAdminClient()

  const { data: team } = await admin
    .from('teams').select('id, league_id').eq('id', teamId).maybeSingle()
  if (!team || team.league_id !== adminRow.league_id) {
    return NextResponse.json({ error: 'קבוצה לא נמצאה' }, { status: 404 })
  }

  const bytes = await file.arrayBuffer()
  const buffer = Buffer.from(bytes)

  const { error: uploadError } = await admin.storage
    .from('draft-media')
    .upload(`team-photos/${teamId}`, buffer, { contentType: file.type, upsert: true })

  if (uploadError) return NextResponse.json({ error: uploadError.message }, { status: 500 })

  const { data: urlData } = admin.storage.from('draft-media').getPublicUrl(`team-photos/${teamId}`)
  const avatarUrl = urlData.publicUrl

  await admin.from('teams').update({ avatar_url: avatarUrl }).eq('id', teamId)

  return NextResponse.json({ url: avatarUrl })
}
