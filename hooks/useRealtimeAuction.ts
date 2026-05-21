'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { Auction } from '@/types'

export function useRealtimeAuction(leagueId: string | null) {
  const [activeAuction, setActiveAuction] = useState<Auction | null>(null)
  const supabase = createClient()

  useEffect(() => {
    if (!leagueId) return

    const channel = supabase
      .channel('auction-updates')
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'auctions',
        filter: `league_id=eq.${leagueId}`,
      }, payload => {
        const auction = payload.new as Auction
        if (auction.status === 'active') {
          setActiveAuction(auction)
        } else if (activeAuction?.id === auction.id) {
          setActiveAuction(null)
        }
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [leagueId])

  return activeAuction
}
