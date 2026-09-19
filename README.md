# DuoSync

A mobile-first PWA for two partners to share chores and habits, with points, split effort, challenges and a rewards shop.
Next.js (App Router) + Tailwind on Vercel, Supabase for Postgres, Auth and Realtime.

## Setup

1. **Supabase project.** Create one, then apply the schema: paste `supabase/migrations/0001_init.sql` into the SQL editor
   (or `supabase link` + `supabase db push`).
2. **Auth.** Email + password. If "Confirm email" is on, add `https://YOUR-DOMAIN/auth/callback` (and
   `http://localhost:3000/auth/callback`) under Authentication → URL Configuration.
3. **Env vars.** Copy `.env.example` to `.env.local` and fill in the project URL and publishable key. On Vercel add the same
   two variables under Project Settings → Environment Variables (they are inlined at build time).
4. `npm install && npm run dev`

The first partner signs up and chooses **Start one** (this seeds the six base chores and a few rewards and makes them the
admin). The second signs up and chooses **Join partner** with the invite code from the profile menu.

## Scripts

| | |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | unit tests for the pure logic (split maths, dates, stats, library groupings, bell badge) |
| `npm run test:db` | runs the real migration in PGlite (WASM Postgres) and tests RLS, column grants and every RPC |

## How it fits together

- **Server is the source of truth for anything with value.** Points, completion state, challenge progress and redemptions
  change only through `SECURITY DEFINER` functions (`complete_chore`, `redeem_reward`, `increment_challenge`, …), which are
  atomic and validate the caller. RLS scopes every table to the household, and column-level grants stop the client writing
  `points` or `is_completed` directly.
- **One client store** (`lib/store/household-store.tsx`) loads the household, subscribes to Supabase Realtime and exposes
  optimistic actions. Failed mutations roll back by re-reading server state.
- **Pure logic** lives in `lib/logic/*` (no React, no Supabase) so it is unit-tested directly.
- Dates are local `YYYY-MM-DD` strings end to end; never round-tripped through UTC.

## Deviations from the spec (and why)

- **Schema additions:** a `households` table with an invite code (partners need some way to end up in one household), FKs
  on `household_id`, `challenges.completed_at` (Stats needs to date payouts), `challenge_declined` / `challenge_completed`
  notification types, and a 1–10 check on `chore_instances.points_assigned`.
- **Rounding:** each partner's minutes and points use `round(total × share)` independently, as specified. For odd totals the
  two shares can sum to more than the total (5 pts at 50/50 pays 3 + 3). Change `share()` in `lib/logic/split.ts` and the SQL
  in `complete_chore` together if you would rather conserve the total.
- **Points go to whoever taps Complete** (or are split between the two), not to the chore's assignee.
- **"Profile switcher"** is a profile menu (members, invite code, sign out): each partner signs in on their own device, so
  there is nothing to switch between.
- **Common tasks** are matched by title against the six base chores; **Recent** is the five most recently scheduled.
- **Not built:** UI for creating recurring chores. The columns exist and editing/deleting only ever touches one day, but the
  roadmap has no recurrence-generation step, so nothing creates them yet.
