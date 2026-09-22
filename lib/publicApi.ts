import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

// Every response from app/api/public/v1 must never be cached — a mirror tool
// polling this API needs the live state, not whatever a CDN or the client
// last saw.
export function noStore(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

/**
 * Server-to-server auth, the same shape as CRON_SECRET: a comma-separated
 * list of opaque tokens so one integration can be revoked without rotating
 * everyone else's. A missing env var 500s rather than leaving every route
 * open — same reasoning as the cron routes' CRON_SECRET check.
 */
export function checkPublicApiAuth(req: Request): NextResponse | null {
  const raw = process.env.EXTERNAL_API_KEYS
  if (!raw) {
    console.error('[public-api] EXTERNAL_API_KEYS is not set')
    return noStore({ error: 'Not configured' }, 500)
  }
  const keys = raw.split(',').map(k => k.trim()).filter(Boolean)
  const auth = req.headers.get('authorization')
  const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null
  if (!token || !keys.includes(token)) {
    return noStore({ error: 'Unauthorized' }, 401)
  }
  return null
}

/**
 * Maps a set of auth user ids to their email. Emails live in Supabase Auth,
 * not any public table, so this is the only way to resolve `owner_email` /
 * `assistant_email`. Follows the same `listUsers({ perPage: 1000 })` shape as
 * app/api/admin/add-admin — this app's user base fits in one page.
 */
export async function emailsForUserIds(
  admin: SupabaseClient,
  ids: (string | null | undefined)[]
): Promise<Map<string, string | null>> {
  const wanted = new Set(ids.filter((id): id is string => !!id))
  const map = new Map<string, string | null>()
  if (wanted.size === 0) return map

  const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 })
  if (error) throw new Error(error.message)

  for (const u of data.users) {
    if (wanted.has(u.id)) map.set(u.id, u.email ?? null)
  }
  return map
}

// PostgREST caps a response at 1000 rows (see CLAUDE.md, "Row limits") — any
// query whose count grows with the draft must page around it.
const PAGE = 1000

export async function selectAllPages<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    rows.push(...(data ?? []))
    if (!data || data.length < PAGE) return rows
  }
}
