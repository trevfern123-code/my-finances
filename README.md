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
