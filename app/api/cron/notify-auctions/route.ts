import { NextResponse } from 'next/server'
import webpush from 'web-push'
import { createAdminClient } from '@/lib/supabase/server'
import { activateAllOverduePendingAuctions } from '@/lib/auctions'

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
 * Sends a Web Push reminder to every team that has not yet bid on an envelope
 * auction that closes within its league's notify_before_minutes.
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

  const vapidPublic = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY
  const vapidSubject = process.env.VAPID_SUBJECT
  if (!vapidPublic || !vapidPrivate || !vapidSubject) {
    console.error('[notify-auctions] VAPID env vars are incomplete')
    return NextResponse.json({ error: 'Not configured' }, { status: 500 })
  }
  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate)

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
    // whether or not they have already bid. Completed rosters are excluded —
    // a full team can no longer bid, so a reminder would just be noise.
    const { data: teams } = await admin
      .from('teams').select('user_id, assistant_user_id')
      .eq('league_id', auction.league_id).eq('approved', true).eq('is_complete', false)

    const userIds = [...new Set(
      (teams ?? [])
        .flatMap(t => [t.user_id, t.assistant_user_id])
        .filter((id): id is string => !!id)
    )]

    if (userIds.length === 0) {
      await admin.from('auction_notifications')
        .update({ sent_at: new Date().toISOString(), recipients: 0 }).eq('id', claim.id)
      continue
    }

    const { data: subs } = await admin
      .from('push_subscriptions').select('endpoint, p256dh, auth').in('user_id', userIds)

    if (!subs || subs.length === 0) {
      await admin.from('auction_notifications')
        .update({ sent_at: new Date().toISOString(), recipients: 0 }).eq('id', claim.id)
      continue
    }

    const lead = auction.leagues?.notify_before_minutes ?? 5
    const playerName = auction.player?.name ?? 'שחקן'
    const payload = JSON.stringify({
      title: `⏰ נותרו ${lead} דקות`,
      body: `המכרז על ${playerName} עומד להיסגר`,
      url: '/auction',
      auctionId: auction.id,
    })
    // A phone that was offline past the deadline should never buzz about it.
    const ttl = Math.max(0, Math.floor((new Date(auction.reveal_time).getTime() - Date.now()) / 1000))

    const results = await Promise.allSettled(
      subs.map(s => webpush.sendNotification(
        { endpoint: s.endpoint as string, keys: { p256dh: s.p256dh as string, auth: s.auth as string } },
        payload,
        { TTL: ttl, urgency: 'high' },
      ))
    )

    const dead: string[] = []
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') { sent++; return }
      const status = (r.reason as { statusCode?: number })?.statusCode
      if (status === 404 || status === 410) {
        dead.push(subs[i].endpoint as string)
      } else if (status === 401 || status === 403) {
        // VAPID misconfiguration — deleting here would wipe every subscription
        // over one bad key.
        console.error('[notify-auctions] VAPID rejected (check keys):', status)
      } else {
        console.error('[notify-auctions] send failed:', status ?? r.reason)
      }
    })

    if (dead.length > 0) {
      await admin.from('push_subscriptions').delete().in('endpoint', dead)
      pruned += dead.length
    }

    await admin.from('auction_notifications')
      .update({ sent_at: new Date().toISOString(), recipients: subs.length - dead.length })
      .eq('id', claim.id)
  }

  // `candidates` is reported so a manual curl can tell "no auction is close to
  // reveal" apart from "the leagues!inner join matched nothing" — the latter
  // would otherwise fail silently and send nothing, forever.
  return NextResponse.json({ activated, candidates: candidates?.length ?? 0, due: due.length, processed, sent, pruned })
}
