'use client'

import { useEffect, useState } from 'react'

// Matches AssistantManager's unobtrusive text-link style inside the team card.
const linkStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  cursor: 'pointer',
  textDecoration: 'underline',
}

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

export default function PushSubscribe() {
  const [state, setState] = useState<State>('loading')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

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
          // makes it free.
          await fetch('/api/push/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sub.toJSON()),
          })
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
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey) as BufferSource,
      })
      const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        throw new Error(json.error ?? 'שגיאה בשמירת ההרשמה')
      }
      setState('subscribed')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'שגיאה')
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
      <div className="mt-2" style={{ textAlign: 'left' }}>
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          🔔 הוסף למסך הבית כדי לקבל התראות
        </span>
      </div>
    )
  }

  if (state === 'denied') {
    return (
      <div className="mt-2" style={{ textAlign: 'left' }}>
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          🔔 התראות חסומות — אפשר אותן בהגדרות הדפדפן
        </span>
      </div>
    )
  }

  return (
    <div className="mt-2" style={{ textAlign: 'left' }}>
      {state === 'subscribed' ? (
        <span className="text-xs inline-flex items-center gap-1.5" style={{ color: 'var(--muted)' }}>
          <span>🔔 התראות פעילות</span>
          <button onClick={disable} disabled={busy} className="text-xs" style={{ ...linkStyle, color: 'var(--danger)' }}>
            {busy ? '...' : 'כבה'}
          </button>
        </span>
      ) : (
        <button onClick={enable} disabled={busy} className="text-xs" style={{ ...linkStyle, color: 'var(--muted)' }}>
          {busy ? 'מפעיל...' : '🔔 הפעל התראות לפני חשיפת מכרז'}
        </button>
      )}
      {error && <p className="text-xs mt-1" style={{ color: 'var(--danger)', textAlign: 'right' }}>{error}</p>}
    </div>
  )
}
