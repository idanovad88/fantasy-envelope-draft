import { createAdminClient } from '@/lib/supabase/server'
import { checkPublicApiAuth, emailsForUserIds, noStore } from '@/lib/publicApi'
import type { League, Team } from '@/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type TeamRow = Pick<
  Team,
  | 'id' | 'name' | 'user_id' | 'assistant_user_id' | 'priority_rank' | 'tiebreak_rank'
  | 'budget_remaining' | 'player_count' | 'is_complete' | 'approved'
>

export async function GET(req: Request, { params }: { params: Promise<{ leagueId: string }> }) {
  const authError = checkPublicApiAuth(req)
  if (authError) return authError

  const { leagueId } = await params
  const admin = createAdminClient()

  const { data: league } = await admin
    .from('leagues')
    .select('id, name, draft_type, status, num_teams, players_per_team, budget_per_team, min_bid, roster_slots, snake_round_config, draft_start_time')
    .eq('id', leagueId)
    .maybeSingle()
  if (!league) return noStore({ error: 'League not found' }, 404)

  const { data: teams, error } = await admin
    .from('teams')
    .select('id, name, user_id, assistant_user_id, priority_rank, tiebreak_rank, budget_remaining, player_count, is_complete, approved')
    .eq('league_id', leagueId)
    .order('priority_rank', { ascending: true, nullsFirst: false })
  if (error) return noStore({ error: error.message }, 500)

  const typedTeams = (teams ?? []) as TeamRow[]
  const emails = await emailsForUserIds(
    admin,
    typedTeams.flatMap(t => [t.user_id, t.assistant_user_id])
  )

  return noStore({
    ...(league as Pick<
      League,
      | 'id' | 'name' | 'draft_type' | 'status' | 'num_teams' | 'players_per_team' | 'budget_per_team'
      | 'min_bid' | 'roster_slots' | 'snake_round_config' | 'draft_start_time'
    >),
    teams: typedTeams.map(t => ({
      id: t.id,
      name: t.name,
      owner_email: t.user_id ? emails.get(t.user_id) ?? null : null,
      assistant_email: t.assistant_user_id ? emails.get(t.assistant_user_id) ?? null : null,
      priority_rank: t.priority_rank,
      tiebreak_rank: t.tiebreak_rank,
      budget_remaining: t.budget_remaining,
      player_count: t.player_count,
      is_complete: t.is_complete,
      approved: t.approved,
    })),
  })
}
