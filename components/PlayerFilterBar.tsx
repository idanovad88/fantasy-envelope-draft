'use client'

import type { SortKey } from '@/hooks/usePlayerFilter'

interface Props {
  title: string
  /** Total in the pool, and how many survive the current filter. */
  total: number
  shown: number
  query: string
  onQuery: (v: string) => void
  positions: string[]
  position: string | null
  onPosition: (v: string | null) => void
  sortKey: SortKey
  onSort: (v: SortKey) => void
}

const chipStyle = (active: boolean) => ({
  fontSize: '0.7rem',
  padding: '3px 9px',
  borderRadius: '999px',
  border: `1px solid ${active ? 'var(--primary)' : 'var(--border)'}`,
  background: active ? 'rgba(99,102,241,0.2)' : 'transparent',
  color: active ? 'var(--primary)' : 'var(--muted)',
  cursor: 'pointer',
})

export default function PlayerFilterBar({
  title, total, shown, query, onQuery,
  positions, position, onPosition, sortKey, onSort,
}: Props) {
  const filtering = shown !== total

  return (
    <>
      <div className="flex items-center justify-between mb-2 gap-3">
        <h2 className="font-bold whitespace-nowrap">
          {title} ({filtering ? `${shown}/${total}` : total})
        </h2>
        <input
          className="input text-sm flex-1 max-w-48"
          placeholder="חיפוש שחקן..."
          value={query}
          onChange={e => onQuery(e.target.value)}
          dir="ltr"
        />
      </div>

      <div className="flex items-center gap-1 mb-3 flex-wrap">
        <button type="button" style={chipStyle(position === null)} onClick={() => onPosition(null)}>
          הכל
        </button>
        {positions.map(p => (
          <button
            key={p}
            type="button"
            style={chipStyle(position === p)}
            onClick={() => onPosition(position === p ? null : p)}
          >
            {p}
          </button>
        ))}

        <span className="mr-auto flex items-center gap-1">
          <span className="text-xs" style={{ color: 'var(--muted)' }}>מיון:</span>
          <button type="button" style={chipStyle(sortKey === 'rank')} onClick={() => onSort('rank')}>
            דירוג
          </button>
          <button type="button" style={chipStyle(sortKey === 'name')} onClick={() => onSort('name')}>
            שם
          </button>
        </span>
      </div>
    </>
  )
}
