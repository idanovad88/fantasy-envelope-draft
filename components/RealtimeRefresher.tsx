'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

// One logical event writes to several of the tables below — resolving an
// auction updates `auctions` and then every affected row in `teams`; approving
// a trade touches `trades`, `pick_overrides` and `teams`. Each write used to
// fire its own router.refresh(), i.e. several full server re-renders per event,
// per connected client. Coalescing a burst into one refresh costs half a second
// of latency nobody notices and cuts the server work by the size of the burst.
const REFRESH_DEBOUNCE_MS = 500

export default function RealtimeRefresher({ leagueId }: { leagueId: string }) {
  const router = useRouter()

  useEffect(() => {
    const supabase = createClient()

    let timer: ReturnType<typeof setTimeout> | null = null
    const refresh = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        router.refresh()
      }, REFRESH_DEBOUNCE_MS)
    }

    const channel = supabase
      .channel('realtime-' + leagueId)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'auctions', filter: `league_id=eq.${leagueId}`,
      }, refresh)
      // Team stats (budget_remaining / player_count) change on auction resolve and
      // on cancel — including cancelling a *completed* win, which refunds the team
      // via an UPDATE here but only DELETEs the auction row (no auctions UPDATE
      // fires). This keeps the dashboard stats card in sync in that case too.
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'teams', filter: `league_id=eq.${leagueId}`,
      }, refresh)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'snake_picks', filter: `league_id=eq.${leagueId}`,
      }, refresh)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'trades', filter: `league_id=eq.${leagueId}`,
      }, refresh)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'pick_overrides', filter: `league_id=eq.${leagueId}`,
      }, refresh)
      .subscribe()

    return () => {
      if (timer) clearTimeout(timer)
      supabase.removeChannel(channel)
    }
  }, [leagueId, router])

  return null
}
