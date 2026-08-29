import { createAdminClient } from '@/lib/supabase/server'
import { myTeamOr } from '@/lib/team'

/**
 * Shared caller resolution for the open-outcry draft routes.
 *
 * Every rule about *what* may happen lives in the Postgres functions
 * (`open_nominate`, `open_place_bid`, `open_pass`); those are SECURITY DEFINER
 * with EXECUTE revoked from PUBLIC, so they can only be reached through a route
 * holding the service-role key. What the routes still own is *who is calling* —
 * which is exactly what this does.
 */

export type OpenActor =
  | { ok: true; teamId: string; leagueId: string; isAdmin: boolean }
  | { ok: false; error: string; status: number }

export type OpenAdmin =
  | { ok: true; leagueId: string }
  | { ok: false; error: string; status: number }

async function loadLeagueAndAdmin(userId: string, leagueId: string) {
  const admin = createAdminClient()
  const [{ data: league }, { data: adminRow }] = await Promise.all([
    admin.from('leagues').select('id, created_by, draft_type').eq('id', leagueId).maybeSingle(),
    admin
      .from('admin_users')
      .select('user_id')
      .eq('user_id', userId)
      .eq('league_id', leagueId)
      .maybeSingle(),
  ])
  // Admin status is a row in admin_users OR being the league's creator — a
  // creator can be missing from admin_users, which is why both are checked.
  return { league, isAdmin: !!adminRow || league?.created_by === userId }
}

/**
 * Resolve the team a draft action runs as.
 *
 * `requestedTeamId` is the admin-on-behalf path (nominate for a team whose turn
 * it is, mark a team PASS) and is refused for everyone else. Otherwise the team
 * is the caller's own, resolved with {@link myTeamOr} so an assistant manager
 * counts as the team — assistants act on draft actions, never on trades.
 */
export async function resolveOpenActor(
  userId: string,
  leagueId: string,
  requestedTeamId?: string | null
): Promise<OpenActor> {
  const admin = createAdminClient()
  const { league, isAdmin } = await loadLeagueAndAdmin(userId, leagueId)

  if (!league) return { ok: false, error: 'ליגה לא נמצאה', status: 404 }
  if (league.draft_type !== 'open') {
    return { ok: false, error: 'הליגה אינה דראפט מכרז פתוח', status: 400 }
  }

  if (requestedTeamId) {
    if (!isAdmin) {
      return { ok: false, error: 'רק מנהל הליגה יכול לפעול בשם קבוצה אחרת', status: 403 }
    }
    const { data: team } = await admin
      .from('teams')
      .select('id')
      .eq('id', requestedTeamId)
      .eq('league_id', leagueId)
      .maybeSingle()
    if (!team) return { ok: false, error: 'הקבוצה אינה בליגה הזו', status: 400 }
    return { ok: true, teamId: team.id, leagueId, isAdmin }
  }

  const { data: myTeam } = await admin
    .from('teams')
    .select('id')
    .eq('league_id', leagueId)
    .or(myTeamOr(userId))
    .limit(1)
    .maybeSingle()

  if (!myTeam) return { ok: false, error: 'אין לך קבוצה בליגה הזו', status: 403 }
  return { ok: true, teamId: myTeam.id, leagueId, isAdmin }
}

/** Admin-only actions: close, cancel, pause. */
export async function requireOpenAdmin(userId: string, leagueId: string): Promise<OpenAdmin> {
  const { league, isAdmin } = await loadLeagueAndAdmin(userId, leagueId)

  if (!league) return { ok: false, error: 'ליגה לא נמצאה', status: 404 }
  if (league.draft_type !== 'open') {
    return { ok: false, error: 'הליגה אינה דראפט מכרז פתוח', status: 400 }
  }
  if (!isAdmin) return { ok: false, error: 'פעולה למנהלי הליגה בלבד', status: 403 }

  return { ok: true, leagueId }
}

/** The league an open auction belongs to, or null if there is no such auction. */
export async function leagueOfOpenAuction(auctionId: string): Promise<string | null> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('open_auctions')
    .select('league_id')
    .eq('id', auctionId)
    .maybeSingle()
  return data?.league_id ?? null
}
