'use client'

import { useState } from 'react'

interface AssistantManagerProps {
  teamId: string
  hasAssistant: boolean
  assistantEmail: string | null
}

// Subtle text-link style — keeps the invite option unobtrusive inside the team card.
const linkStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  cursor: 'pointer',
  textDecoration: 'underline',
}

export default function AssistantManager({ teamId, hasAssistant, assistantEmail }: AssistantManagerProps) {
  const [loading, setLoading] = useState(false)
  const [link, setLink] = useState('')
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')

  async function generate() {
    setLoading(true)
    setError('')
    const res = await fetch('/api/team/invite', { method: 'POST' })
    const json = await res.json()
    if (!res.ok) {
      setError(json.error ?? 'שגיאה')
      setLoading(false)
      return
    }
    setLink(json.url)
    setLoading(false)
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable — user can select manually */
    }
  }

  async function remove() {
    if (!confirm('להסיר את עוזר המנהל מהקבוצה?')) return
    setLoading(true)
    setError('')
    const res = await fetch('/api/team/remove-assistant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId }),
    })
    const json = await res.json()
    if (!res.ok) {
      setError(json.error ?? 'שגיאה')
      setLoading(false)
      return
    }
    window.location.reload()
  }

  // Generated invite link — only appears after the owner explicitly asks for it.
  if (link) {
    return (
      <div className="mt-3 flex flex-col gap-1">
        <p className="text-xs" style={{ color: 'var(--muted)' }}>שלח את הקישור לעוזר (תקף ל-7 ימים):</p>
        <div className="flex gap-2">
          <input className="input text-xs" readOnly value={link} dir="ltr" onFocus={e => e.target.select()} />
          <button className="btn btn-outline text-xs whitespace-nowrap" onClick={copy}>{copied ? '✓ הועתק' : 'העתק'}</button>
        </div>
        {error && <p className="text-xs" style={{ color: 'var(--danger)' }}>{error}</p>}
      </div>
    )
  }

  // Default: a small, left-aligned link — unobtrusive within the team card.
  return (
    <div className="mt-2" style={{ textAlign: 'left' }}>
      {hasAssistant ? (
        <span className="text-xs inline-flex items-center gap-1.5" style={{ color: 'var(--muted)' }}>
          <span className="truncate" dir="ltr" style={{ maxWidth: 150, display: 'inline-block', verticalAlign: 'bottom' }}>
            עוזר: {assistantEmail ?? 'מחובר'}
          </span>
          <button onClick={remove} disabled={loading} className="text-xs" style={{ ...linkStyle, color: 'var(--danger)' }}>
            {loading ? '...' : 'הסר'}
          </button>
        </span>
      ) : (
        <button onClick={generate} disabled={loading} className="text-xs" style={{ ...linkStyle, color: 'var(--muted)' }}>
          {loading ? 'יוצר...' : '+ הזמן עוזר מנהל'}
        </button>
      )}
      {error && <p className="text-xs mt-1" style={{ color: 'var(--danger)', textAlign: 'right' }}>{error}</p>}
    </div>
  )
}
