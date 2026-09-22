import { createAdminClient } from '@/lib/supabase/server'
import { checkPublicApiAuth, noStore } from '@/lib/publicApi'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ leagueId: string }> }) {
  const authError = checkPublicApiAuth(req)
  if (authError) return authError

  const { leagueId } = await params
  const admin = createAdminClient()

  const { data: league } = await admin.from('leagues').select('id').eq('id', leagueId).maybeSingle()
  if (!league) return noStore({ error: 'League not found' }, 404)

  // A league's pool is well under the PostgREST 1000-row cap today (see
  // CLAUDE.md, "Row limits") — the imported CSVs top out around 474.
  const { data: players, error } = await admin
    .from('players')
    .select('id, name, nba_team, position, ranking, status, auction_value')
    .eq('league_id', leagueId)
    .order('ranking', { ascending: true, nullsFirst: false })
  if (error) return noStore({ error: error.message }, 500)

  return noStore({ count: players?.length ?? 0, players: players ?? [] })
}
