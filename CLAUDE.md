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
- `NEXT_PUBLIC_DEV_MODE=true` — currently read by nothing. The quick-login buttons it used to gate were removed from the login page.

⚠️ **There is no separate dev database.** `.env.local` points `NEXT_PUBLIC_SUPABASE_URL` at the *production* Supabase project, so `npm run dev` reads and writes live league data — including drafts in progress. Scope any test data to a throwaway league and delete it afterwards; never mutate a real league from a local session.

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

**Test users:** six `team1–6@test.local` users (password `test1234`) exist in the Supabase project. There is **no quick-login UI** — the login page offers only Google OAuth, plus an email/password form behind "הקמת ליגה (מנהלים)" that signs you out unless your email is in `league_creator_whitelist`. To get a session as a test user locally, add that email to `league_creator_whitelist`, sign in through that form, then remove the row (the session survives).

There is no seed script — `scripts/` is empty.


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

**Hiding a league (per-user):** Any league member (team owner/assistant, admin, or creator) can hide a league from their own `/leagues` list via `POST /api/leagues/hide` (`{ leagueId, hidden }`). Hides are stored per-user in the `league_hidden` table `(user_id, league_id)` and only affect that user — data is untouched and it's reversible. The `/leagues` page (`app/(app)/leagues/page.tsx`) splits entries into the main list and a collapsible "ליגות מוסתרות" section; `LeagueHideButton` toggles the state. This is distinct from **full deletion** (`POST /api/admin/delete-league`, "אזור מסוכן" in `AdminPanel`), which physically wipes the league for everyone and stays **creator-only**. Migration: `supabase/migration_league_hidden.sql` (`league_hidden` table, RLS: each user reads/writes only their own rows; `ON DELETE CASCADE` on `league_id` so a real deletion cleans up hide rows).

### Join flow

All join logic is in `app/api/join-league/route.ts` (uses admin client to bypass RLS):
1. User must already be authenticated (Google OAuth)
2. API finds league by name + join_code (case-insensitive)
3. If `user_id` already has a team in this league → returns success (no duplicate)
4. If team name already taken → error (stable identity with Google auth, no re-linking)
5. Check capacity: `teams.count < league.num_teams`
6. Create new team with `approved: true`

### Team assistant managers (עוזר מנהל)

A team can have **one optional assistant manager** (`teams.assistant_user_id`) who acts as the team on **draft actions only**:

- **Envelope** — place/view the team's sealed bids alongside the owner.
- **Snake** — pick players when the team is on the clock, exactly like the owner.
- **Never trades.** `/api/trades/{propose,respond,cancel}` and the `/trades` page deliberately resolve the team by `user_id` only, so the assistant cannot propose, accept, reject, or cancel a trade (and the page tells them they have no team). Keep it that way — trades are the least reversible action a team can take.

- **"My team" resolution must use `myTeamOr(user.id)` from `lib/team.ts`** (`user_id.eq.X,assistant_user_id.eq.X`) so the assistant is recognised — applied on the dashboard, auction, teams, and players pages. Always pair `.or(myTeamOr(...))` with `.limit(1).maybeSingle()` (a user could in rare cases match two rows). `BidForm` bids by the resolved `team.id`, so once resolution includes the assistant, bidding works under the extended `bids` RLS. `/api/snake-pick` authorizes non-admin picks with the same helper; the insert runs through the service-role client, so no snake RLS change was needed.
- **Invite flow:** owner generates a link from `AssistantManager` (mounted in the "my team" card of **both** the envelope and snake dashboards) → `POST /api/team/invite` creates a `team_invites` row (service-role-only table, 7-day expiry) → recipient opens `/assist/[token]` → `POST /api/team/accept-invite` sets `assistant_user_id` and lands them in the league. Remove via `POST /api/team/remove-assistant` — allowed for the owner, the league admin/creator, **or the assistant themselves stepping down** (`AssistantManager` with `role="assistant"` renders just that button).
- `/assist/[token]` must be reachable **logged out** — it's excluded from the redirect in `proxy.ts` (`isInvitePage`), and `AcceptInvite` signs in via Google with `?next=/assist/<token>`, which `app/auth/callback/route.ts` honors (same-origin relative paths only).
- **DB migration:** `supabase/migration_team_assistant.sql` — adds `assistant_user_id`, the `team_invites` table (RLS-locked), and extends the three `bids` policies to include the assistant.

### Nomination turn logic (envelope only)

`priority_rank` on teams determines nomination order, but **whose turn it is now is derived from the nominations actually made**, not from `priority_rank` alone. `priority_rank` only rotates when an auction *resolves* (`demote_nomination_rank()` inside `resolve_auction()`), so between nominating and the reveal — often days, when auctions are queued ahead — the team that already nominated would otherwise still read as "next".

**Always use `getEnvelopeNominationOrder(teams, openNominatorIds, playersPerTeam)` from `lib/utils.ts`** — never sort by `priority_rank` directly for the nomination turn:

```ts
// openNominatorIds = nominating_team_id of every auction with status active | pending
getEnvelopeNominationOrder(teams, openNominatorIds, league.players_per_team)
  // → { team, hasNominated, isNext }[]
```

**Only teams eligible to nominate are in the returned list.** Two things drop a team out entirely:

1. **Roster complete** — `is_complete`, or `priority_rank === null` which `remove_complete_team_from_priority()` sets on completion. Permanent.
2. **Cannot afford the $1 auto-bid** — `getMaxBid(budget_remaining, player_count, playersPerTeam) < 1`. Nominating forces a $1 bid via `trg_auto_bid_nominating_team`, so a team that cannot cover it must not be handed a turn. `getMaxBid` already reserves $1 per remaining slot, so this is exactly "has budget left to spend". Omitting `playersPerTeam` skips this check.

Beyond that:
- Sorts by `priority_rank` ASC. **The order itself never moves**: `isNext` is simply the first team that has not nominated yet, so nominating out of turn does not cost the skipped team its turn.
- A team with an open auction stays in the list, just dimmed and never `isNext`. **No badge** — "הבא" is the only tag; earlier "העלה" / "מכרז פתוח" labels read as permanent states and were removed. The skip lasts only while the auction is open; once it resolves the team rotates to the bottom of `priority_rank` and comes back around.
- Consumers: the dashboard "סדר העלאות" card (`app/(app)/page.tsx`) and the admin nominator dropdown, which also pre-selects `isNext`.

Because it is derived it self-heals: `cancel-auction` deletes the auction row, so the team becomes "next" again; and when an auction resolves, the DB rotation and the derived order converge in the same step.

Server-side, `/api/admin/queue-auction` rejects a `nominating_team_id` that is not in the league, not approved, already complete, or unable to afford the $1 auto-bid — so **an admin cannot nominate on behalf of a finished or broke team even by crafting the request**. `/api/nominate` (not currently mounted in any page) applies the same eligibility test when auto-picking the nominator.

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

**Key insight:** snake pick order is *computed* from `priority_rank` + `snake_round_config`; there is no stored pick slot. Traded picks are an **override layer** — table `pick_overrides (league_id, overall_pick_number → owner_team_id)` that wins over the computed default. `priority_rank` / `snake_round_config` are never mutated by trades. Resolution goes through `resolvePickOwner()` in `lib/utils.ts`. **Every place that maps a pick number to a team must use `resolvePickOwner` (override ?? computed), never `getSnakeTeamForPick` directly** — otherwise traded future picks display/route to the wrong team. Current consumers: `getCurrentSnakePicker`, the `/api/snake-pick` route, the dashboard (`app/(app)/page.tsx`), the players page, the full draft board (`app/(app)/draft-board/page.tsx`), and `SnakeDraftBoard`. `SnakeDraftBoard` keys picks by `overall_pick_number` (not `round-team`) because a team can hold two picks in one round after a trade.

**Roster size is preserved:** trades must be count-neutral — each side gives the same number of assets (picks + players), so every team still finishes with exactly `players_per_team`. Enforced in `lib/trades.ts` `validateTrade()`, which also checks picks are strictly future and currently owned (re-validated at admin approval time, since ownership may have changed).

**No overlap between proposals:** `validateTrade()` rejects any asset (pick or player) already committed to another **open** trade (`pending_target`/`pending_admin`), via an `excludeTradeId` param so a trade doesn't conflict with itself on re-validation. The `/trades` UI disables such assets ("בהצעה פתוחה"). Once a trade is approved, ownership moves (overrides + `players.drafted_by_team_id`), so the previous owner can no longer offer those assets.

- Tables: `trades` (lifecycle: `pending_target → pending_admin → approved | rejected | cancelled`), `trade_assets` (one row per pick/player, with `from_team_id`), `pick_overrides`.
- Execution is atomic via the `execute_trade(p_trade_id)` Postgres function. It runs in **two phases**: first move every traded player to its new team and clear `roster_slot`, then `assign_roster_slot()` each — so a player↔player swap (e.g. PG↔PG) lands each player in the correct slot instead of a fallback. Finally it recomputes both teams' `player_count`/`is_complete`.
- API routes: `POST /api/trades/{propose,respond,cancel}` (players), `POST /api/admin/trades/decide` (admin approve/reject → re-validates then calls `execute_trade`).
- UI: player **`/trades`** page (`components/TradeCenter.tsx`, snake-only Navbar link); admin **"טריידים"** tab in `AdminPanel`.
- `RealtimeRefresher` subscribes to `trades`, `pick_overrides`, and `snake_picks` (added to the realtime publication in the migration).

**DB migrations:**
- `supabase/migration_pick_trades.sql` — creates `pick_overrides`, `trades`, `trade_assets` (with RLS public-select), the `execute_trade()` function, and adds the new tables to `supabase_realtime`.
- `supabase/migration_pick_trades_fixes.sql` — `CREATE OR REPLACE` of `execute_trade()` with the two-phase roster-slot logic (run on a DB that already has the base migration).

### Full draft board (snake only)

`app/(app)/draft-board/page.tsx` — a single list of every pick slot (past + future) with team and player, linked prominently from the snake dashboard. Resolves ownership via `resolvePickOwner` so traded future picks show the new owner with a "נסחר" badge; exercised picks read `snake_picks.team` directly.

### Bid priority & tiebreak logic (envelope only)

**Two independent rank columns on `teams`** (envelope only):
- `priority_rank` — nomination turn order. After each auction, the nominating team is demoted to the bottom (regardless of outcome). Managed by `demote_nomination_rank()` Supabase function. In snake drafts, `priority_rank` is reused as pick order but is never mutated during the draft.
- `tiebreak_rank` — priority order for breaking equal bids. When multiple teams submit the same highest bid, the team with the lowest `tiebreak_rank` wins. That team is then demoted to the bottom of `tiebreak_rank`. Managed by `demote_tiebreak_rank()` Supabase function. Set via the lottery in the admin panel. Not used in snake drafts.

**These two orders are completely independent** — winning an auction never affects `priority_rank`, and nominating never affects `tiebreak_rank`. Audited end to end; the four places the two could leak into each other, and what each must look like:

| Where | Rule |
|---|---|
| `resolve_auction()` nomination rotation | `demote_nomination_rank(nominating_team)` — touches `priority_rank` only, every auction, win or lose |
| `resolve_auction()` tiebreak penalty | `demote_tiebreak_rank(winning_team)` — touches `tiebreak_rank` only, and only when the win came from a tie |
| Tie winner selection | `ORDER BY t.tiebreak_rank ASC NULLS LAST` — **never** `COALESCE(tiebreak_rank, priority_rank)`. The fallback let a team's nomination position decide a tie whenever its `tiebreak_rank` was unset. |
| `demote_priority()` (legacy alias) | Forwards to `demote_nomination_rank()`. It historically demoted `tiebreak_rank`, which is how the two got crossed in the first place. |

App-side there is no coupling: every `tiebreak_rank` read sorts or displays `tiebreak_rank` alone, and nomination turn goes exclusively through `getEnvelopeNominationOrder()`. The admin lottery writes each column in its own action.

**Auto-bid:** When any auction is created, a DB trigger (`trg_auto_bid_nominating_team`) automatically inserts a $1 bid for the nominating team. This means:
- If no other team bids, the nominating team wins at $1.
- If other teams also bid $1, the tiebreak order decides the winner.

**DB functions** (all `SECURITY DEFINER`, run in Supabase):
- `demote_nomination_rank(team_id, league_id)` — moves team to bottom of `priority_rank`
- `demote_tiebreak_rank(team_id, league_id)` — moves team to bottom of `tiebreak_rank`
- `resolve_auction(auction_id)` — determines winner, assigns player, runs both demotions as needed
- `auto_bid_nominating_team()` — trigger function that inserts the $1 auto-bid on auction insert

**Completed teams are invisible to auction resolution.** `resolve_auction()` computes the winning amount with `MAX(amount)` filtered by `t.is_complete = FALSE`, matching the filter used to pick the winner. Both filters must stay in sync: when they disagreed, a completed team's top bid produced a NULL winner and the player was still marked `drafted` with `drafted_by_team_id = NULL` — gone from the pool with no owner.

⚠️ **`migration_auction_priority_tiebreak.sql` and `migration_auto_bid_trigger.sql` (commit fd9018f) were never applied to the production database.** Until `migration_fix_nomination_rotation.sql` was run, the live `resolve_auction()` was the `migration_roster_slots.sql` version, which called `demote_priority()` for nomination rotation — and `demote_priority()` demotes `tiebreak_rank`. So `priority_rank` never rotated and every nomination silently demoted the nominator's tiebreak priority. Confirmed via `SELECT reason, count(*) FROM priority_log GROUP BY reason` returning only `tie_break_demotion`.

**Never assume a migration file in this directory has been run.** Check the live body before replacing any function:
```sql
SELECT prosrc FROM pg_proc WHERE proname = 'resolve_auction';
```

**DB migration:** `supabase/migration_fix_nomination_rotation.sql` — self-contained and idempotent. Creates `demote_nomination_rank()` / `demote_tiebreak_rank()`, repoints `demote_priority()` at the nomination rotation, replaces `resolve_auction()` (correct `MAX` filter, NULL-winner guard, `assign_roster_slot()` preserved, the two rank orders finally independent), and creates the `trg_auto_bid_nominating_team` trigger. Supersedes `migration_auction_priority_tiebreak.sql` and `migration_auto_bid_trigger.sql` — do not run those.

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

⚠️ `vercel --prod` uploads the **local working directory**, not a git ref. Merging a PR on GitHub therefore ships nothing, and deploying from a stale checkout silently reverts whatever the last deploy contained. Before deploying, run `git fetch && git status` and make sure local main is not behind `origin/main`.

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

Tailwind CSS v4 with CSS variables for theming (`var(--primary)`, `var(--muted)`, `var(--success)`, `var(--danger)`, `var(--warning)`, `var(--border)`, `var(--text)`). Custom utility classes: `card`, `badge`, `badge-green`, `badge-yellow`, `badge-gray`, `badge-red`, `badge-blue`, `input`, `btn`, `btn-primary`, `pulse-glow`.

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

**League creator** can optionally join as a player (choose at creation time or from admin overview "הצטרפות לדראפט" card). Creator's row in `admin_users` is protected — `set-team-admin` refuses to delete the row of any user who is `created_by` of a league, so creators always retain admin (and the ability to nominate). This matters because `admin_users` has one row per user (PK), and admin writes (e.g. the admin panel's direct `auctions` insert) are gated by RLS membership in `admin_users`. `create-league` upserts the creator's row on creation, so every creator has one.

### League creation

`app/(app)/create-league/page.tsx` — protected by `league_creator_whitelist`. Creates league via `POST /api/create-league`. Duplicate league names (case-insensitive) are rejected.

Creator selects draft type (**מעטפות** or **סנייק**). Budget and min_bid fields are hidden when snake is selected (not relevant). Creator can also choose to join as a player (provides team name) or remain a spectator-admin.

After creation the creator is upserted into `admin_users` with the new `league_id`.

### New components (snake draft)

- `components/SnakeDraftBoard.tsx` — rounds × teams grid showing pick assignments, current pick highlighted, round direction arrows (→/←)
- `components/SnakePlayerPicker.tsx` — searchable player table with "בחר" button per row; calls `POST /api/snake-pick`
