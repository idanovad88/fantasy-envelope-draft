'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { withScrollAnchor } from '@/lib/scrollAnchor'

// One logical event writes to several of the tables below — resolving an
// auction updates `auctions` and then every affected row in `teams`; approving
// a trade touches `trades`, `pick_overrides` and `teams`. Each write used to
// fire its own router.refresh(), i.e. several full server re-renders per event,
// per connected client. Coalescing a burst into one refresh costs half a second
// of latency nobody notices and cuts the server work by the size of the burst.
const REFRESH_DEBOUNCE_MS = 500

// How long a tab may sit hidden before we stop trusting what is on it.
//
// Supabase Realtime does not replay `postgres_changes` after a reconnect, and a
// backgrounded tab — a phone especially — gets its socket suspended. So a tab
// that comes back after a while may have missed events with nothing to say so,
// and today that showed as an old price on a live board: the manager returns,
// reads a stale number, and bids against it. Refreshing once on return, whether
// or not we saw an event, closes that.
const STALE_AFTER_HIDDEN_MS = 60_000

export default function RealtimeRefresher({
  leagueId,
  openBoard = false,
}: {
  leagueId: string
  /**
   * Watch the open-outcry board too. Off by default so envelope and snake
   * leagues subscribe to exactly what they did before: all postgres_changes
   * bindings on a channel are sent in one join, so a binding the server rejects
   * (a table that does not exist yet, or one the role cannot read) fails the
   * whole channel — and would take live updates down for the other two formats
   * along with it.
   */
  openBoard?: boolean
}) {
  const router = useRouter()

  useEffect(() => {
    const supabase = createClient()

    let timer: ReturnType<typeof setTimeout> | null = null
    // An event arrived while nobody was looking, so the page on screen is out of
    // date and owes one refresh the moment it is looked at again.
    let missedEvent = false
    let hiddenSince: number | null =
      document.visibilityState === 'hidden' ? Date.now() : null

    const run = () => {
      // Nobody asked for this render — it is somebody else's bid landing — so
      // it must not move the page under whoever is reading it. Next does not
      // scroll on a refresh (`ScrollBehavior.NoScroll`); what moves is the
      // content itself, when an auction card or a table row above the
      // viewport disappears. See lib/scrollAnchor.ts for why Safari needs
      // that compensated by hand and every other browser does not.
      withScrollAnchor(() => router.refresh())
    }

    const refresh = () => {
      // ⚠️ A hidden tab is not a reader, and a refresh it cannot see still
      // costs a full server render — two Vercel function invocations, the
      // proxy and the page, measured. A manager who leaves the board open in a
      // background tab was paying for every bid in the league, all day. Defer
      // instead: the tab owes exactly one refresh whenever it is looked at
      // again, however many events land in the meantime.
      if (document.visibilityState === 'hidden') {
        missedEvent = true
        return
      }
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        run()
      }, REFRESH_DEBOUNCE_MS)
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        hiddenSince = Date.now()
        // A refresh already queued is owed to a reader who has just left. Drop
        // the timer and remember the debt rather than rendering into the dark.
        if (timer) {
          clearTimeout(timer)
          timer = null
          missedEvent = true
        }
        return
      }

      const hiddenFor = hiddenSince === null ? 0 : Date.now() - hiddenSince
      hiddenSince = null
      if (missedEvent || hiddenFor > STALE_AFTER_HIDDEN_MS) {
        missedEvent = false
        // Straight to the render, not through the debounce: somebody is
        // looking at a stale page right now and half a second of coalescing
        // buys nothing here — there is only ever one of these.
        run()
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange)

    let channel = supabase
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
    // Open outcry board. INSERT is a nomination, UPDATE is a bid, a pass or a
    // close — open_pass() bumps updated_at precisely so that one subscription
    // here covers all of them, which is what makes the price move live on every
    // manager's screen. open_bids/open_passes are not watched directly: neither
    // carries a league_id, so they could not be filtered per league.
    if (openBoard) {
      channel = channel.on('postgres_changes', {
        event: '*', schema: 'public', table: 'open_auctions', filter: `league_id=eq.${leagueId}`,
      }, refresh)
    }

    channel.subscribe()

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (timer) clearTimeout(timer)
      supabase.removeChannel(channel)
    }
  }, [leagueId, openBoard, router])

  return null
}
