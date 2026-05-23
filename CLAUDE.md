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

Dev only (`.env.local` only, never in production):
- `NEXT_PUBLIC_DEV_MODE=true` — shows quick-login buttons on login page (Team 1–6)

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

- All users (players + admins) authenticate via **Google OAuth** (`supabase.auth.signInWithOAuth({ provider: 'google' })`).
- OAuth callback is handled at `app/auth/callback/route.ts` — exchanges code for session, then redirects to `/leagues`.
- League creators/admins must have their Google email in the `league_creator_whitelist` table.
- Admin status is determined by: row in `admin_users` table OR `leagues.created_by = user.id`.
- The layout (`app/(app)/layout.tsx`) checks both and passes `isAdmin` to `<Navbar>`.

**Dev mode:** when `NEXT_PUBLIC_DEV_MODE=true`, the login page also shows email/password buttons for test users (team1–6@test.local, password: `test1234`). Run `scripts/seed-test-league.mjs` once to create them.

```bash
node --env-file=.env.local scripts/seed-test-league.mjs
```

The dev reset API (`POST /api/dev/reset-test-league`) wipes auctions/teams and re-creates the 6 test teams. Only works in `NODE_ENV=development`.

### Multi-league support & league selection

A user can belong to multiple leagues. The active league is stored in a `selected_league_id` **httpOnly cookie** (set via `POST /api/select-league`).

**Entry flow:**
1. User logs in with Google → redirected to `/leagues`
2. `/leagues` shows all leagues the user is in (team member, admin, or creator) + a join form
3. User clicks "כנס לליגה" → sets cookie → redirected to `/` (dashboard)
4. Navbar has "הליגות שלי" link → always accessible to switch leagues

**League resolution in every page:**
```ts
const cookieStore = await cookies()
const selectedLeagueId = cookieStore.get('selected_league_id')?.value

// Cookie takes priority; falls back to most-recent team → admin → creator
const leagueId = selectedLeagueId ?? myTeam?.league_id ?? adminRow?.league_id ?? createdLeague?.id ?? null
```

The home page (`/`) redirects to `/leagues` if no cookie is set.

### Join flow

All join logic is in `app/api/join-league/route.ts` (uses admin client to bypass RLS):
1. User must already be authenticated (Google OAuth)
2. API finds league by name + join_code (case-insensitive)
3. If `user_id` already has a team in this league → returns success (no duplicate)
4. If team name already taken → error (stable identity with Google auth, no re-linking)
5. Check capacity: `teams.count < league.num_teams`
6. Create new team with `approved: true`

### Nomination turn logic

`priority_rank` on teams determines nomination order. The team with the lowest `priority_rank` among approved, non-complete teams is the current nominator. This is computed in `app/(app)/players/page.tsx`:

```ts
const currentNominatorId = allTeams?.[0]?.id ?? null  // sorted by priority_rank ASC
const isMyTurn = typedMyTeam?.id === currentNominatorId && !typedMyTeam.is_complete
const canNominate = isMyTurn && league.status === 'active' && !activeAuction
```

The API route `/api/nominate` re-validates this server-side before creating an auction.

### Admin auction tab

Sections appear in this order: **active auction → auction queue → add to queue → history**.

When adding to the queue, the admin sets the start time manually. Validation: start time must not be before the latest `reveal_time` of existing auctions (active or pending). The helper text shows the earliest allowed time.

### Middleware (`proxy.ts`)

In Next.js 16, the middleware file is **`proxy.ts`** (root of the project), not `middleware.ts`. It exports a `proxy` function and a `config` with a `matcher`.

The middleware refreshes the Supabase session and redirects unauthenticated users to `/login`. The matcher **excludes** static assets so they remain publicly accessible:

```ts
matcher: ['/((?!_next/static|_next/image|favicon.ico|manifest\\.webmanifest|apple-touch-icon\\.png|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)']
```

**Important:** Any new public routes (PWA assets, open API endpoints, etc.) must be added to this matcher exclusion list, otherwise they will be blocked with a 307 redirect to `/login`.

### PWA / App icons

- `app/manifest.ts` — generates `/manifest.webmanifest` (Next.js metadata route, excluded from auth middleware)
- `public/icons/icon-192.png` — 192×192 PWA icon
- `public/icons/icon-512.png` — 512×512 PWA icon
- `public/icons/apple-touch-icon.png` — 180×180 iOS home screen icon
- `public/apple-touch-icon.png` — iOS fallback at root
- `public/favicon.ico` — browser tab favicon
- `public/logo.png` — full-size logo (used in Navbar)

Icons were generated with `sharp` from `public/logo.png`. To regenerate:
```bash
node -e "const sharp = require('sharp'); const src = './public/logo.png'; Promise.all([sharp(src).resize(192,192).png().toFile('./public/icons/icon-192.png'), sharp(src).resize(512,512).png().toFile('./public/icons/icon-512.png'), sharp(src).resize(180,180).png().toFile('./public/icons/apple-touch-icon.png'), sharp(src).resize(180,180).png().toFile('./public/apple-touch-icon.png'), sharp(src).resize(32,32).png().toFile('./public/favicon.ico')]).then(()=>console.log('Done'))"
```

**Vercel deploy:** GitHub auto-deploy is NOT connected. Run `npx vercel --prod` to deploy manually.

### Supabase clients

- `lib/supabase/server.ts` → `createClient()` for SSR (cookie auth), `createAdminClient()` for API routes (service role, bypasses RLS)
- `lib/supabase/client.ts` → browser client for Realtime subscriptions only

### Styling

Tailwind CSS v4 with CSS variables for theming (`var(--primary)`, `var(--muted)`, `var(--success)`, `var(--danger)`, `var(--warning)`, `var(--border)`, `var(--text)`). Custom utility classes: `card`, `badge`, `badge-green`, `badge-yellow`, `badge-gray`, `input`, `btn`, `btn-primary`, `pulse-glow`.

**RTL note:** The app is Hebrew/RTL. For icon positioning inside inputs (e.g. eye button), use inline `style={{ position: 'absolute', left: '10px' }}` — do NOT use Tailwind `left-*` utilities as they may be reinterpreted in RTL context.

### Admin

Admin users are stored in `admin_users` table (`user_id PK`, `league_id`, `role: 'admin' | 'superadmin'`). Each user can be admin of at most one league.

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
