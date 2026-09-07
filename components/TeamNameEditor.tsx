'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Props {
  teamId: string
  name: string
  // Owner-only. The assistant manager is deliberately excluded — see /api/team/rename.
  canEdit: boolean
}

// Subtle text-link style — same convention as AssistantManager, so the pencil
// stays out of the way until someone looks for it.
const linkStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  cursor: 'pointer',
  textDecoration: 'none',
}

export default function TeamNameEditor({ teamId, name, canEdit }: Props) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(name)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const router = useRouter()

  function open() {
    setValue(name)
    setError('')
    setEditing(true)
  }

  function cancel() {
    setEditing(false)
    setError('')
  }

  async function save() {
    if (!value.trim() || value.trim() === name) { cancel(); return }
    setLoading(true)
    setError('')
    const res = await fetch('/api/team/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, name: value }),
    })
    const json = await res.json()
    if (!res.ok) {
      setError(json.error ?? 'שגיאה')
      setLoading(false)
      return
    }
    setEditing(false)
    setLoading(false)
    router.refresh()
  }

  if (!canEdit) return <h2 className="font-bold text-lg">{name}</h2>

  if (editing) {
    return (
      <span className="inline-flex flex-col gap-1">
        <span className="inline-flex items-center gap-1">
          <input
            className="input text-sm"
            style={{ width: 150 }}
            value={value}
            maxLength={40}
            autoFocus
            disabled={loading}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') save()
              if (e.key === 'Escape') cancel()
            }}
          />
          <button
            className="btn btn-primary text-xs"
            disabled={loading}
            onClick={save}
          >
            {loading ? '...' : 'שמור'}
          </button>
          <button className="btn btn-outline text-xs" disabled={loading} onClick={cancel}>
            בטל
          </button>
        </span>
        {error && <span className="text-xs" style={{ color: 'var(--danger)' }}>{error}</span>}
      </span>
    )
  }

  return (
    <>
      <h2 className="font-bold text-lg">{name}</h2>
      <button onClick={open} style={{ ...linkStyle, color: 'var(--muted)', fontSize: '0.75rem' }} title="שנה שם">
        ✏️
      </button>
    </>
  )
}
