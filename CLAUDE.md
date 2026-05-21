# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

```bash
npm run dev      # start dev server (localhost:3000)
npm run build    # production build
npm run lint     # ESLint
```

No test suite is configured.

## Environment Variables

Required in `.env.local` and in Vercel dashboard:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` — used by `createAdminClient()` for all admin API routes

## Architecture

Fantasy NBA auction-draft app. Users join a league, take turns nominating players for blind auction, and submit sealed bids revealed on a timer.

### Data flow

All pages under `app/(app)/` are React Server Components that fetch directly from Supabase using `lib/supabase/server.ts`. There is no Redux or React Query — server components call Supabase and pass data down as props.

Client-side interactivity is handled by small `'use client'` leaf components (`BidForm`, `NominateButton`, `Countdown`, `RealtimeRefresher`). Real-time updates use Supabase Realtime → `router.refresh()` via `RealtimeRefresher`.

Mutations go through API routes in `app/api/`. These routes use `createAdminClient()` (service role key, bypasses RLS) for writes and `createClient()` (anon key, cookie-based auth) for identity checks.

### Key types (`types/index.ts`)

- **League** — single league with status (`setup | lottery | active | paused | completed`), budget, `players_per_team`, `nomination_interval_hours`, `reveal_before_minutes`
- **Team** — user's team, tracks `budget_remaining`, `player_count`, `priority_rank` (nomination queue order), `is_complete`
- **Player** — status: `available | on_auction | drafted`
- **Auction** — status: `pending | active | revealed | completed`; has `reveal_time` computed at nomination time
- **Bid** — sealed bid per team per auction; revealed when `reveal_time` passes

### Nomination turn logic

`priority_rank` on teams determines nomination order. The team with the lowest `priority_rank` among approved, non-complete teams is the current nominator. This is computed in `app/(app)/players/page.tsx`:

```ts
const currentNominatorId = allTeams?.[0]?.id ?? null  // sorted by priority_rank ASC
const isMyTurn = typedMyTeam?.id === currentNominatorId && !typedMyTeam.is_complete
const canNominate = isMyTurn && league.status === 'active' && !activeAuction
```

The API route `/api/nominate` re-validates this server-side before creating an auction.

### Supabase clients

- `lib/supabase/server.ts` → `createClient()` for SSR (cookie auth), `createAdminClient()` for API routes (service role, bypasses RLS)
- `lib/supabase/client.ts` → browser client for Realtime subscriptions only

### Styling

Tailwind CSS v4 with CSS variables for theming (`var(--primary)`, `var(--muted)`, `var(--success)`, `var(--danger)`, `var(--warning)`, `var(--border)`, `var(--text)`). Custom utility classes: `card`, `badge`, `badge-green`, `badge-yellow`, `badge-gray`, `input`, `btn`, `btn-primary`, `pulse-glow`.

### Admin

Admin users are stored in `admin_users` table. Admin API routes live under `app/api/admin/` and include cancel-auction, export-teams, and add-admin. The admin UI is at `app/(app)/admin/`.
