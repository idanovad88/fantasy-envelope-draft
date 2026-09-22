import { createAdminClient } from '@/lib/supabase/server'
import { checkPublicApiAuth, emailsForUserIds, noStore } from '@/lib/publicApi'
import { buildPickOverridesMap, getCurrentSnakePicker, resolvePickOwner } from '@/lib/utils'
import type { Team } from '@/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type TeamRow = Pick<Team, 'id' | 'name' | 'user_id' | 'priority_rank'>

export async function GET(req: Request, { params }: { params: Promise<{ leagueId: string }> }) {
  const authError = checkPublicApiAuth(req)
  if (authError) return authError

  const { leagueId } = await params
  const admin = createAdminClient()

  const { data: league } = await admin
    .from('leagues')
    .select('id, draft_type, num_teams, players_per_team, snake_round_config')
    .eq('id', leagueId)
    .maybeSingle()
  if (!league) return noStore({ error: 'League not found' }, 404)
  if (league.draft_type !== 'snake') {
    return noStore({ error: 'Not a snake draft league' }, 409)
  }

  const [{ data: teams, error: teamsErr }, { data: picks, error: picksErr }, { data: overrideRows, error: overridesErr }] =
    await Promise.all([
      admin
        .from('teams')
        .select('id, name, user_id, priority_rank')
        .eq('league_id', leagueId)
        .eq('approved', true)
        .not('priority_rank', 'is', null)
        .order('priority_rank', { ascending: true }),
      admin.from('snake_picks').select('id').eq('league_id', leagueId),
      admin.from('pick_overrides').select('overall_pick_number, owner_team_id').eq('league_id', leagueId),
    ])
  if (teamsErr) return noStore({ error: teamsErr.message }, 500)
  if (picksErr) return noStore({ error: picksErr.message }, 500)
  if (overridesErr) return noStore({ error: overridesErr.message }, 500)

  const typedTeams = (teams ?? []) as TeamRow[]
  const overridesMap = buildPickOverridesMap(overrideRows as { overall_pick_number: number; owner_team_id: string }[] | null)

  const numTeams = league.num_teams
  const totalPicks = numTeams * league.players_per_team
  const completedPicks = picks?.length ?? 0
  const config = league.snake_round_config as boolean[] | null

  const onTheClock = getCurrentSnakePicker(completedPicks, numTeams, typedTeams as Team[], config, overridesMap)

  const emails = await emailsForUserIds(admin, typedTeams.map(t => t.user_id))

  const byTeam = new Map<string, { round: number; pick_in_round: number; overall: number }[]>()
  for (let overall = completedPicks + 1; overall <= totalPicks; overall++) {
    const owner = resolvePickOwner(overall, numTeams, typedTeams as Team[], config, overridesMap)
    if (!owner) continue
    const round = Math.ceil(overall / numTeams)
    const pickInRound = ((overall - 1) % numTeams) + 1
    const list = byTeam.get(owner.id)
    const entry = { round, pick_in_round: pickInRound, overall }
    if (list) list.push(entry)
    else byTeam.set(owner.id, [entry])
  }

  return noStore({
    completed_picks: completedPicks,
    on_the_clock_team_id: onTheClock?.id ?? null,
    teams: typedTeams.map(t => ({
      team_id: t.id,
      team_name: t.name,
      owner_email: t.user_id ? emails.get(t.user_id) ?? null : null,
      picks: byTeam.get(t.id) ?? [],
    })),
  })
}
