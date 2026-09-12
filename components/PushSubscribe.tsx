'use client'

import { useEffect, useState } from 'react'

// Matches AssistantManager's unobtrusive text-link style inside the team card.
const linkStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  cursor: 'pointer',
  textDecoration: 'none',
}

// Small, right-aligned caption row inside the team card (RTL → right = start).
const rowStyle: React.CSSProperties = { textAlign: 'right', fontSize: '0.7rem' }

// VAPID public keys are base64url; PushManager requires the raw bytes.
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const output = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i)
  return output
}

type State = 'loading' | 'unsupported' | 'ios-not-installed' | 'denied' | 'subscribed' | 'idle'

// How long a successful /api/push/subscribe stands before the next mount
// re-sends it. The endpoint is the identity of the registration, so a change to
// it is re-sent immediately whatever this says; the interval only bounds how
// long a subscription row deleted server-side (pruned on a 404/410 from the
// push service) can stay missing while the browser still holds the endpoint.
const SUBSCRIPTION_SYNC_TTL_MS = 24 * 60 * 60 * 1000
const SYNC_KEY = 'push-subscription-synced'

// localStorage can throw outright (Safari private browsing, blocked site data),
// and a throw here must not cost the user their notifications — fall back to
// sending, which is exactly the old behaviour.
function shouldSyncSubscription(endpoint: string): boolean {
  try {
    const raw = window.localStorage.getItem(SYNC_KEY)
    if (!raw) return true
    const { endpoint: seen, at } = JSON.parse(raw) as { endpoint?: string; at?: number }
    if (seen !== endpoint || typeof at !== 'number') return true
    return Date.now() - at > SUBSCRIPTION_SYNC_TTL_MS
  } catch {
    return true
  }
}

function markSubscriptionSynced(endpoint: string): void {
  try {
    window.localStorage.setItem(SYNC_KEY, JSON.stringify({ endpoint, at: Date.now() }))
  } catch {}
}

/**
 * Ask the browser for a push subscription, and try a second time on failure
 * with whatever subscription it is already holding thrown away.
 *
 * A phone that has subscribed before — under an earlier VAPID key, an earlier
 * install of the PWA, or a service worker that has since been replaced — can be
 * left with a registration the push service will no longer honour. Chrome and
 * iOS both report that as a flat "Registration failed - push service error"
 * with nothing to act on, and it is unrecoverable from the UI: the button looks
 * broken forever while the same code works on a desktop that never subscribed.
 * Dropping the stale one is the whole fix. If the retry fails too, the error is
 * real and it propagates.
 */
async function subscribeWithRetry(reg: ServiceWorkerRegistration, vapidKey: string) {
  const options: PushSubscriptionOptionsInit = {
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidKey) as BufferSource,
  }
  try {
    return await reg.pushManager.subscribe(options)
  } catch (first) {
    const existing = await reg.pushManager.getSubscription()
    if (!existing) throw first
    await existing.unsubscribe().catch(() => {})
    return await reg.pushManager.subscribe(options)
  }
}

interface Props {
  /**
   * What the enable button says. The envelope dashboard has one notification to
   * name; the open board has three (your turn, a starred player, being outbid),
   * so it passes something that covers all of them.
   */
  label?: string
}

export default function PushSubscribe({ label = '🔔 הפעל התראות לפני חשיפת מכרז' }: Props) {
  const [state, setState] = useState<State>('loading')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Printed on screen when subscribing fails. A push service refusing is not
  // reproducible from another device — the same build works on a laptop and
  // fails on a phone — and there is no console to open on a phone, so the few
  // facts that separate the causes have to be visible in the UI itself: which
  // error the browser actually raised, iOS vs Android, PWA vs browser tab, the
  // permission state, and the key THIS bundle is using (a different key here
  // than on the machine where it works is a deploy problem, not a device one).
  const [details, setDetails] = useState('')

  const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY

  useEffect(() => {
    async function init() {
      if (typeof window === 'undefined') return

      const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent)
      const isStandalone =
        window.matchMedia('(display-mode: standalone)').matches ||
        (navigator as Navigator & { standalone?: boolean }).standalone === true

      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        // iOS only exposes PushManager inside an installed PWA (16.4+), so it
        // lands here — tell them how to fix it instead of vanishing silently.
        setState(isIos && !isStandalone ? 'ios-not-installed' : 'unsupported')
        return
      }
      if (Notification.permission === 'denied') {
        setState('denied')
        return
      }

      try {
        const reg = await navigator.serviceWorker.register('/sw.js')
        await navigator.serviceWorker.ready
        const sub = await reg.pushManager.getSubscription()
        if (sub) {
          // Silently re-POST: self-heals a rotated endpoint, and the upsert
          // makes it free on the database. It is not free on Vercel — this
          // component is mounted in the "my team" card of two dashboards, so
          // an unconditional POST here was a function invocation (two, with
          // the proxy) on every single dashboard load, for every manager, all
          // day. Send it only when it can tell us something new: a changed
          // endpoint, or once a day so a row pruned at the other end still
          // heals on its own.
          if (shouldSyncSubscription(sub.endpoint)) {
            const res = await fetch('/api/push/subscribe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(sub.toJSON()),
            })
            if (res.ok) markSubscriptionSynced(sub.endpoint)
          }
          setState('subscribed')
        } else {
          setState('idle')
        }
      } catch {
        setState('unsupported')
      }
    }
    init()
  }, [])

  async function enable() {
    if (!vapidKey) return
    setBusy(true)
    setError('')
    setDetails('')
    try {
      // requestPermission must be the first await — iOS drops the user-gesture
      // context across an earlier one.
      const perm = await Notification.requestPermission()
      if (perm !== 'granted') {
        setState(perm === 'denied' ? 'denied' : 'idle')
        setBusy(false)
        return
      }
      const reg = await navigator.serviceWorker.register('/sw.js')
      await navigator.serviceWorker.ready
      const sub = await subscribeWithRetry(reg, vapidKey)
      const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        throw new Error(json.error ?? 'שגיאה בשמירת ההרשמה')
      }
      markSubscriptionSynced(sub.endpoint)
      setState('subscribed')
    } catch (e) {
      const err = e as { name?: string; message?: string }
      setError('ההרשמה להתראות נכשלה. שלח את השורה הבאה כדי שנדע למה:')
      const ua = navigator.userAgent
      const platform = /iphone|ipad|ipod/i.test(ua) ? 'iOS' : /android/i.test(ua) ? 'Android' : 'desktop'
      const standalone =
        window.matchMedia('(display-mode: standalone)').matches ||
        (navigator as Navigator & { standalone?: boolean }).standalone === true
      setDetails([
        err.name || 'no-name',
        err.message || 'no-message',
        platform + (standalone ? '/PWA' : '/browser'),
        'perm=' + Notification.permission,
        'sw=' + ('serviceWorker' in navigator),
        `key=${vapidKey.slice(0, 8)}..${vapidKey.length}`,
      ].join(' | '))
    }
    setBusy(false)
  }

  async function disable() {
    setBusy(true)
    setError('')
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        const endpoint = sub.endpoint
        // Attempt both even if one fails, so we never leave a live endpoint
        // subscribed on the server after the browser dropped it.
        await sub.unsubscribe().catch(() => {})
        await fetch('/api/push/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint }),
        }).catch(() => {})
      }
      setState('idle')
    } catch {
      setError('שגיאה בכיבוי ההתראות')
    }
    setBusy(false)
  }

  // Without a configured key nothing here can work.
  if (!vapidKey) return null
  if (state === 'loading' || state === 'unsupported') return null

  if (state === 'ios-not-installed') {
    return (
      <div className="mt-2" style={rowStyle}>
        <span style={{ color: 'var(--muted)' }}>
          🔔 הוסף למסך הבית כדי לקבל התראות
        </span>
      </div>
    )
  }

  if (state === 'denied') {
    return (
      <div className="mt-2" style={rowStyle}>
        <span style={{ color: 'var(--muted)' }}>
          🔔 התראות חסומות — אפשר אותן בהגדרות הדפדפן
        </span>
      </div>
    )
  }

  return (
    <div className="mt-2" style={rowStyle}>
      {state === 'subscribed' ? (
        <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--muted)' }}>
          <span>🔔 התראות פעילות</span>
          <button onClick={disable} disabled={busy} style={{ ...linkStyle, color: 'var(--danger)' }}>
            {busy ? '...' : 'כבה'}
          </button>
        </span>
      ) : (
        <button onClick={enable} disabled={busy} style={{ ...linkStyle, color: 'var(--primary)' }}>
          {busy ? 'מפעיל...' : label}
        </button>
      )}
      {error && <p className="mt-1" style={{ color: 'var(--danger)' }}>{error}</p>}
      {details && (
        <p
          className="mt-1"
          dir="ltr"
          style={{
            color: 'var(--muted)',
            fontFamily: 'monospace',
            fontSize: '0.62rem',
            wordBreak: 'break-all',
            userSelect: 'all',
            textAlign: 'left',
          }}
        >
          {details}
        </p>
      )}
    </div>
  )
}
