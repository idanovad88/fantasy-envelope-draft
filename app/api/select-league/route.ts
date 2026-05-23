import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'

export async function POST(req: Request) {
  const { leagueId } = await req.json()
  if (!leagueId) return NextResponse.json({ error: 'missing leagueId' }, { status: 400 })

  const cookieStore = await cookies()
  cookieStore.set('selected_league_id', leagueId, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  })
  return NextResponse.json({ success: true })
}
