'use client'

import { useMemo, useState } from 'react'

export type FilterablePlayer = {
  id: string
  name: string
  position: string | null
  ranking: number | null
}

export type SortKey = 'rank' | 'name'

/** Canonical order for the position chips; anything else follows, alphabetically. */
const POSITION_ORDER = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C']

/**
 * G and F are group chips, not positions of their own: they stand for the
 * guards and the forwards, the same way the G and F roster slots do.
 *
 * Each group also covers a player listed as a bare "G" or "F" — the pool has
 * a few, ESPN lists them that way — so the chip is a superset of its own
 * label rather than something competing with it. Without that a bare-G player
 * would be the *only* thing behind the G chip, which is what made pressing it
 * look broken: 5 rows out of 135 guards.
 */
const POSITION_GROUPS: Record<string, string[]> = {
  G: ['PG', 'SG', 'G'],
  F: ['SF', 'PF', 'F'],
}

function splitPositions(position: string | null): string[] {
  return (position ?? '').split('/').map(p => p.trim()).filter(Boolean)
}

/** Does a player belong under `chip` — a group chip or a plain position? */
function matchesPosition(position: string | null, chip: string): boolean {
  const parts = splitPositions(position)
  const group = POSITION_GROUPS[chip]
  return group ? parts.some(p => group.includes(p)) : parts.includes(chip)
}

/**
 * Search + position filter + sort for the two player tables.
 *
 * Sorting client-side rather than leaning on the server's `.order()` is what
 * makes the "by name" option and the position chips possible without a
 * refetch, and it keeps unranked players pinned to the bottom instead of
 * wherever Postgres happened to return them.
 *
 * `watchedIds` is optional and turns on the "starred only" chip. Passing it is
 * what makes the chip exist at all — the pages that have no watchlist (snake,
 * envelope) leave it out and get exactly the previous behaviour.
 */
export function usePlayerFilter<T extends FilterablePlayer>(players: T[], watchedIds?: Set<string>) {
  const [query, setQuery] = useState('')
  const [position, setPosition] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('rank')
  const [starredOnly, setStarredOnly] = useState(false)

  const positions = useMemo(() => {
    const seen = new Set<string>()
    // A player listed as "PG/SG" belongs under both chips.
    for (const p of players) for (const part of splitPositions(p.position)) seen.add(part)
    // A group chip appears as soon as anyone in the pool falls under it.
    for (const [chip, group] of Object.entries(POSITION_GROUPS)) {
      if (group.some(p => seen.has(p))) seen.add(chip)
    }
    return [...seen].sort((a, b) => {
      const ai = POSITION_ORDER.indexOf(a), bi = POSITION_ORDER.indexOf(b)
      if (ai !== -1 && bi !== -1) return ai - bi
      if (ai !== -1) return -1
      if (bi !== -1) return 1
      return a.localeCompare(b)
    })
  }, [players])

  // Counted over this list, not over the whole watchlist: a player who has
  // already been drafted is starred but not here, and the chip must not promise
  // rows it cannot show.
  const starredCount = useMemo(
    () => (watchedIds ? players.filter(p => watchedIds.has(p.id)).length : 0),
    [players, watchedIds]
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const out = players.filter(p =>
      (!q || p.name.toLowerCase().includes(q)) &&
      (!position || matchesPosition(p.position, position)) &&
      (!starredOnly || !!watchedIds?.has(p.id))
    )
    return out.sort((a, b) => {
      if (sortKey === 'name') return a.name.localeCompare(b.name)
      // Unranked players sort last, then alphabetically among themselves.
      if (a.ranking === null && b.ranking === null) return a.name.localeCompare(b.name)
      if (a.ranking === null) return 1
      if (b.ranking === null) return -1
      return a.ranking - b.ranking || a.name.localeCompare(b.name)
    })
  }, [players, query, position, sortKey, starredOnly, watchedIds])

  return {
    query, setQuery,
    position, setPosition,
    sortKey, setSortKey,
    starredOnly, setStarredOnly, starredCount,
    positions, filtered,
  }
}
