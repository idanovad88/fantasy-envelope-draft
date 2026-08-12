'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export default function RealtimeRefresher({ leagueId }: { leagueId: string }) {
  const router = useRouter()

  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel('realtime-' + leagueId)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'auctions', filter: `league_id=eq.${leagueId}`,
      }, () => router.refresh())
      // Team stats (budget_remaining / player_count) change on auction resolve and
      // on cancel — including cancelling a *completed* win, which refunds the team
      // via an UPDATE here but only DELETEs the auction row (no auctions UPDATE
      // fires). This keeps the dashboard stats card in sync in that case too.
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'teams', filter: `league_id=eq.${leagueId}`,
      }, () => router.refresh())
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'snake_picks', filter: `league_id=eq.${leagueId}`,
      }, () => router.refresh())
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'trades', filter: `league_id=eq.${leagueId}`,
      }, () => router.refresh())
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'pick_overrides', filter: `league_id=eq.${leagueId}`,
      }, () => router.refresh())
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [leagueId, router])

  return null
}
