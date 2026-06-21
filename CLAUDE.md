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

Fantasy NBA draft app supporting two draft types:
- **מעטפות (Envelope)** — players nominate players for blind auction; teams submit sealed bids revealed on a timer.
- **סנייק (Snake)** — teams pick players in turn order with snake reversal between rounds; no budget or bidding.

### Data flow

All pages under `app/(app)/` are React Server Components that fetch directly from Supabase using `lib/supabase/server.ts`. There is no Redux or React Query — server components call Supabase and pass data down as props.

Client-side interactivity is handled by small `'use client'` leaf components (`BidForm`, `NominateButton`, `Countdown`, `RealtimeRefresher`). Real-time updates use Supabase Realtime → `router.refresh()` via `RealtimeRefresher`.

Mutations go through API routes in `app/api/`. These routes use `createAdminClient()` (service role key, bypasses RLS) for writes and `createClient()` (anon key, cookie-based auth) for identity checks.

### Key types (`types/index.ts`)

- **League** — single league with status (`setup | lottery | active | paused | completed`), budget, `players_per_team`, `nomination_interval_hours`, `reveal_before_minutes`, `created_by` (UUID of creator), `roster_slots` (JSONB, optional — see Roster slots below), `draft_type` (`'envelope' | 'snake'`), `pick_timeout_minutes` (nullable), `snake_round_config` (boolean[] | null — per-round reversal; null = standard snake)
- **Team** — user's team, tracks `budget_remaining`, `player_count`, `priority_rank` (nomination/pick order), `tiebreak_rank` (tiebreak priority order for envelope only), `is_complete`, `approved`
- **Player** — status: `available | on_auction | drafted`; `roster_slot` (TEXT, optional — assigned after draft)
- **Auction** — status: `pending | active | revealed | completed`; has `reveal_time` computed at nomination time (envelope only)
- **Bid** — sealed bid per team per auction; revealed when `reveal_time` passes (envelope only)
- **SnakePick** — one pick in a snake draft: `overall_pick_number`, `round`, `pick_in_round`, `picked_at`, `team_id`, `player_id`, `league_id`

### Auth model

- All users (players + admins) authenticate via **Google OAuth** (`supabase.auth.signInWithOAuth({ provider: 'google' })`).
- OAuth callback is handled at `app/auth/callback/route.ts` — exchanges code for session, then redirects to `/leagues`.
- League creators/admins must have their Google email in the `league_creator_whitelist` table.
- Admin status is determined by: row in `admin_users` table OR `leagues.created_by = user.id`.
- The layout (`app/(app)/layout.tsx`) checks both and passes `isAdmin` and `isSnake` to `<Navbar>`. The Navbar hides the "מכרז" link for snake leagues.
- **Logout** lives only on the `/leagues` page (`<LogoutButton>`, bottom "account actions" block) — it is NOT in the Navbar, to keep the mobile bottom bar from overflowing (a snake admin already has up to 7 items). Applies to both draft types.

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

### Nomination turn logic (envelope only)

`priority_rank` on teams determines nomination order. The team with the lowest `priority_rank` among approved, non-complete teams is the current nominator. This is computed in `app/(app)/players/page.tsx`:

```ts
const currentNominatorId = allTeams?.[0]?.id ?? null  // sorted by priority_rank ASC
const isMyTurn = typedMyTeam?.id === currentNominatorId && !typedMyTeam.is_complete
const canNominate = isMyTurn && league.status === 'active' && !activeAuction
```

The API route `/api/nominate` re-validates this server-side before creating an auction.

### Snake draft pick logic

`priority_rank` on teams determines the initial pick order (set via Admin → Lottery). The pick sequence is computed in `lib/utils.ts`:

```ts
// Which team picks at overall pick N?
getSnakeTeamForPick(overallPickNumber, numTeams, teams, snakeRoundConfig)
// Who is currently on the clock?
getCurrentSnakePicker(completedPicksCount, numTeams, teams, snakeRoundConfig)
// Is this round reversed?
isSnakeRoundReversed(round, config)  // null config = even rounds reversed
```

The API route `POST /api/snake-pick` validates it is the team's turn, inserts into `snake_picks`, updates `players.status = 'drafted'`, increments `teams.player_count`, calls `assign_roster_slot()`, and auto-completes the league when all teams are full.

`snake_round_config` is a `boolean[]` stored as JSONB on `leagues`. Index `i` = whether round `i+1` is reversed. `null` = standard snake (even rounds automatically reversed).

**Admin can pick on behalf of any team** by passing `team_id` in the request body — validated server-side that the team is actually on the clock.

**DB migration:** `supabase/migration_snake_draft.sql` — adds `draft_type`, `pick_timeout_minutes`, `snake_round_config` to `leagues`; creates `snake_picks` table with RLS.

### Trade system (snake only)

Teams can trade **future draft picks** and **already-drafted players** in packages. Flow: a team proposes → the target team accepts/rejects → the **league admin approves** before it executes. Works both before and during the draft.

**Key insight:** snake pick order is *computed* from `priority_rank` + `snake_round_config`; there is no stored pick slot. Traded picks are an **override layer** — table `pick_overrides (league_id, overall_pick_number → owner_team_id)` that wins over the computed default. `priority_rank` / `snake_round_config` are never mutated by trades. Resolution goes through `resolvePickOwner()` in `lib/utils.ts` (used by `getCurrentSnakePicker`, the `/api/snake-pick` route, both pages, and `SnakeDraftBoard`). `SnakeDraftBoard` keys picks by `overall_pick_number` (not `round-team`) because a team can hold two picks in one round after a trade.

**Roster size is preserved:** trades must be count-neutral — each side gives the same number of assets (picks + players), so every team still finishes with exactly `players_per_team`. Enforced in `lib/trades.ts` `validateTrade()`, which also checks picks are strictly future and currently owned (re-validated at admin approval time, since ownership may have changed).

- Tables: `trades` (lifecycle: `pending_target → pending_admin → approved | rejected | cancelled`), `trade_assets` (one row per pick/player, with `from_team_id`), `pick_overrides`.
- Execution is atomic via the `execute_trade(p_trade_id)` Postgres function (applies overrides + player transfers via `assign_roster_slot`, recomputes both teams' `player_count`/`is_complete`).
- API routes: `POST /api/trades/{propose,respond,cancel}` (players), `POST /api/admin/trades/decide` (admin approve/reject → calls `execute_trade`).
- UI: player **`/trades`** page (`components/TradeCenter.tsx`, snake-only Navbar link); admin **"טריידים"** tab in `AdminPanel`.
- `RealtimeRefresher` subscribes to `trades`, `pick_overrides`, and `snake_picks` (added to the realtime publication in the migration).

**DB migration:** `supabase/migration_pick_trades.sql` — creates `pick_overrides`, `trades`, `trade_assets` (with RLS public-select), the `execute_trade()` function, and adds the new tables to `supabase_realtime`.

### Bid priority & tiebreak logic (envelope only)

**Two independent rank columns on `teams`** (envelope only):
- `priority_rank` — nomination turn order. After each auction, the nominating team is demoted to the bottom (regardless of outcome). Managed by `demote_nomination_rank()` Supabase function. In snake drafts, `priority_rank` is reused as pick order but is never mutated during the draft.
- `tiebreak_rank` — priority order for breaking equal bids. When multiple teams submit the same highest bid, the team with the lowest `tiebreak_rank` wins. That team is then demoted to the bottom of `tiebreak_rank`. Managed by `demote_tiebreak_rank()` Supabase function. Set via the lottery in the admin panel. Not used in snake drafts.

**These two orders are completely independent** — winning an auction never affects `priority_rank`, and nominating never affects `tiebreak_rank`.

**Auto-bid:** When any auction is created, a DB trigger (`trg_auto_bid_nominating_team`) automatically inserts a $1 bid for the nominating team. This means:
- If no other team bids, the nominating team wins at $1.
- If other teams also bid $1, the tiebreak order decides the winner.

**DB functions** (all `SECURITY DEFINER`, run in Supabase):
- `demote_nomination_rank(team_id, league_id)` — moves team to bottom of `priority_rank`
- `demote_tiebreak_rank(team_id, league_id)` — moves team to bottom of `tiebreak_rank`
- `resolve_auction(auction_id)` — determines winner, assigns player, runs both demotions as needed
- `auto_bid_nominating_team()` — trigger function that inserts the $1 auto-bid on auction insert

### Roster slots

Leagues can optionally define a roster slot configuration via `roster_slots` JSONB on the `leagues` table (e.g. `{"PG":1,"SG":1,"G":1,"SF":1,"PF":1,"F":1,"C":2,"UTIL":3,"BENCH":2}`).

- Configured in **Admin Panel → League Settings** ("עמדות הרכב קבוצה" section). Displays a total counter that turns red if sum ≠ `players_per_team`. Works for both envelope and snake leagues.
- After each pick (auction resolve or snake pick), `assign_roster_slot(player_id, team_id, league_id)` (Supabase function) assigns the best available slot: specific position (PG/SG/…) → combo (G/F) → UTIL → BENCH.
- Team pages display players sorted by slot order; each player shows a blue badge with their slot. If the player's actual position differs from the slot, it appears in grey parentheses.
- Migration: `supabase/migration_roster_slots.sql` — adds `roster_slots` to `leagues`, `roster_slot` to `players`, creates `assign_roster_slot()`, and updates `resolve_auction()` to call it.

### Admin auction tab (envelope only)

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

### Dashboard metrics

The dashboard (`app/(app)/page.tsx`) branches on `draft_type`:

**Envelope** — renders three sections below the main cards:
1. **סדר העלאות** — nomination order, sorted by `priority_rank` ASC, excludes completed teams.
2. **סדר פריוריטי** — tiebreak order, sorted by `tiebreak_rank` ASC, includes all teams.
3. **פראייר הדראפט** — overpayment metric. For every completed auction, computes `winning_bid − second_highest_bid` (where second highest = max bid from non-winning teams; 0 if no other team bid). Sums these per team and displays all teams sorted descending. Computed in the server component from `auctions` (status=completed) + `bids` tables — no DB function needed. RLS allows all bids to be read once an auction is completed.

**Snake** — shows:
- Countdown to `draft_start_time` before the draft begins
- "על הדק" card showing current team, overall pick number, and time since last pick once active
- My team's drafted players
- Last 5 picks

### Styling

Tailwind CSS v4 with CSS variables for theming (`var(--primary)`, `var(--muted)`, `var(--success)`, `var(--danger)`, `var(--warning)`, `var(--border)`, `var(--text)`). Custom utility classes: `card`, `badge`, `badge-green`, `badge-yellow`, `badge-gray`, `badge-red`, `badge-blue`, `input`, `btn`, `btn-primary`, `pulse-glow`, `no-scrollbar`.

`no-scrollbar` hides the scrollbar cross-browser (`::-webkit-scrollbar` for Chrome/Safari + `scrollbar-width`/`-ms-overflow-style` for Firefox/Edge). Used on the `AdminPanel` horizontal tab bar, which scrolls (`overflow-x-auto`) when its 7 snake-mode tabs don't fit on mobile. Prefer this class over an inline `scrollbarWidth` style — inline only works in Firefox.

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

**Admin panel tabs:**
- Envelope: overview, auction, players, teams, lottery, league settings
- Snake: overview, draft, players, teams, lottery, league settings

The "draft" tab (snake only) shows current pick status, admin pick-on-behalf form (team + player dropdowns), pick order editing, and picks history. The lottery tab for snake shows only draft order (no tiebreak). League settings for snake include `pick_timeout_minutes` and per-round direction toggles (`snake_round_config`).

**League creator** can optionally join as a player (choose at creation time or from admin overview "הצטרפות לדראפט" card). Creator's row in `admin_users` is protected — cannot be revoked via UI or API.

### League creation

`app/(app)/create-league/page.tsx` — protected by `league_creator_whitelist`. Creates league via `POST /api/create-league`. Duplicate league names (case-insensitive) are rejected.

Creator selects draft type (**מעטפות** or **סנייק**). Budget and min_bid fields are hidden when snake is selected (not relevant). Creator can also choose to join as a player (provides team name) or remain a spectator-admin.

After creation the creator is upserted into `admin_users` with the new `league_id`.

### New components (snake draft)

- `components/SnakeDraftBoard.tsx` — rounds × teams grid showing pick assignments, current pick highlighted, round direction arrows (→/←)
- `components/SnakePlayerPicker.tsx` — searchable player table with "בחר" button per row; calls `POST /api/snake-pick`
