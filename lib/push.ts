import webpush from 'web-push'
import { createAdminClient } from '@/lib/supabase/server'

/**
 * Web Push sending, shared by the two notification crons.
 *
 * Both routes must run on `runtime = 'nodejs'` — web-push needs Node's crypto
 * and breaks on the edge runtime.
 */

export interface PushPayload {
  title: string
  body: string
  /** Where notificationclick takes the user. */
  url: string
  /**
   * Notification tag. A later push with the same tag REPLACES the earlier one
   * in the tray instead of stacking, which is what keeps a contested auction
   * from filling a phone with stale prices.
   */
  tag: string
  /**
   * Legacy: service workers installed before `tag` existed derive the tag from
   * this field instead. Harmless to keep sending, and a phone that has not
   * revisited the app still gets its notifications grouped per auction.
   */
  auctionId?: string
}

/**
 * Set the VAPID details once per request. Returns false when the env is
 * incomplete, which is a configuration error the caller should surface as a
 * 500 rather than an empty send.
 */
export function configureWebPush(): boolean {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  const subject = process.env.VAPID_SUBJECT
  if (!publicKey || !privateKey || !subject) return false
  webpush.setVapidDetails(subject, publicKey, privateKey)
  return true
}

/**
 * Push `payload` to every device belonging to `userIds`.
 *
 * Dead endpoints (404/410) are deleted — a browser that dropped the
 * subscription will never accept another. A VAPID rejection (401/403) is
 * logged and nothing is deleted: that is one bad key, and pruning on it would
 * wipe every subscription in the app.
 *
 * `ttl` is seconds. Pass the time until the event stops mattering so a phone
 * that was offline through it never buzzes about it afterwards.
 */
export async function sendPushToUsers(
  userIds: string[],
  payload: PushPayload,
  ttl: number
): Promise<{ sent: number; pruned: number; recipients: number }> {
  if (userIds.length === 0) return { sent: 0, pruned: 0, recipients: 0 }

  const admin = createAdminClient()
  const { data: subs } = await admin
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth')
    .in('user_id', userIds)

  if (!subs || subs.length === 0) return { sent: 0, pruned: 0, recipients: 0 }

  const body = JSON.stringify(payload)
  const results = await Promise.allSettled(
    subs.map(s =>
      webpush.sendNotification(
        { endpoint: s.endpoint as string, keys: { p256dh: s.p256dh as string, auth: s.auth as string } },
        body,
        { TTL: Math.max(0, Math.floor(ttl)), urgency: 'high' }
      )
    )
  )

  let sent = 0
  const dead: string[] = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      sent++
      return
    }
    const status = (r.reason as { statusCode?: number })?.statusCode
    if (status === 404 || status === 410) {
      dead.push(subs[i].endpoint as string)
    } else if (status === 401 || status === 403) {
      console.error('[push] VAPID rejected (check keys):', status)
    } else {
      console.error('[push] send failed:', status ?? r.reason)
    }
  })

  if (dead.length > 0) {
    await admin.from('push_subscriptions').delete().in('endpoint', dead)
  }

  return { sent, pruned: dead.length, recipients: subs.length - dead.length }
}
