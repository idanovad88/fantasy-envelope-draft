import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { configureWebPush, sendPushToUsers } from '@/lib/push'

// web-push needs Node's crypto — this breaks on the edge runtime.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Called every minute by Supabase pg_cron (see supabase/cron_notify_open.sql).
 *
 * Sends the three open-outcry notifications:
 *   · a team's turn to put a player up (owner + assistant of that team);
 *   · a starred player going up, or being raised (everyone who starred him);
 *   · "you have been outbid" (the previous leader).
 *
 * What is due is decided entirely in Postgres by open_notify_turn_candidates()
 * and open_notify_bid_events() — the same two functions the cron's guard calls,
 * so the guard cannot go stale against this route. Both already exclude
 * anything claimed in open_notifications and anything outside the league's
 * draft hours (the night hold).
 */

interface TurnCandidate {
  league_id: string
  team_id: string
  turn_rank: number
  team_name: string
}

interface BidEvent {
  league_id: string
  open_auction_id: string
  bid_id: string
  player_id: string
  player_name: string
  bidder_team_id: string
  bidder_team_name: string
  amount: number
  is_opening: boolean
  prev_leader_team_id: string | null
}

// How long each kind stays worth delivering to a phone that was offline. A turn
// stands until the team acts on it; a price is stale as soon as someone raises.
const TURN_TTL_SECONDS = 2 * 60 * 60
const BID_TTL_SECONDS = 30 * 60

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  // A missing secret must not leave the route open.
  if (!secret) {
    console.error('[notify-open] CRON_SECRET is not set')
    return NextResponse.json({ error: 'Not configured' }, { status: 500 })
  }
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!configureWebPush()) {
    console.error('[notify-open] VAPID env vars are incomplete')
    return NextResponse.json({ error: 'Not configured' }, { status: 500 })
  }

  const admin = createAdminClient()

  const [{ data: turnRows, error: turnError }, { data: eventRows, error: eventError }] =
    await Promise.all([
      admin.rpc('open_notify_turn_candidates'),
      admin.rpc('open_notify_bid_events'),
    ])

  if (turnError || eventError) {
    const message = turnError?.message ?? eventError?.message ?? 'unknown'
    console.error('[notify-open] query failed:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }

  const turns = (turnRows ?? []) as TurnCandidate[]
  const events = (eventRows ?? []) as BidEvent[]

  // One lookup for every team either job needs, instead of one per row.
  const teamIds = new Set<string>()
  for (const t of turns) teamIds.add(t.team_id)
  for (const e of events) {
    teamIds.add(e.bidder_team_id)
    if (e.prev_leader_team_id) teamIds.add(e.prev_leader_team_id)
  }

  const managersByTeam = new Map<string, string[]>()
  if (teamIds.size > 0) {
    const { data: teams } = await admin
      .from('teams')
      .select('id, user_id, assistant_user_id')
      .in('id', [...teamIds])
    for (const t of teams ?? []) {
      managersByTeam.set(
        t.id as string,
        [t.user_id, t.assistant_user_id].filter((id): id is string => !!id)
      )
    }
  }

  // Same for the watchlists: one query for every player on the board rather
  // than one per event.
  const watchersByPlayer = new Map<string, string[]>()
  const playerIds = [...new Set(events.map(e => e.player_id))]
  if (playerIds.length > 0) {
    const { data: watches } = await admin
      .from('player_watch')
      .select('player_id, user_id')
      .in('player_id', playerIds)
    for (const w of watches ?? []) {
      const list = watchersByPlayer.get(w.player_id as string) ?? []
      list.push(w.user_id as string)
      watchersByPlayer.set(w.player_id as string, list)
    }
  }

  let sent = 0
  let pruned = 0
  let turnsSent = 0
  let bidsSent = 0

  // ── 1. Whose turn it is to put a player up ────────────────────────────────
  for (const turn of turns) {
    // Claim before sending: the partial unique index on (team_id, turn_rank) is
    // what stops two overlapping ticks from both sending.
    const { data: claim, error: claimError } = await admin
      .from('open_notifications')
      .insert({
        league_id: turn.league_id,
        kind: 'turn',
        team_id: turn.team_id,
        turn_rank: turn.turn_rank,
      })
      .select('id')
      .single()
    if (claimError || !claim) continue

    turnsSent++
    const result = await sendPushToUsers(
      managersByTeam.get(turn.team_id) ?? [],
      {
        title: '🏀 תורך להעלות שחקן',
        // No body: the title IS the whole message. A line explaining what a
        // turn means was noise to a manager who already knows the format.
        body: '',
        url: '/players',
        tag: `open-turn-${turn.team_id}`,
      },
      TURN_TTL_SECONDS
    )
    sent += result.sent
    pruned += result.pruned

    await admin
      .from('open_notifications')
      .update({ sent_at: new Date().toISOString(), recipients: result.recipients })
      .eq('id', claim.id)
  }

  // ── 2. A starred player went up or was raised, and whoever was outbid ─────
  for (const event of events) {
    const { data: claim, error: claimError } = await admin
      .from('open_notifications')
      .insert({ league_id: event.league_id, kind: 'bid', open_bid_id: event.bid_id })
      .select('id')
      .single()
    if (claimError || !claim) continue

    bidsSent++

    // The team that just bid is never told about its own bid — including the
    // manager who starred the player they nominated.
    const bidders = new Set(managersByTeam.get(event.bidder_team_id) ?? [])

    // Only on a raise: open_place_bid() refuses a bid from the current leader,
    // so the bid under this one always belongs to the team just overtaken.
    const outbid =
      !event.is_opening && event.prev_leader_team_id && event.prev_leader_team_id !== event.bidder_team_id
        ? (managersByTeam.get(event.prev_leader_team_id) ?? []).filter(id => !bidders.has(id))
        : []
    const outbidSet = new Set(outbid)

    // A user who was outbid AND starred the player gets one push, not two —
    // "you have been outbid" is the stronger of the two messages.
    const watchers = (watchersByPlayer.get(event.player_id) ?? []).filter(
      id => !bidders.has(id) && !outbidSet.has(id)
    )

    // Same tag for the whole auction: a later raise replaces the earlier toast
    // in the tray instead of stacking a stale price on top of it.
    const tag = `open-auction-${event.open_auction_id}`
    let recipients = 0

    if (watchers.length > 0) {
      const result = await sendPushToUsers(
        [...new Set(watchers)],
        event.is_opening
          ? {
              title: `⭐ ${event.player_name} עלה למכרז`,
              body: `מחיר פתיחה $${event.amount} · העלתה ${event.bidder_team_name}`,
              url: '/auction',
              tag,
            }
          : {
              title: `⭐ ${event.bidder_team_name} שמה הצעה על ${event.player_name}`,
              body: `$${event.amount}`,
              url: '/auction',
              tag,
            },
        BID_TTL_SECONDS
      )
      sent += result.sent
      pruned += result.pruned
      recipients += result.recipients
    }

    if (outbid.length > 0) {
      const result = await sendPushToUsers(
        [...new Set(outbid)],
        {
          title: `❗ עקפו אותך על ${event.player_name}`,
          body: `${event.bidder_team_name} הציעה $${event.amount}`,
          url: '/auction',
          tag,
        },
        BID_TTL_SECONDS
      )
      sent += result.sent
      pruned += result.pruned
      recipients += result.recipients
    }

    await admin
      .from('open_notifications')
      .update({ sent_at: new Date().toISOString(), recipients })
      .eq('id', claim.id)
  }

  // The two candidate counts are reported so a manual curl can tell "nothing is
  // due" apart from a query that matched nothing it should have.
  return NextResponse.json({
    turns: turns.length,
    turnsSent,
    bidEvents: events.length,
    bidsSent,
    sent,
    pruned,
  })
}

// pg_cron calls this via net.http_post, so the route must accept POST too — a
// GET-only handler returns 405 and the job silently never fires.
export const POST = GET
