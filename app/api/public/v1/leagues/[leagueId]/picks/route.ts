import { createAdminClient } from '@/lib/supabase/server'
import { checkPublicApiAuth, emailsForUserIds, noStore, selectAllPages } from '@/lib/publicApi'
type AdminClient = ReturnType<typeof createAdminClient>

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface PlayerEmbed {
  id: string
  name: string
  nba_team: string | null
  position: string | null
  ranking: number | null
  status: string
  drafted_by_team_id: string | null
}

interface TeamEmbed {
  id: string
  name: string
  user_id: string | null
}

interface EnvelopeOrOpenRow {
  id: string
  player_id: string
  winning_team_id: string
  winning_bid: number
  updated_at: string
  player: PlayerEmbed | null
  team: TeamEmbed | null
}

interface SnakeRow {
  id: string
  player_id: string
  team_id: string
  overall_pick_number: number
  round: number
  pick_in_round: number
  picked_at: string
  player: PlayerEmbed | null
  team: TeamEmbed | null
}

// Internal shape carries the team's user_id so emails can be resolved once,
// after every pick across the league is known, rather than per row.
interface InternalPick {
  player_id: string
  player_name: string
  nba_team: string | null
  position: string | null
  ranking: number | null
  team_id: string
  team_name: string
  team_user_id: string | null
  price: number | null
  overall_pick: number | null
  round: number | null
  pick_in_round: number | null
  drafted_at: string
  source: 'envelope' | 'open' | 'snake'
}

// Source of truth per draft type, the same tables scripts/export-draft-results.mjs
// reads. Cross-checked against `players`: only emit a row whose player is still
// `status = 'drafted'` with a matching `drafted_by_team_id`, so an open-outcry
// undo or an admin reset — which clear the player row but leave the closed
// auction/pick row in place — never surface as a ghost pick.
async function envelopeOrOpenPicks(
  admin: AdminClient,
  leagueId: string,
  source: 'envelope' | 'open'
): Promise<InternalPick[]> {
  const table = source === 'envelope' ? 'auctions' : 'open_auctions'
  // `table` is a runtime variable, not a literal, so supabase-js can't infer
  // the embed shape from the generic client — cast the chain rather than the
  // row type, so the rest of this function stays checked against `EnvelopeOrOpenRow`.
  const rows = await selectAllPages<EnvelopeOrOpenRow>((from, to) =>
    (admin
      .from(table)
      .select(
        'id, player_id, winning_team_id, winning_bid, updated_at, ' +
        'player:players(id, name, nba_team, position, ranking, status, drafted_by_team_id), ' +
        'team:teams!winning_team_id(id, name, user_id)'
      )
      .eq('league_id', leagueId)
      .eq('status', 'completed')
      .not('winning_team_id', 'is', null)
      .order('updated_at', { ascending: true })
      .range(from, to) as unknown) as PromiseLike<{ data: EnvelopeOrOpenRow[] | null; error: { message: string } | null }>
  )

  return rows
    .filter(r => r.player?.status === 'drafted' && r.player.drafted_by_team_id === r.winning_team_id && r.team)
    .map(r => ({
      player_id: r.player_id,
      player_name: r.player!.name,
      nba_team: r.player!.nba_team,
      position: r.player!.position,
      ranking: r.player!.ranking,
      team_id: r.winning_team_id,
      team_name: r.team!.name,
      team_user_id: r.team!.user_id,
      price: r.winning_bid,
      overall_pick: null,
      round: null,
      pick_in_round: null,
      drafted_at: r.updated_at,
      source,
    }))
}

async function snakePicks(admin: AdminClient, leagueId: string): Promise<InternalPick[]> {
  // Same cast as above: a concatenated (non-literal) select string defeats
  // supabase-js's embed-shape inference, so the chain is cast to the shape
  // this function actually reads rather than left as `GenericStringError[]`.
  const rows = await selectAllPages<SnakeRow>((from, to) =>
    (admin
      .from('snake_picks')
      .select(
        'id, player_id, team_id, overall_pick_number, round, pick_in_round, picked_at, ' +
        'player:players(id, name, nba_team, position, ranking, status, drafted_by_team_id), ' +
        'team:teams(id, name, user_id)'
      )
      .eq('league_id', leagueId)
      .order('overall_pick_number', { ascending: true })
      .range(from, to) as unknown) as PromiseLike<{ data: SnakeRow[] | null; error: { message: string } | null }>
  )

  return rows
    .filter(r => r.player?.status === 'drafted' && r.player.drafted_by_team_id === r.team_id && r.team)
    .map(r => ({
      player_id: r.player_id,
      player_name: r.player!.name,
      nba_team: r.player!.nba_team,
      position: r.player!.position,
      ranking: r.player!.ranking,
      team_id: r.team_id,
      team_name: r.team!.name,
      team_user_id: r.team!.user_id,
      price: null,
      overall_pick: r.overall_pick_number,
      round: r.round,
      pick_in_round: r.pick_in_round,
      drafted_at: r.picked_at,
      source: 'snake' as const,
    }))
}

export async function GET(req: Request, { params }: { params: Promise<{ leagueId: string }> }) {
  const authError = checkPublicApiAuth(req)
  if (authError) return authError

  const { leagueId } = await params
  const admin = createAdminClient()

  const { data: league } = await admin.from('leagues').select('id, draft_type').eq('id', leagueId).maybeSingle()
  if (!league) return noStore({ error: 'League not found' }, 404)

  const internal =
    league.draft_type === 'envelope' ? await envelopeOrOpenPicks(admin, leagueId, 'envelope')
    : league.draft_type === 'open' ? await envelopeOrOpenPicks(admin, leagueId, 'open')
    : await snakePicks(admin, leagueId)

  internal.sort((a, b) => a.drafted_at.localeCompare(b.drafted_at))

  const emails = await emailsForUserIds(admin, internal.map(p => p.team_user_id))

  const picks = internal.map(({ team_user_id, ...p }) => ({
    ...p,
    owner_email: team_user_id ? emails.get(team_user_id) ?? null : null,
  }))

  return noStore({
    league_id: leagueId,
    draft_type: league.draft_type,
    count: picks.length,
    picks,
  })
}
