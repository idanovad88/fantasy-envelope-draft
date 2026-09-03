'use client'

import { useMemo, useState } from 'react'

export type FilterablePlayer = {
  name: string
  position: string | null
  ranking: number | null
}

export type SortKey = 'rank' | 'name'

/** Canonical order for the position chips; anything else follows, alphabetically. */
const POSITION_ORDER = ['PG', 'SG', 'SF', 'PF', 'C']

function splitPositions(position: string | null): string[] {
  return (position ?? '').split('/').map(p => p.trim()).filter(Boolean)
}

/**
 * Search + position filter + sort for the two player tables.
 *
 * Sorting client-side rather than leaning on the server's `.order()` is what
 * makes the "by name" option and the position chips possible without a
 * refetch, and it keeps unranked players pinned to the bottom instead of
 * wherever Postgres happened to return them.
 */
export function usePlayerFilter<T extends FilterablePlayer>(players: T[]) {
  const [query, setQuery] = useState('')
  const [position, setPosition] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('rank')

  const positions = useMemo(() => {
    const seen = new Set<string>()
    // A player listed as "PG/SG" belongs under both chips.
    for (const p of players) for (const part of splitPositions(p.position)) seen.add(part)
    return [...seen].sort((a, b) => {
      const ai = POSITION_ORDER.indexOf(a), bi = POSITION_ORDER.indexOf(b)
      if (ai !== -1 && bi !== -1) return ai - bi
      if (ai !== -1) return -1
      if (bi !== -1) return 1
      return a.localeCompare(b)
    })
  }, [players])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const out = players.filter(p =>
      (!q || p.name.toLowerCase().includes(q)) &&
      (!position || splitPositions(p.position).includes(position))
    )
    return out.sort((a, b) => {
      if (sortKey === 'name') return a.name.localeCompare(b.name)
      // Unranked players sort last, then alphabetically among themselves.
      if (a.ranking === null && b.ranking === null) return a.name.localeCompare(b.name)
      if (a.ranking === null) return 1
      if (b.ranking === null) return -1
      return a.ranking - b.ranking || a.name.localeCompare(b.name)
    })
  }, [players, query, position, sortKey])

  return { query, setQuery, position, setPosition, sortKey, setSortKey, positions, filtered }
}
