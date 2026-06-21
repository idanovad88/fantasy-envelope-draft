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
