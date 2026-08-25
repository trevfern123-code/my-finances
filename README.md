# My Finances

Express backend + React PWA frontend with Plaid Link integration and Supabase Auth/storage.

Architecture: the frontend never sees Plaid secrets, Plaid access tokens, or the Supabase service-role key. It only talks to the Express API using the signed-in user's Supabase JWT; Express is the only thing that talks to Plaid and to Supabase with the service-role key.

## Setup

### Backend

```bash
cd backend
cp .env.example .env   # fill in Supabase + Plaid credentials
npm install
npm run dev
```

### Frontend

```bash
cd frontend
cp .env.example .env   # fill in Supabase URL/anon key + backend API URL
npm install
npm run dev
```

## Database migrations

Schema changes are tracked via the Supabase CLI (`npx supabase`, no global install needed) in
`supabase/`, rather than as one-off SQL handed over ad hoc. `supabase/SCHEMA_NOTES.md` documents
the schema as reconstructed from application code — read that first if `supabase/migrations/`
doesn't exist yet or looks incomplete, since linking this repo to the live project (`supabase
login` + `supabase link` + `supabase db pull`, all interactive/one-time) hasn't necessarily
happened yet. Once linked, new schema changes go through `supabase migration new <name>`, get
reviewed, and get applied with `supabase db push` (or still by hand in the SQL editor for a
one-off change) — either way, the SQL lives in the repo afterward instead of only in chat history.

## CI

`.github/workflows/ci.yml` runs on every push/PR to `main`: backend typecheck, backend tests,
backend build, frontend typecheck, frontend tests, frontend build. No secrets are required —
every backend test mocks its Supabase/Plaid config imports, so the suite passes with zero
environment variables set (verified: `env -i npx vitest run` passes clean). This doesn't deploy
anything itself — Railway and Vercel still deploy independently on push — it just catches a
broken build/test before that happens.

## Financial precision

Money is `numeric` in Postgres and a plain JS `number` everywhere in application code — no
decimal library. `backend/src/services/money.ts` and `frontend/src/lib/money.ts` each export a
`roundToCents()` used at every point that *writes a computed* (summed/subtracted) monetary value,
as opposed to relaying one Plaid already gave us: the manual-loan running balance
(`adjustManualLoanBalance`), net worth snapshots, and transaction-split validation (which compares
the rounded sum of split amounts to the rounded transaction amount for exact equality, rather than
the ad hoc 1-cent tolerance it used before). The frontend's `SplitEditor` uses the same rounding
(via `frontend/src/lib/splitValidation.ts`) so it never tells a user a split is "balanced" when
the backend would actually reject it. Values that are only ever *displayed*, not written back
(monthly breakdown totals, budget spend aggregates, etc.), aren't rounded at the source — they're
recomputed fresh from Plaid-sourced numbers on every request, so there's no compounding-drift risk
there, only display formatting (already handled by `Intl.NumberFormat`).

**Currency**: USD-only, deliberately, for now. `iso_currency_code` is still stored per
account/transaction (preserved for future multi-currency support) but every aggregation (net
worth, budget spend, monthly breakdown, Safe to Spend) sums raw amounts across every linked
account with no currency conversion or same-currency check — fine as long as every account really
is USD, which Plaid's country-code config (`PLAID_COUNTRY_CODES=US`) makes the only realistic case
today.

## Testing

```bash
cd backend
npm test
```

Backend unit tests (Vitest), with Supabase and Plaid mocked — no real network calls or test database, so they run fast and don't touch production data. Coverage focuses on the logic that's actually broken this project in practice, rather than everything indiscriminately:

- **`middleware/auth.test.ts`** — regression test for the exact bug that crashed production: `requireAuth` used to have no `try/catch`, so a rejected promise (e.g. a Supabase network blip) became an unhandled rejection and killed the whole process on every authenticated request. This locks in that it now calls `next(err)` instead.
- **`services/webhookVerification.test.ts`** — signs real JWTs with a locally generated ES256 key pair (via `jose`) to exercise the actual signature verification, not just mocked assertions: valid signatures, tampered bodies, wrong signing keys, stale tokens (replay protection), and that verification keys are cached rather than re-fetched per webhook.
- **`services/syncService.test.ts`** — the sync logic shared by the manual "Sync transactions" endpoint and the webhook handler: correct cursor/access-token usage, correct aggregation, and that a Plaid error propagates without partially applying changes.
- **`services/dataService.test.ts`** — the insert-vs-update branching in `upsertAccountsForItem`/`applyTransactionChanges` (matching existing rows by `plaid_account_id`/`plaid_transaction_id`), using a hand-rolled chainable mock of the Supabase query builder (`src/testUtils/supabaseMock.ts`) rather than a real database.
- **`services/budgetPeriod.test.ts`** — the current-month date-range math (including month/year rollover and leap years) and the spend-aggregation rules (excludes uncategorized transactions and non-positive amounts, i.e. income/refunds aren't counted as "spent").
- **`services/plaidErrors.test.ts`** — which Plaid error codes mean "this item needs re-authentication" vs. everything else.

Test files are excluded from the production build (`tsconfig.build.json`, used by `npm run build`) but still typechecked by `npm run typecheck` (which uses the base `tsconfig.json`) — so a type error in a test fails CI-equivalent checks without ending up in `dist/`.

**Frontend** (`cd frontend && npm test`, Vitest, `frontend/vitest.config.ts`) — started incrementally,
prioritizing pure business logic involving money/dates over UI/component coverage (no
jsdom/testing-library set up yet, since nothing needed it so far):

- **`lib/money.test.ts`** — `roundToCents`, incl. classic float-drift cases (`0.1 + 0.2`, `4.33 - 3`).
- **`lib/splitValidation.test.ts`** — the transaction-split balance/completeness checks the Accounts tab's split editor uses to enable/disable Save.
- **`lib/budgetDrilldown.test.ts`** — the Budget tab drill-down's split-aware category filter (mirrors the backend's `getCategorySpendRows` two-source combine — a split transaction contributes its split share, not its own row).
- **`lib/recurringDates.test.ts`** — next-due-date estimation cadence stepping, day-count math, due-label thresholds.

Not yet covered: any component, and the Monthly Breakdown drill-down's equivalent filter
(`components/MonthlyBreakdown.tsx`'s `transactionsForMonthCategory` — still inline, not yet
extracted to `lib/`).

## Deployment

Backend on [Railway](https://railway.app), frontend on [Vercel](https://vercel.com), both deploying from this repo.

### Backend (Railway)

1. New Project → Deploy from GitHub repo → select this repo.
2. Leave **Root Directory** as the repo root (default) — `railway.json` at the repo root handles the npm-workspaces build (`npm install && npm run build --workspace backend`) and start (`npm run start --workspace backend`) commands, since a workspaces monorepo needs the install run from the root, not from `backend/`. (Note: this uses `npm install`, not `npm ci` — Railway's Nixpacks caches `node_modules/.cache` as a persistent mount, and `npm ci`'s clean-slate wipe of `node_modules` collides with that mount and fails with `EBUSY`.)
3. In the service's **Variables** tab, add everything from `backend/.env.example` with real values: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, `PLAID_PRODUCTS`, `PLAID_COUNTRY_CODES`. Leave `PORT` unset — Railway injects its own and `env.ts` already reads `process.env.PORT`.
4. `FRONTEND_URL` needs the Vercel URL from the next section, so it's normal to deploy the backend once first with a placeholder, then come back and set it for real once Vercel gives you a URL (Railway redeploys automatically when you change a variable).
5. Once deployed, Railway gives you a public URL (or attach a custom domain) — that's your `VITE_API_BASE_URL` for the frontend.
6. **Settings → Networking → Public Networking**: confirm the domain's target port matches whatever the app actually logs on boot (`Backend listening on 0.0.0.0:<port>` in Deploy Logs) — this is Railway's dynamically-injected `PORT`, not a fixed value. If the domain was generated before the app was pointed at `process.env.PORT`, or the port field was hand-edited at some point, it can drift out of sync with the container's actual listening port. When that happens, Railway's own deploy healthcheck still passes (it isn't subject to the same domain routing), so the deployment shows "Active"/successful — but the public domain 502s on every request with "Application failed to respond." The browser reports that as a CORS error (no CORS headers on a response that never reached the app), which is a red herring — check this port match before touching CORS config.

### Frontend (Vercel)

1. New Project → import this repo.
2. Set **Root Directory** to `frontend` — Vercel auto-detects the Vite framework preset from there (build command `vite build`, output `dist`) and only needs `frontend/package.json`'s own dependencies, so it doesn't need the workspaces root.
3. In **Environment Variables**, add `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (same values as the backend's Supabase project — the anon key, not the service-role key), and `VITE_API_BASE_URL` set to the Railway backend URL from above.
4. Deploy. Vercel gives you a production URL — go back to Railway and set `FRONTEND_URL` to that exact URL (CORS in `backend/src/index.ts` only allows one configured origin).

### Environment variable reference

Only the variables below are actually read by the code — everything else is dead weight, safe to delete from the platform's Variables tab (harmless either way, since unused env vars are simply ignored, but worth cleaning up so a future debugging session doesn't waste time on a var that looks relevant but isn't wired to anything).

**Railway (backend)** — read in `backend/src/config/env.ts`:

| Variable | Used for |
|---|---|
| `PORT` | Injected by Railway itself — don't set manually |
| `FRONTEND_URL` | The **only** var driving CORS (`backend/src/index.ts`) — must exactly match the Vercel URL |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Server-side Supabase client |
| `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, `PLAID_PRODUCTS`, `PLAID_COUNTRY_CODES` | Plaid client config |
| `BACKEND_PUBLIC_URL` (optional) | This backend's own public URL, used to register `/api/webhooks/plaid` with Plaid on link. See **Webhooks** below. |

`CORS_ORIGIN` and `CLIENT_URL` (added during troubleshooting, presumably guessing at alternate names CORS config might read) aren't referenced anywhere in the code — `FRONTEND_URL` is the single source of truth for the allowed origin. Safe to delete both.

**Vercel (frontend)** — read in `frontend/src/vite-env.d.ts` / `frontend/src/lib/*`:

| Variable | Used for |
|---|---|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | Frontend Supabase Auth client |
| `VITE_API_BASE_URL` | Base URL for every backend API call (`frontend/src/lib/api.ts`) |

`VITE_API_URL` is an unused duplicate of `VITE_API_BASE_URL` — the code only reads the latter. Safe to delete.

### After both are live

- Confirm CORS: opening the Vercel URL and linking a Plaid account should work with no CORS errors in the browser console. If you see one, double check `FRONTEND_URL` on Railway matches the Vercel URL exactly (including `https://`, no trailing slash).
- Switch `PLAID_ENV`/`PLAID_PRODUCTS`/`PLAID_SECRET` to Plaid's Development or Production credentials when you're ready to move off Sandbox — Sandbox items and Sandbox-only routes (`/api/plaid/items/:itemId/sandbox-reset-login`) won't work against real institutions, but that route already 404s outside `PLAID_ENV=sandbox`, so it's safe to leave deployed.

## Product direction: reference dashboards

`trevfern123@gmail.com` shared two static, one-off HTML reports (`financial-dashboard_19.html`, `budget-proposal_2.html` — not in this repo, generated by an earlier session from an exported transaction history) as the inspiration for this app's direction. Those files hardcode a single snapshot of data and have no backend; the plan here is to rebuild their *concepts* — not their approach — on top of this app's live Plaid/Supabase data. All planned tabs are now built: **Overview**, **Monthly Breakdown**, **Budget**, **Subscriptions & Recurring**, **Loan Progress**, **Income & Savings**, **Accounts**. The last two needed new Plaid products (Liabilities, Investments) — see "Loan progress & Income and savings" below for the setup this actually requires (a Railway env var change plus, importantly, a *fresh* Plaid Link session, since existing items don't retroactively gain new products). Those products carry real per-user pricing once off Sandbox — worth checking Plaid's current rates before relying on them in production.

## Tab navigation

The dashboard moved from one long stack of cards to actual tabs (`TabNav.tsx`, `App.tsx`) — **Overview** (net worth + spending charts), **Monthly Breakdown**, **Budget**, **Subscriptions & Recurring**, **Accounts** (linked accounts + transactions) — since the reference design's remaining tabs (Loans, Income & Savings) will need to slot in later without another restructure.

## Monthly breakdown

`GET /api/plaid/monthly-breakdown?months=6` groups transactions by calendar month and, within each month, by **Plaid's own category** (`transactions.category`, e.g. `FOOD_AND_DRINK`) — not the user's budget categories. That's deliberate: Plaid categorizes nearly every transaction automatically, while budget categories are optional and sparse (most transactions may have none assigned), so grouping by Plaid's taxonomy gives a complete picture with zero setup. `services/monthlyBreakdown.ts` holds the pure aggregation logic (tested); `MonthlyBreakdown.tsx` renders each month most-recent-first with a per-category bar list, styled after the reference dashboard's category rows.

## Budget tab: recent-average comparison

Building on the monthly budget-period work above, `GET /api/budget-categories` now also returns `recent_avg_spent` — average monthly spend over the `RECENT_AVG_MONTHS` (currently 2) full months immediately before the current one (`services/budgetPeriod.ts`'s `getRecentMonthsRange`, deliberately excluding the in-progress current month so a partial month doesn't skew the average low). `BudgetCategories.tsx` renders it as a marker line on the progress bar — matching the reference budget-proposal's "recent avg vs. proposed budget" comparison — plus a `recent avg $X/mo` label. Same response-shape caveat as `spent`: `POST`/`PATCH /api/budget-categories` don't return `recent_avg_spent` either, so the frontend's create/update handlers treat it the same way (0 for new categories, preserved on update).

## Subscriptions & recurring costs

Plaid's `/transactions/recurring/get` (`plaidService.getRecurringStreams`) already combines what a user would call "subscriptions" and "recurring costs" into one concept — `outflow_streams` — so there's no manual categorization heuristic to build here; Tier 2 of the roadmap collapsed into "wire up an existing Plaid endpoint" rather than needing new detection logic.

**Requires a migration not yet applied as of this writing** — `recurring_streams` doesn't exist in the database yet. Until it's run, `GET /api/plaid/recurring-streams` 500s and the tab shows its empty state (verified in-browser: the rest of the dashboard is unaffected, same `Promise.allSettled` resilience as net worth history):

```sql
create table public.recurring_streams (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.plaid_items(id) on delete cascade,
  account_id uuid references public.accounts(id) on delete cascade,
  plaid_stream_id text not null,
  description text not null,
  merchant_name text,
  direction text not null check (direction in ('inflow', 'outflow')),
  frequency text not null,
  average_amount numeric not null,
  last_amount numeric not null,
  iso_currency_code text default 'USD',
  first_date date not null,
  last_date date not null,
  is_active boolean not null default true,
  status text not null,
  category text,
  updated_at timestamptz not null default now(),
  unique (item_id, plaid_stream_id)
);

create index if not exists recurring_streams_item_id_idx on public.recurring_streams(item_id);
```

No RLS policy — matching `accounts`/`transactions`, which also derive ownership through a join (`item_id`/`account_id` → `plaid_items.user_id`) rather than a direct `user_id` column. All three now have RLS *enabled* with zero policies (a Supabase security-linter prompt caught that `accounts`/`transactions` were missing it and it was subsequently added) — that's a deliberate "deny everyone except the service-role key" default, not an oversight; the backend only ever connects with the service-role key, which bypasses RLS regardless, so this only closes off direct anon-key access, nothing about how the app itself queries these tables changes.

**Refresh cadence**: unlike net worth (refreshed on balance fetch) or budget spend (computed live per request), recurring streams are refreshed as part of `syncService.syncItemTransactions` — the same function shared by the manual "Sync transactions" button and the webhook receiver — since recurring detection is transaction-history-based, not balance-based. It's wrapped in its own `try/catch` (best-effort, logged on failure) so a hiccup fetching recurring streams can't fail the transaction sync that triggered it; Plaid Sandbox typically needs a few months of simulated history per merchant before a stream reaches `MATURE` status, so don't expect results immediately after a fresh Sandbox link.

**Monthly normalization**: `services/recurringStreams.ts`'s `normalizeToMonthlyAmount` (tested) converts each stream's cadence (weekly/biweekly/semi-monthly/monthly/annually) to a comparable monthly figure, so a $15/week charge and a $180/year charge can be summed and ranked on the same basis — computed in `plaidController.getRecurringStreams`, not persisted (so changing the normalization logic doesn't require a backfill).

## Loan progress & Income and savings (Tier 3)

Both need two new Plaid products — **Liabilities** and **Investments** — added to `PLAID_PRODUCTS`. Already updated in `backend/.env` (local) and `.env.example`, but **not yet on Railway**, since that's a dashboard change only you can make. Set `PLAID_PRODUCTS=transactions,auth,liabilities,investments` there and let it redeploy.

**Important — new products don't retroactively apply to items already linked.** Plaid determines what products an item has access to at the moment the user consents through Link, not from your current `PLAID_PRODUCTS` value at request time. The existing Chase Sandbox item was linked back when `PLAID_PRODUCTS` was just `transactions,auth`, so it has no loan or investment accounts and never will unless re-consented. Once the Railway env var is updated, click **"Link a bank account"** again to add a *new* Sandbox item — that new Link session will request Liabilities and Investments, and Plaid Sandbox will synthesize the corresponding test accounts (a student loan, investment holdings, etc.) for it. Re-linking the *same* existing item via Update Mode is unlikely to add entirely new account types the item never had.

### Loan progress

**Requires a migration not yet applied** — `loans` doesn't exist yet. Verified in-browser that its absence degrades gracefully (empty state, rest of dashboard unaffected), same as every other new table this session:

```sql
create table public.loans (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.plaid_items(id) on delete cascade,
  account_id uuid references public.accounts(id) on delete cascade,
  plaid_account_id text not null,
  loan_type text not null check (loan_type in ('student', 'mortgage', 'credit')),
  name text,
  interest_rate_percentage numeric,
  origination_principal_amount numeric,
  origination_date date,
  minimum_payment_amount numeric,
  next_payment_due_date date,
  last_payment_amount numeric,
  last_payment_date date,
  is_overdue boolean,
  updated_at timestamptz not null default now(),
  unique (item_id, plaid_account_id)
);

create index if not exists loans_item_id_idx on public.loans(item_id);

alter table public.loans enable row level security;
```

**What Plaid's Liabilities product actually covers** — `credit`, `mortgage`, and `student` are the only three categories (`services/loans.ts`'s `normalizeLiabilities`, tested, flattens all three into one common shape). There is no generic "personal loan" category — an account from an online personal lender (the reference dashboard's SoFi example) still syncs fine as a regular account with a balance, it just won't get interest-rate/payment-schedule detail on this tab, only in Accounts. Worth knowing going in, not a bug to chase.

**Payoff progress** (`computePayoffProgressPct`, tested) only renders when we know the original principal — available for student loans and mortgages, never for credit cards (revolving debt has no "original amount"). `LoanProgress.tsx` renders that bar only when the backend actually returns a non-null percentage.

**Refresh cadence**: like net worth, refreshed after real balance fetches (initial link, manual "Refresh balances") via `refreshLoansForItem`, wrapped in its own `try/catch` inside the function itself (not just at call sites) since it's called from two places with identical best-effort semantics — a failure (product not enabled yet, item has no qualifying accounts) is logged and never fails the link/refresh that triggered it.

### Income & savings

**No migration needed at all** — this is a pure regrouping of data the app already had. `GET /api/plaid/assets-summary` reuses `getLinkedItemsForUser` (already fetched for the Accounts tab) and buckets accounts into Checking/Savings/Investments & Retirement/Other via `services/assetsSummary.ts`'s `groupAccountsForAssetsSummary` (tested), explicitly excluding `credit`/`loan` account types — those are liabilities, not assets, and already have their own place (net worth's liability side, and the Loan Progress tab). **Verified working in-browser with real data already** — Checking and Savings groups render correctly with no further setup, since those account types existed before this session. Investment/401k accounts are the only part of this tab that needs the Investments product + a fresh link described above.

## Appearance (theme + accent color)

System / Light / Dark theme, and 6 accent color presets (Green/default, Blue, Teal, Indigo,
Purple, Amber) — both live in the Settings tab. Financial-meaning colors are deliberately kept
out of the accent system: `--positive` (income, "good" budget status, positive deltas),
`--danger`, `--warn`, and `--info` always mean the same thing regardless of which accent the user
picked — only brand/UI elements (buttons, focus rings, links-as-accent) shift with the choice.
See the theming-model comment at the top of `App.css` for the full token architecture.

**Requires a migration** (on top of the `user_preferences` table from Dashboard customization
below):

```sql
alter table public.user_preferences
  add column theme text not null default 'system',
  add column accent_color text not null default 'green';

alter table public.user_preferences
  add constraint user_preferences_theme_check
    check (theme in ('system', 'light', 'dark'));

alter table public.user_preferences
  add constraint user_preferences_accent_color_check
    check (accent_color in ('green', 'blue', 'teal', 'indigo', 'purple', 'amber'));
```

Also tracked as `supabase/migrations/20260825230000_add_appearance_preferences.sql`. Until it's
applied, the theme/accent switcher still works interactively (every visual change applies
immediately — verified live), it just can't persist: `PUT /api/user-preferences/appearance` 500s
with "Could not find the 'accent_color' column," caught by the same best-effort `.catch()` used
for dashboard-layout saves, so nothing else breaks — the choice just won't survive a page reload
until the migration is applied.

**Flash prevention**: a small inline script in `index.html` reads a `localStorage` cache and
applies `data-theme`/`data-accent` before first paint, so a returning user never sees a flash of
the default appearance. That cache is a startup optimization only — `hooks/useAppearance.ts`
always treats the fetched `user_preferences` row as authoritative once it loads, overwriting the
cache to match it, never the reverse.

**Architecture**: same shape as Dashboard customization — `lib/theme.ts` (pure: preset
definitions, id validation, and the one function that actually touches
`document.documentElement`) + `hooks/useAppearance.ts` (thin React wrapper: state, localStorage,
auto-save persistence).

## Dashboard customization

The Overview tab's 8 cards (stats strip, Safe to Spend, Cash Flow & Budget Pace, Accounts at a
Glance, Upcoming Bills, Recent Activity, Monthly Spending chart, Net Worth chart) are individually
hideable and reorderable, with four starting presets (Standard / Budget Focus / Net Worth Focus /
Minimal) that just apply a layout snapshot — not a persisted "mode," fully editable afterward like
any other layout.

**Requires a migration**:

```sql
create table public.user_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  dashboard_layout jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_preferences enable row level security;

create policy "Users can view own preferences"
  on public.user_preferences for select
  using (auth.uid() = user_id);
```

Also tracked as `supabase/migrations/20260825210000_create_user_preferences.sql` now that schema
changes go through the tracked-migration workflow (see `supabase/SCHEMA_NOTES.md`). Until it's
applied, `GET /api/user-preferences` 500s and the frontend falls back to the built-in default
layout (same `Promise.allSettled` resilience as every other optional dashboard section) — nothing
else on the Overview tab is affected, only customization can't persist yet.

**Data model**: one `user_preferences` row per user, with a `dashboard_layout jsonb` column for
this feature specifically — deliberately *not* one big JSON blob for every future preference.
A genuinely simple future preference (theme, accent color, default currency) should get its own
dedicated column on this same table when it's built, not a key inside this jsonb column.

**Forward compatibility**: `lib/dashboardLayout.ts`'s `mergeDashboardLayout` reconciles whatever
was saved against the full known-card set — a card added after a user last saved their layout is
appended at the end, visible by default, rather than silently disappearing; a saved id that no
longer maps to a real card is dropped. A user who's never customized anything (`dashboard_layout`
is `null`) sees the exact same layout as before this feature existed.

**Architecture**: all of the actual layout logic (merging, presets, move/toggle, and which cards
render side by side vs. full width) lives in `lib/dashboardLayout.ts` — pure, framework-agnostic,
fully unit-tested, and reusable as-is by a future mobile app. `hooks/useDashboardLayout.ts` is a
thin React wrapper (state + persistence) around that logic. Card components (`OverviewStats`,
`SafeToSpend`, etc.) know nothing about customization at all — `App.tsx`'s `renderOverviewCard`
is the only place that maps a card id to its actual rendering, which is deliberately *not*
extracted, since which props each card needs only exists as live app state in `App.tsx` today.

## Flow

1. User signs in via Supabase Auth in the frontend.
2. Frontend calls `POST /api/plaid/link-token` (with the user's Supabase JWT) to get a Plaid `link_token`.
3. Frontend opens Plaid Link with that token; on success Plaid returns a `public_token`.
4. Frontend calls `POST /api/plaid/exchange-public-token` with the `public_token`. The backend exchanges it for an access token, fetches accounts from Plaid, and stores everything in Supabase (`plaid_items`, `accounts`) — the access token never leaves the backend.
5. Frontend calls `GET /api/plaid/items` to display the user's linked institutions/accounts.

## Budget periods

`GET /api/budget-categories` now returns a `spent` figure per category, computed server-side (`budgetCategoryController.ts` + `services/budgetPeriod.ts`) as the sum of that category's positive-amount transactions dated within the current calendar month (UTC) — previously this was computed client-side in `BudgetCategories.tsx` from whatever transactions happened to already be loaded in the feed, which wasn't scoped to a calendar month at all and silently included spend from every month in the loaded window as one running total.

The frontend now trusts `category.spent` directly — `BudgetCategories.tsx` no longer recomputes anything client-side and no longer takes a `transactions` prop at all. Two wrinkles worth knowing about:

- **`spent` only exists on the list response.** `POST`/`PATCH /api/budget-categories` return the bare Supabase row with no `spent` field (typed in `frontend/src/lib/api.ts` as `Omit<BudgetCategory, 'spent'>` so this isn't just implicit/undocumented). Creating a category sets `spent: 0` locally (always correct — a new category has no transactions yet); updating one merges the response into existing state instead of replacing it, so the previously-known `spent` isn't clobbered with `undefined`.
- **Keeping `spent` fresh.** Categorizing a transaction or syncing new transactions can both change a category's current-month total, so `App.tsx` refetches the categories list (`refreshBudgetCategories`) after either action — the same best-effort, non-blocking pattern already used for `refreshSummary`.

## Net worth over time

`GET /api/plaid/net-worth-history?months=6` returns a time series of `{ date, net_worth, total_assets, total_liabilities }`, rendered in the frontend by `NetWorthChart.tsx` (same plain-CSS bar-chart approach as the monthly spending chart in `SpendingOverview.tsx`).

**Requires a migration that has not been run yet as of this writing** — `net_worth_snapshots` doesn't exist in the database. Run this in the Supabase SQL editor before the feature will work; until then, `GET /api/plaid/net-worth-history` 500s with `Could not find the table 'public.net_worth_snapshots' in the schema cache`, and the frontend shows "No history yet" instead (see the `Promise.allSettled` note below for why that one failure doesn't blank the rest of the dashboard):

```sql
create table public.net_worth_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  date date not null,
  total_assets numeric not null default 0,
  total_liabilities numeric not null default 0,
  net_worth numeric not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, date)
);

create index if not exists net_worth_snapshots_user_id_date_idx on public.net_worth_snapshots(user_id, date);

alter table public.net_worth_snapshots enable row level security;

create policy "Users can only see their own net_worth_snapshots"
  on public.net_worth_snapshots for select
  using (auth.uid() = user_id);
```

One row per `(user_id, date)`, upserted (`services/dataService.ts`'s `upsertNetWorthSnapshot`, `onConflict: 'user_id,date'`) whenever balances are actually refreshed from Plaid — initial link (`exchangePublicToken`) and manual "Refresh balances" (`refreshAccounts`) — since that's the only time `accounts.current_balance` changes. There's no scheduled/cron snapshot yet, so a user who never clicks refresh won't accumulate history; that's a reasonable follow-up if daily granularity independent of user activity turns out to matter.

The asset/liability split (`services/netWorth.ts`'s `aggregateAssetsAndLiabilities`) is the same logic `getSpendingSummary` already used — extracted into its own pure, tested module and reused by both, rather than duplicated.

## Frontend resilience note

`App.tsx`'s `refreshAll` uses `Promise.allSettled`, not `Promise.all` — with five parallel dashboard fetches, one endpoint failing (as `net-worth-history` currently does, pending the migration above) used to reject the whole batch and leave every section on its empty initial state, silently, with only an uncaught promise rejection in the console. Now each successful fetch still updates its own section, and a single error banner (`actionError`) surfaces if anything failed — check the browser console for which endpoint, since the banner doesn't say.

## Webhooks

Plaid pushes updates to `POST /api/webhooks/plaid` instead of the app relying solely on the user manually clicking "Sync transactions"/"Refresh balances". This endpoint is intentionally **not** behind `requireAuth` — Plaid calls it directly as a server, not as a signed-in user — so authenticity is verified a different way: every delivery carries a `Plaid-Verification` header (a JWT signed with a key Plaid rotates periodically), which `backend/src/services/webhookVerification.ts` checks against Plaid's `/webhook_verification_key/get` endpoint (caching keys for 24h) and against a hash of the exact raw request body, rejecting anything that doesn't match or is older than 5 minutes. `backend/src/index.ts` captures the raw body via `express.json()`'s `verify` callback specifically so this check has the exact original bytes to hash, since the parsed `req.body` isn't guaranteed to re-serialize identically.

Two webhook types are handled (`backend/src/controllers/webhookController.ts`):
- `TRANSACTIONS` / `SYNC_UPDATES_AVAILABLE` — runs the same sync logic as the manual "Sync transactions" button (`backend/src/services/syncService.ts`, shared by both paths so they can't drift out of sync with each other).
- `ITEM` / `ERROR` with `ITEM_LOGIN_REQUIRED` — flips the item to `login_required` immediately, so the reconnect banner appears without the user having to trigger a manual refresh first.

**Enabling this**: set `BACKEND_PUBLIC_URL` on Railway to the backend's own public URL once you have it (same chicken-and-egg as `FRONTEND_URL` — deploy once first, then set it). `plaidService.createLinkToken`/`createReauthLinkToken` only pass a `webhook` URL to Plaid when this is set, so items linked before it's configured won't have a webhook registered — clicking **Refresh balances** afterward backfills it onto existing items (`plaidService.updateItemWebhook`, called best-effort inside `refreshAccounts`). Left unset in local dev, since Plaid can't deliver webhooks to `localhost`.

**Testing in Sandbox**: `POST /api/plaid/items/:itemId/sandbox-fire-webhook` (same auth/ownership/404-outside-sandbox pattern as the existing `sandbox-reset-login` route) asks Plaid to actually deliver the `SYNC_UPDATES_AVAILABLE` webhook for that item, so you can exercise the real receiver — signature verification included — rather than only trusting it in theory.
