# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

```bash
npm run dev      # start dev server (localhost:3000)
npm run build    # production build
npm run lint     # ESLint
```

No test suite is configured. Always run `npm run build` before committing to catch TypeScript errors.

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

- **League** — single league with status (`setup | lottery | active | paused | completed`), budget, `players_per_team`, `nomination_interval_hours`, `reveal_before_minutes`, `created_by` (UUID of creator)
- **Team** — user's team, tracks `budget_remaining`, `player_count`, `priority_rank` (nomination queue order), `is_complete`, `approved`
- **Player** — status: `available | on_auction | drafted`
- **Auction** — status: `pending | active | revealed | completed`; has `reveal_time` computed at nomination time
- **Bid** — sealed bid per team per auction; revealed when `reveal_time` passes

### Auth model

- Regular users join via **anonymous auth** (`supabase.auth.signInAnonymously()`). No email/password required.
- League creators/admins use **email/password auth** and must be in the `league_creator_whitelist` table.
- Admin status is determined by: row in `admin_users` table OR `leagues.created_by = user.id`.
- The layout (`app/(app)/layout.tsx`) checks both and passes `isAdmin` to `<Navbar>`.

### League isolation

Every page scopes data to the **user's own league only**. The resolution order is:
1. Team's `league_id` (user has a team → use that league)
2. `admin_users.league_id` (user is admin → use their managed league)
3. `leagues.created_by = user.id` (user created a league → use that)
4. `null` → show empty state

**Never fall back to "latest league"** — this would expose data from unrelated leagues to random users.

### Join flow

All join logic is in `app/api/join-league/route.ts` (uses admin client to bypass RLS):
1. Anonymous session created client-side first
2. API finds league by name + join_code (case-insensitive)
3. If team name already exists in league → re-link that team to the current user (handles returning users with new anon session)
4. Check capacity: `teams.count < league.num_teams`
5. Create new team with `approved: true`

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

**RTL note:** The app is Hebrew/RTL. For icon positioning inside inputs (e.g. eye button), use inline `style={{ position: 'absolute', left: '10px' }}` — do NOT use Tailwind `left-*` utilities as they may be reinterpreted in RTL context.

### Admin

Admin users are stored in `admin_users` table (`user_id PK`, `league_id`, `role: 'admin' | 'superadmin'`).

Admin API routes under `app/api/admin/`:
- `cancel-auction` — cancel an active auction
- `export-teams` — CSV export of teams and players
- `add-admin` — add admin by email
- `delete-team` — delete a team and reset its players
- `set-team-admin` — grant/revoke admin for a team's user (cannot self-revoke)

The admin UI is at `app/(app)/admin/` (page + AdminPanel client component).

**Admin panel tabs:** overview, teams, auction, players, lottery, league settings.

**League creator** can optionally join as a player (choose at creation time or from admin overview "הצטרפות לדראפט" card). Creator's row in `admin_users` is protected — cannot be revoked via UI or API.

### League creation

`app/(app)/create-league/page.tsx` — protected by `league_creator_whitelist`. Creates league via `POST /api/create-league`. Duplicate league names (case-insensitive) are rejected.

Creator can choose to join as a player (provides team name) or remain a spectator-admin.

After creation the creator is upserted into `admin_users` with the new `league_id`.
