# DuoSync

A mobile-first PWA for two partners to share chores and habits, with points, split effort, challenges and a rewards shop.
Next.js (App Router) + Tailwind on Vercel, Supabase for Postgres, Auth and Realtime.

## Setup

1. **Supabase project.** Create one, then apply the schema: paste each file in `supabase/migrations/` into the SQL editor,
   **in order** (`0001_init.sql` … `0008_manage_library.sql`), or use `supabase link` + `supabase db push`.
   After the first setup, new migration files are applied for you (see below).
2. **Auth.** Email + password. If "Confirm email" is on, add `https://YOUR-DOMAIN/auth/callback` (and
   `http://localhost:3000/auth/callback`) under Authentication → URL Configuration.
3. **Env vars.** Copy `.env.example` to `.env.local` and fill in the project URL and publishable key. On Vercel add the same
   two variables under Project Settings → Environment Variables (they are inlined at build time).
4. `npm install && npm run dev`

The first partner signs up and chooses **Start one** (this seeds the six base chores and a few rewards and makes them the
admin). The second signs up and chooses **Join partner** with the invite code from the profile menu.

## Database migrations run automatically

`.github/workflows/database.yml` applies new files in `supabase/migrations/` to production whenever they land on `main`
(after running `npm run test:db`), so nobody pastes SQL by hand. Add three repository secrets under GitHub → Settings →
Secrets and variables → Actions: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_ID`. Until they exist the
workflow only warns and changes nothing.

If migrations were already applied by hand, run the workflow once from the Actions tab with **baseline** set to those
versions (e.g. `0001 0002 0003`) so they are recorded as done instead of being applied twice. New migrations must be numbered
in order (`0004_…`) and should be additive; a migration runs against live data as soon as it reaches `main`.

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
- **Points are time-based** (migration 0006). Base points = `round(minutes / 5)` (12 an hour, minimum 5 minutes), plus a flat
  **chore tax** (0-50) for unpleasant jobs. Each chore has an estimated time and tax; the points you actually earn come from
  the time you log at completion. The split gives the caller `round(total * share)` and their partner the remainder, so the two
  shares always add up exactly. The formula lives in `lib/logic/points.ts` and `public.chore_points()`; keep the two in step.
  The old per-chore "points" columns (`points_assigned`, `default_points`) are legacy and no longer read.
- **Unassigned pool:** a chore with no assignee shows as an open task. Tap it to claim it, adjust its estimate/tax, or complete
  it straight away (completing claims it for you at 100% by default).
- **Points go to the chore's assignee** (migration 0007), whoever taps Complete, and completing never changes the assignee. An
  unassigned chore is claimed by whoever completes it. In a split, the first share belongs to the assignee.
- **Manage chores** (`/manage`, migration 0008) is the library as a small CMS: create, edit and delete the chores you can
  schedule, with search, category filter and usage counts. Editing pushes only the fields you changed to what is already
  planned: a new **name** reaches every copy (finished ones too) and every repeating chore; a new **time or tax** reaches
  unfinished copies and repeating chores (so later days follow); **category** stays in the library. Finished chores never have
  their points or logged time rewritten. **Delete** archives the chore and stops it repeating; you choose whether its
  unfinished calendar copies go too (finished chores and earned points are always kept). Deleting moved out of the Add chore
  sheet, which now links here. The "Common" row still matches by the six original names, so renaming one drops it from Common
  (it stays under Recent and All tasks).
- **"Profile switcher"** is a profile menu (members, invite code, sign out): each partner signs in on their own device, so
  there is nothing to switch between.
- **Common tasks** are matched by title against the six base chores; **Recent** is the five most recently scheduled.
- **Recurring chores** are created from **Edit chore** (every day / week / 2 weeks / month), not from the Add Chore sheet.
  A repeating chore is a series: occurrences are created lazily as you browse forward (`extend_recurring_chores`), so it
  runs indefinitely. Editing, completing, moving or removing one day never touches the others; "This and future" applies a
  change to every later unfinished day. A day you removed stays removed. Repeats that start in the past are not back-filled.
