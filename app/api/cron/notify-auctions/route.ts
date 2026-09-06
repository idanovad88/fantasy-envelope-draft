import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { activateAllOverduePendingAuctions } from '@/lib/auctions'
import { configureWebPush, sendPushToUsers } from '@/lib/push'

// web-push needs Node's crypto — this breaks on the edge runtime.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// The cron only ever needs to look this far ahead; leagues.notify_before_minutes
// is CHECK-constrained to <= 60, which is what makes a fixed window correct.
const PREFETCH_MINUTES = 60

interface DueAuction {
  id: string
  league_id: string
  reveal_time: string
  player: { name: string } | null
  // Not aliased: PostgREST resolves embedded filters against the alias when one
  // is given, so `leagues!inner` + `.eq('leagues.draft_type', …)` is the form
  // that is unambiguously correct. Aliasing this would silently match nothing.
  leagues: { notify_before_minutes: number } | null
}

/**
 * Called every minute by Supabase pg_cron (see supabase/cron_notify_auctions.sql).
 * Sends a Web Push reminder to every manager and assistant manager of an
 * approved team, for any envelope auction that closes within its league's
 * notify_before_minutes.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  // A missing secret must not leave the route open.
  if (!secret) {
    console.error('[notify-auctions] CRON_SECRET is not set')
    return NextResponse.json({ error: 'Not configured' }, { status: 500 })
  }
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!configureWebPush()) {
    console.error('[notify-auctions] VAPID env vars are incomplete')
    return NextResponse.json({ error: 'Not configured' }, { status: 500 })
  }

  const admin = createAdminClient()

  // Nothing else transitions pending → active on a timer, so an auction could
  // otherwise reach its reveal window while bidding is still closed.
  const activated = await activateAllOverduePendingAuctions()

  const now = Date.now()
  const { data: candidates, error } = await admin
    .from('auctions')
    .select('id, league_id, reveal_time, player:players(name), leagues!inner(notify_before_minutes, draft_type)')
    // 'active' only, deliberately: a pending auction cannot be bid on (BidForm
    // renders for active only, and the bids RLS insert policy requires it), so
    // "you haven't bid yet" would point at a form that rejects them. The
    // activation step above has already promoted anything that should be open.
    .eq('status', 'active')
    .eq('leagues.draft_type', 'envelope')
    .gt('reveal_time', new Date(now).toISOString())
    .lte('reveal_time', new Date(now + PREFETCH_MINUTES * 60_000).toISOString())

  if (error) {
    console.error('[notify-auctions] query failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // notify_before_minutes is per-league, so the final window check is in TS.
  const due = ((candidates ?? []) as unknown as DueAuction[]).filter(a => {
    const lead = a.leagues?.notify_before_minutes ?? 5
    return new Date(a.reveal_time).getTime() - now <= lead * 60_000
  })

  let sent = 0
  let pruned = 0
  let processed = 0

  for (const auction of due) {
    // Claim before sending: the UNIQUE (auction_id, kind, reveal_time) key means
    // an overlapping tick loses here instead of double-sending.
    const { data: claim, error: claimError } = await admin
      .from('auction_notifications')
      .insert({ auction_id: auction.id, kind: 'pre_reveal', reveal_time: auction.reveal_time })
      .select('id')
      .single()
    if (claimError || !claim) continue

    processed++

    // Every manager and assistant manager in the league gets the reminder,
    // whether or not they have already bid, and whether or not their roster is
    // complete — a finished team still follows the draft, so it is told when an
    // auction is about to close.
    const { data: teams } = await admin
      .from('teams').select('user_id, assistant_user_id')
      .eq('league_id', auction.league_id).eq('approved', true)

    const userIds = [...new Set(
      (teams ?? [])
        .flatMap(t => [t.user_id, t.assistant_user_id])
        .filter((id): id is string => !!id)
    )]

    const lead = auction.leagues?.notify_before_minutes ?? 5
    const playerName = auction.player?.name ?? 'שחקן'
    // A phone that was offline past the deadline should never buzz about it.
    const ttl = Math.max(0, Math.floor((new Date(auction.reveal_time).getTime() - Date.now()) / 1000))

    const result = await sendPushToUsers(
      userIds,
      {
        title: `⏰ נותרו ${lead} דקות`,
        body: `המכרז על ${playerName} עומד להיסגר`,
        url: '/auction',
        tag: `auction-${auction.id}`,
        auctionId: auction.id,
      },
      ttl
    )
    sent += result.sent
    pruned += result.pruned

    await admin.from('auction_notifications')
      .update({ sent_at: new Date().toISOString(), recipients: result.recipients })
      .eq('id', claim.id)
  }

  // `candidates` is reported so a manual curl can tell "no auction is close to
  // reveal" apart from "the leagues!inner join matched nothing" — the latter
  // would otherwise fail silently and send nothing, forever.
  return NextResponse.json({ activated, candidates: candidates?.length ?? 0, due: due.length, processed, sent, pruned })
}

// Supabase pg_cron calls this via net.http_post, so the route must accept POST
// too — a GET-only handler returns 405 and the job silently never fires. A
// manual `curl` (GET) and the cron (POST) now hit the same logic.
export const POST = GET
