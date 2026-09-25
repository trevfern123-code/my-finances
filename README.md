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

**Replaying the history (fresh environment / disaster recovery).** The whole `supabase/migrations/`
history rebuilds through the supported Supabase CLI: `supabase db reset` locally, or
`supabase db push --db-url <new database>`. The CLI sends each migration file as ONE extended-protocol
pipeline: a single implicit transaction, but not a PostgreSQL "transaction block". So a migration
must never use a top-level `SET LOCAL` (silently ignored) or `LOCK TABLE` (rejected). Put them
inside a `DO` block instead, as the Phase A migration now does.

- **Phase A fix:** `20260912120000_transaction_semantic_roles.sql` originally began with exactly those
  two statements. During the 2026-09 rollout the CLI failed there, and production was applied manually
  in one explicit transaction, then recorded in the migration ledger. The file was corrected in place
  (same version, originals quoted in its header).
- **Production is unaffected:** its ledger already records that version, and the CLI selects
  migrations by version only.
- **Proof:** `bash supabase/tests/replay/run.sh` checks the replay and the resulting schema; with
  `SUPABASE_CLI="npx -y supabase@2.117.0"` it also runs the real CLI. CI runs both tiers, in the
  `migration-replay` job.
- **Production head:** `PRODUCTION_HEAD` in `supabase/tests/replay/run.sh` (default
  `20260924130000`) names the newest version production has applied. R5/C3 rehearse the next
  production push: every earlier ledger row stays byte-for-byte unchanged, and exactly the later
  files apply. With nothing pending, they check that a push to production's state is a no-op.
  Advance it after each production rollout.
- **`20260924120000_manual_loan_link_idempotency.sql`** (post-audit blocker 1, applied 2026-09-24)
  makes `link_transaction_to_manual_loan` return an explicit outcome instead of linking, and
  decrementing, a transaction twice. The backend rejects the old `void` result.
- **`20260924130000_manual_loan_applied_balance_delta.sql`** (post-audit blocker 2, applied
  2026-09-24) records what each
  loan payment actually took off a manual loan's balance: `transactions.loan_balance_applied` and
  `manual_loan_payments.balance_applied`. A balance is still never driven below zero. Unlink, edit,
  delete and Plaid removal now restore exactly that amount, not the full principal. Example: a $100
  payment linked to a $50 balance used to leave $100 behind when unlinked.
  - **No row may lack its amount.** An existing link or payment never recorded what it applied, and
    that can't be reconstructed. So the migration **refuses to run** while any linked transaction
    or manual payment exists; nothing changes and no ledger row is written.
  - **Guards:** `balance_applied` is `NOT NULL`, and a linked transaction must carry
    `loan_balance_applied`. The backend on `main` writes links and payments directly without them,
    so those writes now fail. They fail before its balance update runs, because that backend writes
    the row first.
  - **Fail closed:** if a missing amount were ever read anyway, every reversal raises
    `manual-loan reconciliation required` and writes nothing. It never falls back to the full
    principal.

Caveats:
- **Never run `supabase migration fetch` without reviewing the diff.** It rewrites local migration
  files from the statements stored in the remote ledger, which would restore the original,
  unreplayable Phase A file. Likewise, never `supabase migration repair` version `20260912120000`.
- **This checkout is linked to the production project** (`supabase/.temp`). A bare `supabase db push`
  targets production. Test pushes always need an explicit local `--db-url`, as the replay harness uses.

### Releasing the post-audit migrations (completed 2026-09-24)

`20260924120000` and `20260924130000` shipped together with the backend and frontend that need them,
as merge commit `d2cf720` (PR #1). The sequence below is the record, and the template for any future
release that changes the database. Merging to `main` **is** the deploy, because Railway and Vercel
both auto-deploy from it. So the database changes go first, while the backend is stopped.
Read-only SQL for the preflight/postflight: `supabase/preflight/20260924130000_applied_delta_preflight.sql`.

1. **Independent review passes, and CI is green.**
2. **External configuration confirmed** (here: the Plaid Dashboard completion redirect URI).
3. **Production preflight** (read-only): the ledger head is the expected version, and no row blocks
   the migration's gate. If anything blocks it, **stop** and decide how to reconcile it. Never
   delete or edit rows just to make a preflight pass.
4. **Stop the backend** for the window by removing Railway's active deployment, so the old backend
   writes nothing between the migrations and the new deploy (webhook-triggered syncs included), and
   old and new instances never overlap. Missed Plaid webhooks are harmless: the next sync catches up
   from Plaid's cursor.
5. **`supabase db push --dry-run`**, then **`supabase db push`**, from the linked checkout at the
   release head. The dry run must list exactly the expected files.
6. **Production postflight** (read-only).
7. **Merge the PR.** Railway and Vercel deploy the new backend and frontend.
8. **Health check and smoke tests** in a **fresh browser session** (see "Lessons" below): `/health`
   responds; a controlled manual-loan test (a payment larger than the balance, then deleted,
   restores the balance exactly); a controlled Plaid Sandbox link.
9. **Advance `PRODUCTION_HEAD`** in `supabase/tests/replay/run.sh`.

What actually happened on 2026-09-24:
- The preflight found one legacy manual-loan link (a payment linked before applied amounts were
  recorded), which the migration's gate would have refused. It was detached by a one-time, guarded
  statement that verified every expected value first and kept the loan's balance exactly as
  entered. Its applied amount was unknowable, so it was not re-linked.
- `db push` applied both migrations; the postflight and a final check of that loan passed.
- The manual-loan and Plaid Sandbox smoke tests passed. The Sandbox test's First Platypus Bank
  item, its 14 accounts, 49 transactions, recurring streams, liability records and the day's
  contaminated net-worth snapshot were then removed by a second one-time guarded statement. The
  other institutions and every manual loan were verified unchanged.

Lessons (reusable):
- **A browser tab or installed app opened before a deploy keeps running the previous frontend**,
  and the service worker serves the previous build once more on the first reload. The first Plaid
  smoke test therefore ran the retired embedded-Link flow against the new backend. Run release
  smoke tests in a fresh (e.g. Incognito) session, and check which bundle is loaded (DevTools →
  Network). A proper update mechanism is a planned release-hardening task.
- **One-time production data fixes are guarded single statements**: one `DO` block that locks what
  it touches (the same per-user advisory lock the app uses), re-verifies every expected value,
  refuses on any mismatch, and proves afterwards that nothing else changed (before/after
  fingerprints). Each is preceded and followed by a read-only check. They are not kept in the
  repository once run, because they carry production identifiers.
- **Run each SQL part on its own in the Supabase SQL editor.** It executes the whole editor, and
  shows only the last result.
- **There is no in-app way to remove a linked institution yet** (planned V1 feature). Test
  institutions linked to production must be removed by hand until it exists.

## CI

`.github/workflows/ci.yml` runs on every push/PR to `main`: backend typecheck, backend tests,
backend build, frontend typecheck, frontend tests, frontend build. No secrets are required —
every backend test mocks its Supabase/Plaid config imports, so the suite passes with zero
environment variables set (verified: `env -i npx vitest run` passes clean). This doesn't deploy
anything itself — Railway and Vercel still deploy independently on push — it just catches a
broken build/test before that happens.

Two database jobs run alongside it, each against throwaway local containers only:
- `migration-replay`: rebuilds the whole migration history through the pipeline emulator and the
  real, pinned Supabase CLI (`db push`, `db reset`); see "Replaying the history" above.
- `database-harness`: the adversarial PostgreSQL suites, `supabase/tests/phase_a` (scaffold and
  history modes) and `supabase/tests/access_control`.

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

## Budget category customization (color, emoji, ordering, archive)

Budget categories support a color (10 curated swatches, `lib/categoryColors.ts` — identity markers for scanability, deliberately avoiding red/orange/amber/green so a category dot is never mistaken for the app's positive/danger/warn semantic colors) and an emoji (a curated ~70-option picker, `BudgetCategories.tsx`'s `EMOJI_OPTIONS`, plus a "paste any emoji" custom input with light sanitization — trim + a generous length cap, not a strict grapheme validator, since this is a single-user app). Manual up/down ordering (`sort_order`) predates this work and is unchanged, just now scoped to active categories only.

**Archiving replaces deleting.** `budget_categories.archived_at` (`timestamptz`, null = active) lets a category be retired from active budgeting without touching any historical data — there's no hard-delete path in the UI. Archiving a category also removes any `category_mappings` row that targets it (so newly-synced transactions stop being auto-assigned there; the mapped Plaid category reverts to "Unmapped" until remapped to an active category) but never touches `transactions.budget_category_id` or `transaction_splits` — those relationships are permanent. Unarchiving restores the category (position, color, emoji, and spend totals all preserved) but does **not** recreate any mapping that was removed — that's a deliberate choice, not an oversight, since the mapping's target may no longer be the right call by the time someone unarchives.

Two different views of the same `budgetCategories` array are used depending on context: **active-only** for anything that budgets or selects going forward (`App.tsx`'s `activeBudgetCategories` — the Budget tab's editable list, remaining-budget math in `SafeToSpend`/`CashFlowPace`, and the category-mapping target dropdown), and the **full list** for anything that needs to resolve or display an already-archived category (`TransactionsFeed`, `SplitEditor`, `RecentActivity`'s label lookups). `lib/categoryLabels.ts`'s `selectableCategories(categories, currentId)` is the shared rule for per-row selects: every active category, plus the row's current value even if it's since been archived — so an existing categorization is never silently offered as "still pickable for something else" but also never disappears from its own dropdown. `budgetCategoryLabel` appends "(archived)" automatically whenever it renders one, so the distinction is always visible wherever it matters (transaction filters, split rows) without extra plumbing.

`budget_categories.name` moved from a database-wide unique constraint to a per-user, **active-only** unique index (`budget_categories_user_id_name_active_key`) — closing the previously-flagged second-user-readiness gap and, as a direct consequence of archiving, letting a name be reused once its old holder is archived. Two archived categories may share a name (nothing enforces uniqueness among archived rows); attempting to unarchive one while an active category already holds that name fails with a surfaced constraint-violation error rather than corrupting anything — verified live.

## Account customization (nickname, color/icon, ordering, hide, exclusions)

`accounts` gained seven user-owned columns: `nickname`, `color`, `icon`, `sort_order`, `hidden`, `exclude_from_net_worth`, `exclude_from_cash_flow` — all excluded from `upsertAccountsForItem`'s Plaid-sync update path (the same proven pattern as `credit_limit`/`savings_goal`), so a balance refresh or re-sync can never overwrite them. `lib/accountDisplay.ts`'s `accountDisplayName()` (`nickname ?? name`) is used everywhere an account name renders — the transaction feed, its account filter, Accounts-at-a-glance, Income & Savings — so a nickname shows up consistently rather than in just one place. The icon/color pickers are the same generic `EmojiPicker`/`ColorPicker` components used by budget categories (extracted out of `BudgetCategories.tsx` into their own files during this work), not a second bespoke implementation.

**`hidden` is display-only — verified live, including a real bug caught in the process.** It removes an account from glanceable summary widgets (Accounts at a glance, Income & Savings) but must never affect a calculation. The Accounts tab (Linked accounts) always shows every account regardless of hidden status, since that's the only place to unhide one. The first implementation wrongly had `groupAccountsForAssetsSummary` drop hidden accounts from its bucket `total` as well as its display list, which silently reduced Safe to Spend's Liquid Cash — caught during live verification (hiding an account visibly changed Liquid Cash) and fixed: the backend aggregation function no longer filters `hidden` at all, only `exclude_from_net_worth`; `AccountQuickView`/`IncomeSavings` filter `hidden` themselves at render time, after the total is already computed over every account.

**The two exclusion flags are independent, matching separate calculation paths.** `exclude_from_net_worth` removes an account's balance from net worth, the net-worth chart, and liquid cash (all balance-based) — the account still appears wherever it'd otherwise show, balance included, with a "· Excluded from net worth" indicator, just left out of the summed total. `exclude_from_cash_flow` removes an account's transactions and recurring streams from personal cash-flow aggregates — Monthly Spending, Monthly Breakdown, Budget category spend, Cash Flow Pace, Savings Rate, and (as a single shared data source) Subscriptions & Recurring's totals and Income & Savings' income breakdown, which also means an excluded account's recurring bills drop out of Overview's Upcoming Bills. Neither flag ever hides an individual transaction from the feed or its account filter — both were verified live still showing and correctly labeled after exclusion. `getRecurringStreamsForUser` filters via a left embed (`accounts(exclude_from_cash_flow)`, not `accounts!inner(...)`) rather than a join filter, since `recurring_streams.account_id` is nullable and an inner join would have silently dropped any stream with no linked account.

**Net worth is a recorded daily snapshot, not computed live for the chart** — so toggling `exclude_from_net_worth` triggers an immediate `recordSnapshotForUser` call, updating today's point right away rather than waiting for the next sync. Verified live: excluding an account changed today's snapshot from -$76,844.15 to -$76,954.15 while the prior two days' recorded snapshots stayed untouched.

## Post-launch hardening pass (test coverage, accessibility, CI)

A follow-up pass across Dashboard/Appearance/Budget/Account customization, done autonomously right after Account Customization v1 shipped:

- **Extracted `lib/reorder.ts`'s `computeReorder()`** — `BudgetCategories.tsx` and `LinkedAccounts.tsx` each had a near-identical, untested inline `handleMove` (swap with a neighbor, renumber sequentially, persist only changed rows). Now one pure, tested function shared by both.
- **Fixed a real bug in `sanitizeCustomEmoji`** (shared by the budget-category and account icon pickers): its length cap of 8 UTF-16 code units silently rejected legitimate multi-codepoint emoji it claimed to support, like a 4-person family ZWJ sequence (11 units). Raised to 16 — comfortably covers real emoji, still rejects an obviously-pasted sentence. Caught by writing tests for it, which didn't exist before.
- **Mobile-width fixes**: `.reorder-btn` (used by Dashboard/Budget/Account reordering) rendered at ~21×14px, under the WCAG 2.5.8 24×24px minimum touch target — given a 28×28px minimum. `.budget-category-header` had no wrap and a zero-min-width name element, so at narrow viewports the category name was squeezed to ~3px (invisible) while the budget-amount input and Archive link kept full width — fixed with `flex-wrap` plus a 5rem minimum on the name.
- **Accessibility fix**: the account exclusion checkboxes inherited the global `input:focus { outline: none }` rule with no border to recolor as a fallback (checkboxes have none), leaving keyboard focus completely invisible — a real WCAG 2.4.7 failure. Added a scoped `input[type='checkbox']:focus-visible` outline; verified with actual Tab-key navigation, not a simulated `.focus()` call (which doesn't reliably trigger `:focus-visible` in this browser automation environment — worth remembering if this comes up again).
- **Contrast-checked but deliberately left alone**: the default Green and Teal accent presets fall just under WCAG AA (3.60/3.58 vs. 4.5:1) for normal-size text in light mode specifically (dark mode is fine, 6.3+ for every preset); `--text-muted` on `--surface-raised` is marginally short (4.34 vs. 4.5). Both are existing, Trevor-approved design values, not new bugs introduced by this work — left as an open product decision rather than silently adjusted.
- **CI**: fixed a GitHub Actions annotation — "Node.js 20 is deprecated... actions/checkout@v4, actions/setup-node@v4" (GitHub deprecating the Node runtime actions execute in, unrelated to this project's own `node-version: 20` target). Bumped both actions to `@v5`, whose 5.0.0 releases exist specifically to declare node24 support; checked both changelogs for anything else that could affect this repo (checkout's only other change is a `pull_request_target` default this workflow doesn't trigger; setup-node's is opt-in caching keyed off a `package.json` `packageManager` field this repo doesn't have) before bumping.
- **Extracted `lib/currency.ts`**: `formatCurrency` was independently redefined identically across 13 component files, in a cents-showing variant (with and without null-amount/currency handling) and a whole-dollar variant used by the Net Worth stat/chart and Monthly Spending chart. Now one tested pair of functions (`formatCurrency`, `formatCurrencyWhole`); verified byte-for-byte identical rendered output before/after.

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

## Financial Preferences

Four global settings, in the Settings tab directly below Appearance: **minimum cash buffer**
(dollar amount, default $0, subtracted from Safe to Spend as its own breakdown line — never
alters any account balance, budget target, or transaction), **upcoming-bills look-ahead window**
(1–90 days, default 14, used consistently by both the Upcoming Bills card and Safe to Spend so the
two always agree on what "upcoming" means), **recent-average window** (1–12 months, default 2,
what the Budget tab's "recent avg" spend figure averages over — the label always states the
current window, e.g. "Recent avg (last 4 mos)"), and **savings-rate target** (0–100%, default 15,
a personal goal compared against the already-calculated savings rate — changes the target/tier
shown, never the calculated rate itself, and is deliberately separate from a per-account dollar
`savings_goal`).

**Requires a migration** (on top of `user_preferences` from Dashboard/Appearance above):

```sql
alter table public.user_preferences
  add column minimum_cash_buffer numeric(12,2) not null default 0,
  add column upcoming_bills_days integer not null default 14,
  add column recent_avg_months integer not null default 2,
  add column savings_rate_target numeric(5,2) not null default 15.00;

alter table public.user_preferences
  add constraint user_preferences_minimum_cash_buffer_check
    check (minimum_cash_buffer >= 0),
  add constraint user_preferences_upcoming_bills_days_check
    check (upcoming_bills_days between 1 and 90),
  add constraint user_preferences_recent_avg_months_check
    check (recent_avg_months between 1 and 12),
  add constraint user_preferences_savings_rate_target_check
    check (savings_rate_target between 0 and 100);
```

Also tracked as `supabase/migrations/20260826020000_financial_preferences.sql`. Every default
matches the value that was already hardcoded before this feature existed, so behavior is unchanged
for any user who never touches these settings.

**Architecture**: same shape as Appearance/Dashboard customization — `lib/financialPreferences.ts`
(pure: defaults, bounds, clamp functions, and `savingsRateTier`) + `lib/safeToSpend.ts` (pure:
`computeSafeToSpend`/`computeRemainingBudget`, both unit-tested including the combination of a
custom look-ahead window with a minimum cash buffer applied together) + `hooks/useFinancialPreferences.ts`
(thin React wrapper: state + auto-save persistence, no localStorage cache — unlike theme/accent,
these numbers have no pre-paint flash to prevent, so hydration is a plain `useEffect` keyed on the
fetched value, exactly like `useAppearance`'s hydration effect).

**Found and fixed during verification**: the hook's first version hydrated by mutating a `useRef`
flag directly in the render body instead of inside a `useEffect`. That works by accident on a
component's very first render, but React's dev-mode double-invocation can run that branch on a
throwaway pass whose `setState` never reaches the committed render — the state visibly reverted to
defaults on every render after the first one, even though the ref itself correctly read `true`.
Moved the hydration into a `useEffect` (matching `useAppearance`'s proven pattern) and confirmed
persistence survives a reload.

## Safe to Spend Customization

Two toggles, under a "Safe to Spend calculation" subheading in the same Financial Preferences
settings card: **include upcoming bills** and **include remaining budget** — both default `true`,
preserving the original formula exactly for anyone who never touches them. When a toggle is off,
that line shows `$0` with a muted "— Not included" label rather than being hidden, so the
breakdown always explains its own math instead of quietly dropping a line.

**Credit-card minimum payments got their own breakdown line**, broken out of the generic "Upcoming
bills" line rather than added alongside it. `collectUpcomingItems` (`lib/upcomingItems.ts`) tags a
Plaid loan with `loan_type: 'credit'` as `kind: 'credit_card_minimum'` instead of the generic
`'loan'`; `splitUpcomingTotals` (`lib/safeToSpend.ts`) then sums each `UpcomingItem` into exactly
one of `billsTotal`/`creditCardMinimumsTotal` — never both — so the split can never double-count a
dollar between the two lines. The "include upcoming bills" toggle gates both lines together (the
credit-card line is a breakout of the same obligation category, not a separate one), matching the
approved two-toggle scope. Full breakdown order: Liquid cash / Upcoming bills / Credit card minimum
payments / Remaining budget / Minimum cash buffer / Safe to Spend.

**Savings-goal contributions were deliberately excluded from this v1.** The existing
`accounts.savings_goal` is a target *balance*, not a monthly planned contribution — inferring a
monthly reservation amount from a target balance alone would require assumptions (a target date, a
contribution rate) the data doesn't support. Revisit only if a dedicated recurring-contribution
feature gets built later.

**A real pre-existing gap was fixed alongside this work**: `getLoansForUser` never filtered by
`exclude_from_cash_flow`, unlike `getRecurringStreamsForUser` — a loan's minimum payment could
still count toward Upcoming Bills/Safe to Spend even after its account was flagged excluded from
cash flow. Fixed to filter identically (left-embed the accounts relation, filter in application
code so a loan with no linked account is kept, not silently dropped), with regression tests for
both the exclusion and the no-linked-account case. Verified live: flagging the sandbox "Plaid
Credit Card" account's `exclude_from_cash_flow` made its loan disappear from `/api/plaid/loans`;
un-flagging it brought the loan back.

**Requires a migration** (on top of `user_preferences` from Financial Preferences above):

```sql
alter table public.user_preferences
  add column safe_to_spend_include_upcoming_bills boolean not null default true,
  add column safe_to_spend_include_remaining_budget boolean not null default true;
```

Also tracked as `supabase/migrations/20260826030000_safe_to_spend_customization.sql`. Persisted
through the same `PUT /api/user-preferences/financial` endpoint and `useFinancialPreferences` hook
as the rest of Financial Preferences v1 — no new endpoint or hook needed.

**Verified live in every combination Trevor asked for**: all four toggle combinations (both on,
both off, each one individually off) reconciled exactly against the displayed Safe to Spend figure;
combined with a nonzero minimum cash buffer ($300) and a custom upcoming-bills window (7 days)
together — e.g. $640 liquid cash − $500 (7-day bills) − $0 (excluded remaining budget) − $300
buffer = **−$160.00**, matching to the cent; and confirmed the setting survives a page reload.
Reset back to the original defaults (all toggles on, $0 buffer, 14-day window) afterward. Because
the sandbox Plaid data's only credit-type loan has a stale multi-year-old due date, a genuinely
nonzero "Credit card minimum payments" line couldn't be exercised live without editing synced Plaid
data directly (out of scope) — that exact scenario is covered instead by `upcomingItems.test.ts`
and `safeToSpend.test.ts`, which construct a credit-type loan with a due date inside the window.

## Date-Range Customization

One shared `reporting_range` preference (`this_month | last_month | last_3_months | last_6_months
| last_12_months`, default `last_6_months`) drives the three historical/trend widgets that already
shared one "N months" concept before this feature existed: Monthly Breakdown, the Overview tab's
Monthly Spending chart, and the Net Worth chart. Shown as one horizontally-scrollable pill row
(`ReportingRangeSelector`, no dropdown/calendar) rendered in both places it applies — Overview
(only when a range-following card is actually visible) and Monthly Breakdown — sharing the same
state so the two can never drift apart.

**Deliberately excluded from following the range** — current-period-intrinsic or independently
configured, per an explicit product decision rather than an oversight:
- **Safe to Spend** and **Cash Flow Pace** — both answer "how am I doing *right now*/*this month*,"
  which has no coherent meaning over an arbitrary historical window.
- **Budget tab's recent-average comparison** — stays driven solely by the pre-existing
  `recent_avg_months` Financial Preference. It's a calculation baseline ("what's typical"), not a
  reporting view, even though both happen to be phrased as "N months."
- **The Transactions feed** — its date/account/category/search filters stay fully independent by
  design; picking a reporting range never silently restricts the transaction history someone's
  looking at.

**Backend**: `services/reportingRange.ts` resolves a range id into date bounds, reusing existing,
already-tested functions rather than inventing new date math — `this_month`/`last_month` reuse
`budgetPeriod.ts`'s `getCurrentMonthRange`/`getRecentMonthsRange(1)` (true bounded periods); the
three rolling presets reuse `netWorth.ts`'s `getMonthsAgoStart` (open-ended through today, so the
current in-progress month keeps appearing as the most recent, still-filling-in bar — exactly
today's pre-existing chart behavior, just user-selectable instead of hardcoded). `GET
/api/plaid/summary`, `/monthly-breakdown`, and `/net-worth-history` all accept a new `range_id`
query param; the legacy `months` param (default 6) is preserved unchanged as a fallback whenever
`range_id` is absent or unrecognized, so nothing breaks for a caller that only knows about it.

**A real correctness gap was fixed alongside this, not left to interact unpredictably with the new
range**: Cash Flow Pace and Income & Savings' Savings Rate card used to read whatever the *last*
bucket of a 6-months-back array happened to be — a coincidence, not a query, and one that would've
silently shown *last month's* numbers mislabeled as "this month" the instant a user picked the new
`last_month` reporting preset (which deliberately excludes the current month from that array
entirely). `GET /api/plaid/summary` now always additionally computes an explicit `current_month:
{ income, spent }` field via its own `getCurrentMonthRange()` query, completely independent of
whatever historical range was requested — Cash Flow Pace and Income & Savings now read from that
instead. Verified live: with `last_month` selected, Monthly Breakdown/the spending chart correctly
showed July-only data, while Cash Flow Pace and the Savings Rate card kept showing the real current
month (August) — matching each other and matching what `this_month` independently produced.

**Custom start/end dates deliberately deferred**, per explicit product decision — the presets cover
the common cases, and none of the three bucketed-chart widgets are built to render a partial-month
bucket. The architecture stays ready for it later: `getRecentTransactionsForUser` and the
transactions endpoint now accept optional, additive `start`/`end` (inclusive) query params — not
wired to any UI yet, since the Transactions feed intentionally stays independent of this feature,
but real server-side range filtering (as opposed to filtering an already-fetched, limit-capped
array) is there for a future drill-down or date picker to use.

**Requires a migration** (on top of `user_preferences` from Safe to Spend Customization above):

```sql
alter table public.user_preferences
  add column reporting_range text not null default 'last_6_months';

alter table public.user_preferences
  add constraint user_preferences_reporting_range_check
    check (reporting_range in ('this_month', 'last_month', 'last_3_months', 'last_6_months', 'last_12_months'));
```

Also tracked as `supabase/migrations/20260826040000_reporting_range.sql`. Persisted through its own
narrow `PUT /api/user-preferences/reporting-range` endpoint and `useFinancialPreferences`-shaped
`hooks/useReportingRange.ts` hook (effect-based hydration from the start, matching the fix already
applied to `useFinancialPreferences` — no localStorage cache needed here either).

**Verified live in every combination Trevor asked for**: all 5 presets individually; confirmed
Monthly Breakdown, the spending chart, and the Net Worth chart all update together and stay in sync
between the Overview and Monthly Breakdown tabs (a range picked on one tab is still selected when
switching to the other); confirmed Safe to Spend, Cash Flow Pace, Budget's recent-average, and
Upcoming Bills stayed byte-for-byte unchanged across every preset switch; confirmed the setting
survives a page reload (including the expected, harmless one-time double-fetch on initial load for
a saved non-default value — first with the default while `reporting_range` is still loading, then
corrected once it arrives, visible in the network log as two `range_id` requests in quick
succession — a deliberate simplicity/correctness tradeoff, not a bug). Reset back to `last_6_months`
afterward.

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
2. When the user clicks **Link a bank account**, the frontend opens a new tab and calls `POST /api/plaid/link-token` (with the user's Supabase JWT). The backend creates a Plaid **Hosted Link** token (`hosted_link` with a 30-minute `url_lifetime_seconds` and `completion_redirect_uri` = `${FRONTEND_URL}/plaid-link-complete.html`). It stores that link token server-side, encrypted under the Plaid token key ring and bound to the attempt, in a one-time, 30-minute **Link attempt**. The attempt is tied to the verified user *and* their login session (the JWT's `session_id` claim; table `plaid_link_attempts`, service-role only). The response is only `hosted_link_url`, `link_attempt_id` and `expires_at`; the link token never leaves the backend.
3. The new tab goes to the Hosted Link URL and the user links their bank on Plaid's own page. When it ends, Plaid sends that tab to `plaid-link-complete.html`, which tells the app tab to check now and tries to close itself.
4. The app tab calls `POST /api/plaid/link-attempts/:link_attempt_id/complete` (every 4 s, on returning to the tab, and when the completion page signals). Only the attempt's own user in its own login session gets anything; anyone else gets 409 `link_attempt_invalid`. The backend reads its stored link token and asks Plaid (`/link/token/get`) for that token's own session result:
   - Still in progress: 202 `pending`.
   - Exited: 409 `link_attempt_exited`. More than one result: 409 `link_attempt_ambiguous`. Expired: 410 `link_attempt_expired`.
   - Exactly one public token: the attempt is atomically **claimed** (with a claim token), then durably marked **exchanging**, and only then exchanged — once. The new item and its encrypted access token are stored **immediately**, in the same database transaction that marks the attempt **completed** (`store_plaid_link_item`), before any other Plaid call. A duplicate or concurrent call gets 202 `completing`; a replay gets 409 `link_attempt_already_completed`.
   - After that the bank is linked. Institution, accounts, initial sync, the net-worth snapshot and liabilities are follow-ups: if any fails, the response still says `completed` and lists it in `follow_up_incomplete`. **Refresh balances** retries accounts, institution, snapshot and liabilities; **Sync transactions** (or the webhook) retries the sync.
   - Failures: a Plaid-rejected exchange ends `failed`. An exchange whose outcome is unknown (network error, 30 s timeout, 5xx) ends `exchange_unknown`, 409 `link_attempt_outcome_unknown` — never re-exchanged, since Plaid does not document that as safe. The user is told the outcome could not be confirmed and asked **not to link that bank again yet but to contact support**: Plaid may already have created the Item, so relinking before it is checked could duplicate it (and its billing). If the item cannot be stored and the database definitively stored nothing, the item is removed at Plaid (`/item/remove`): `failed` if Plaid confirms the removal, `exchange_unknown` if not. If whether it was stored is itself unknown, nothing is removed.
   - Recovery (two minutes): an abandoned claim whose exchange never began is safely re-claimed. An abandoned `exchanging` attempt becomes `exchange_unknown`.
   - Limit: at most five live attempts per user, counting pending, claimed and exchanging ones. Only pending ones are removed to make room; with five being completed, creation answers 429.

   No endpoint accepts a public token from a client: the retired `POST /api/plaid/exchange-public-token` always answers 410 `exchange_retired`. A verified `SESSION_FINISHED` webhook only records readiness; it never exchanges. The access token never leaves the backend.
5. Frontend calls `GET /api/plaid/items` to display the user's linked institutions/accounts.

**Every mutation is bound to the session that started it.** Each frontend change request (every
`lib/api.ts` export that sends POST/PATCH/PUT/DELETE) takes a required owner check, captured when
the user's action starts (`lib/sessionOwnership.ts`, `App.tsx`'s `captureOwnership`): the same
user *and* the same Supabase login (`session_id`), still current. `authedFetch` refuses to send a
mutation without one, and refuses — sending nothing — if a sign-out/sign-in (as anyone, including
the same user again) happened while the action waited. Multi-step flows (Plaid Link, reconnect)
also stop between steps, and `PlaidLink` is keyed by login so a sign-in change abandons a pending
Hosted Link attempt. `lib/sessionOwnership.test.ts` exercises every mutation export this way.

**No direct client access to `plaid_items`.** The browser's Supabase client is used for Auth only.
`supabase/migrations/20260922120000_restrict_plaid_items_client_access.sql` revokes every
anon/authenticated privilege on `plaid_items` (table and column level) and drops the old
owner-select policy, which had let a signed-in user read their own stored Plaid credentials
straight from Supabase's REST API. The backend's service-role access is unchanged. Proof:
`bash supabase/tests/access_control/run.sh` (Docker; applies the real migration history to
Supabase's PostgreSQL 17 image and queries as `anon`/`authenticated`/`service_role` exactly as
PostgREST would; `EXCLUDE=<migration file>` shows the tests failing without it).

## Wave 1 follow-ups

**P1 — public-token binding: resolved with Plaid Hosted Link.** A Link attempt on its own only proved
the caller had recently started *a* Link flow. With embedded Link the browser held the public token,
so user B could exchange a public token captured from user A using B's own fresh attempt.
(Embedded Link offers no default server-side way to tie a public token to its link token.
`/link/token/get` returns full session results by default only for Hosted Link.)

Now the backend creates and keeps the Hosted Link token and gets the public token from Plaid itself
for that exact token. No endpoint accepts a public token from a client, so the attack has nowhere to
be submitted. The attack is an active test in `backend/src/controllers/plaidController.test.ts`.

**Configuration this depends on (all in place in production as of 2026-09-24; not managed by this
repository):**
- **Plaid Dashboard:** the completion redirect URI
  `https://my-finances-frontend-kappa.vercel.app/plaid-link-complete.html` is allowed. It must match
  `${FRONTEND_URL}/plaid-link-complete.html` (or `PLAID_HOSTED_LINK_COMPLETION_REDIRECT_URI`, if
  set). For local Sandbox testing, also allow `http://localhost:5173/plaid-link-complete.html`, if
  the Dashboard accepts it.
- **Supabase:** `20260922120000_restrict_plaid_items_client_access.sql` and
  `20260922130000_plaid_link_attempts.sql` are applied.
- **Railway:** no extra variables. `FRONTEND_URL` must be the exact frontend origin (it also forms
  the redirect URI). `BACKEND_PUBLIC_URL` should stay set so `SESSION_FINISHED` webhooks arrive;
  they are optional, since completion always asks Plaid directly.

**Residual, unavoidable with Plaid's API: orphaned Items — `exchange_unknown` requires investigation before relinking.** An attempt that ends `exchange_unknown`
may have left an Item at Plaid whose access token this app never stored (the exchange succeeded but
the answer was lost, or it could not be stored and its removal was not confirmed). Without that
access token nothing can call `/item/remove` for it. Plaid documents neither exchange replay nor
`/item/remove` idempotency, and has no API to list Items per `client_user_id`. Such an Item may keep
subscription billing (Transactions, Liabilities) running until Plaid support removes it. Monitor it with
`select failure_reason, count(*) from plaid_link_attempts where status = 'exchange_unknown' group by 1;`
before rows are swept, an hour after expiry.

When a user reports this message, before they link that bank again:
1. Note when it happened: `select id, created_at, failure_reason from plaid_link_attempts where user_id = '<user>' and status = 'exchange_unknown';`. The row is swept about 90 minutes after it was created, so run this promptly; otherwise use the time the user reports.
2. Using the Plaid Dashboard's logs, or Plaid support, check for an Item created around then for that institution. The Link token was created with `client_user_id` = the user's id.
3. If such an Item exists, ask Plaid support to remove it (this app holds no access token for it). Only then tell the user it is safe to link again.

**Post-audit follow-ups (deferred from the release-audit remediation; the full V1 roadmap is in
"Roadmap to V1" below):**
1. **Highest priority — define manual-loan balance-as-of semantics and historical transaction
   linking.** Today a new loan's match rule links every earlier unlinked matching payment and
   decrements the balance the user just entered, which may already reflect those payments.
   Until this is settled, **don't set a match text on a loan whose historical payments are already
   reflected in its balance** (for example the SoFi loan), and don't create a loan whose match text
   matches such payments. Either links them at their full amount. Edits that leave the match text
   empty never re-link anything. Decide and document:
   - what `current_balance` means ("as of" when?);
   - loan creation;
   - manual balance edits;
   - banks linked after the loan was created;
   - delayed or pending Plaid transactions;
   - unlink behaviour after a balance edit;
   - reconciliation and reporting for existing loans;
   - the user-facing wording.

   Blocker 2's recorded deltas make every operation exactly reversible, but they do not settle
   which payments should be applied in the first place.
2. **High priority — retain `exchange_unknown` link attempts for 30 days.** They are currently swept
   about 90 minutes after creation, which leaves little time to investigate a possible orphaned
   Item (see above).

**Other follow-ups (deliberately out of scope for the Wave 1 corrective pass):**
- Reconnect button stays stuck on "Reconnecting..." if Plaid Update Mode is closed without
  finishing (`frontend/src/components/ReconnectButton.tsx`, pre-existing). Update Mode stays embedded
  Link: it produces no public token.
- Supabase's default privileges still grant every new `public` table/function to
  `anon`/`authenticated` (`20260825195130_remote_schema.sql`), so each new object must revoke
  explicitly. Changing the defaults is a separate, project-wide migration.
- ~~`t05_acl.sql` cannot see PostgreSQL 17's `MAINTAIN`~~ Resolved 2026-09-25: it now checks
  effective privileges with `has_table_privilege` across every table privilege, `MAINTAIN` included.

## Roadmap to V1

V1 is **personal/private use first**; public-SaaS requirements are out of scope unless security
needs them. Status as of the audited production baseline (`d2cf720`, 2026-09-24):

- **Foundation / financial correctness**
  - **Financial Semantics Phase B.** Phase A classifies and stores a role for every transaction
    (transfer, credit-card payment, debt payment, refund, …), but no calculation reads it yet:
    spend and income are still sign-based, so card payments and transfers between your own
    accounts count as spending or income. For V1, every meaningful user-facing financial
    calculation adopts the roles, and users can correct a role (`user_role_override` exists but has
    no API or UI yet).
  - **Manual-loan balance-as-of semantics** (follow-up 1 above): design first, then implement.
- **Required V1 functionality**
  - **Linked institution management**: one backend capability, with entry points on the Accounts
    page and in Settings → Connections (the section is already reserved in `settingsSections.ts`).
    List institutions with status, account count and last sync; reconnect; and a **destructive
    remove** (V1 has no "disconnect but keep history"). Removal needs explicit confirmation, Plaid
    `/item/remove`, retry/idempotency, a deletion record, and one atomic local cleanup: restore
    manual-loan balances by their recorded applied amounts, delete accounts, transactions, splits,
    recurring streams and liability records, repair relational roles, recompute today's net-worth
    snapshot. It also covers ownership and sync-race protections, and `USER_PERMISSION_REVOKED`.
  - Reconnect stuck-state fix; user role correction; transaction pagination (the API caps a request
    at 200 rows).
- **Release hardening**
  - Service-worker update / frontend-backend version compatibility (see the release lessons above).
    Phase 1, the backend API-level contract, is described in "Frontend/backend compatibility
    contract"; phase 2 is the frontend update manager;
    then retire the legacy routes kept for stale bundles.
  - Retain terminal `exchange_unknown` attempts for about 30 days (follow-up 2 above).
  - Plaid token encryption Phase 3: confirm no plaintext tokens remain, then remove the plaintext
    fallback and column.
  - Review whether public sign-up should be disabled or gated; default-privileges migration;
    remove the obsolete Railway "frontend" service (the root `railway.json` builds the backend for
    any service built from this repository, so that service can only fail).
- **V1 UX / polish**: Settings → Dashboard section, custom date ranges, accessibility pass on the
  later features.
- **Post-V1**: mobile app; investments/portfolio tracking (Plaid Investments, holdings, cost basis;
  kept out of V1 and the initial mobile scope); multi-currency; category groups.

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

One row per `(user_id, date)`, upserted (`services/dataService.ts`'s `upsertNetWorthSnapshot`, `onConflict: 'user_id,date'`) whenever balances are actually refreshed from Plaid — initial link (`completeLinkAttempt`) and manual "Refresh balances" (`refreshAccounts`) — since that's the only time `accounts.current_balance` changes. There's no scheduled/cron snapshot yet, so a user who never clicks refresh won't accumulate history; that's a reasonable follow-up if daily granularity independent of user activity turns out to matter.

The asset/liability split (`services/netWorth.ts`'s `aggregateAssetsAndLiabilities`) is the same logic `getSpendingSummary` already used — extracted into its own pure, tested module and reused by both, rather than duplicated.

## Frontend/backend compatibility contract

An open browser tab or installed PWA window can keep running an older frontend bundle after a new
backend deploys (see the post-audit release lessons). The backend therefore publishes an API level
and refuses clients that are too old, explicitly instead of letting them misbehave
(`backend/src/middleware/clientApiLevel.ts`).

- **Request:** the client sends `X-Client-Api-Level: <integer>`. No header means a legacy client:
  level 0. A malformed value (anything but a canonical non-negative integer, including a header
  sent twice) gets **400** `{ code: 'invalid_client_api_level' }`.
- **Response:** every response on a covered route carries `X-Api-Level` and
  `X-Min-Client-Api-Level`, including 401s, 404s and 500s. CORS allows the request header and
  exposes both response headers, with the same single allowed origin as before.
- **Refusal:** a client below the minimum gets **409** `{ code: 'client_update_required' }` before
  body parsing, authentication or any handler runs, so nothing is read or written for it. Reads are
  refused too: an old client can misread a response as easily as it can send a bad write.
- **Order** (`createApp`): helmet → CORS (answers every `OPTIONS` preflight itself) → request
  logging → client-API-level check on the covered prefixes → JSON body parsing → routers (each with
  its own `requireAuth`) → error handler. The check deliberately precedes parsing, so a malformed or
  oversized body can never pre-empt it or its headers.
- **Body errors are client errors:** malformed JSON → **400** `malformed_json`; a body over the
  parser's limit (100 kB) → **413** `payload_too_large`; unsupported encoding or charset → 415;
  truncated or mis-sized bodies → 400. Messages are fixed and never quote the parser or the body.
  Every other error keeps the existing 500 behaviour.
- **Covered routes:** `/api/plaid`, `/api/budget-categories`, `/api/category-mappings`,
  `/api/manual-loans`, `/api/user-preferences` (`CLIENT_API_ROUTES` in `app.ts`). **Not covered**,
  each keeping its own checks: `/` and `/health`, `/api/webhooks` (Plaid's signed JWT), and
  preflight `OPTIONS` requests.
- **Metadata only:** a supported level never replaces authentication, session ownership, resource
  ownership or financial validation.
- **Current values:** `API_LEVEL = 1`, `MIN_CLIENT_API_LEVEL = 0`, so every existing client is
  served. They're code constants, not configuration: changing them is a reviewed release decision.
- **Release rule:** raise `API_LEVEL` when a backend change alters a request or response an older
  client depends on. Raise `MIN_CLIENT_API_LEVEL` only in a release that must refuse older clients
  (for example, when retiring the legacy routes kept for pre-contract bundles).
- **Deployment order:** Railway and Vercel don't deploy atomically. Backend support for a header
  must be live, and verified, **before** a frontend release starts sending it; otherwise the
  browser's preflight fails and every request errors. Frontends never retry a request without the
  header, or retry a mutation after a network/CORS error.

### Frontend: service-worker updates

`frontend/src/lib/appUpdate.ts` registers the service worker and decides when an open page moves
onto a new build. (It replaced vite-plugin-pwa's injected `registerSW.js`, which only registered
the worker, so an open tab kept running its old bundle indefinitely.)

- **Worker:** still `/sw.js` (same URL, so installed copies upgrade in place), Workbox
  `generateSW` with `skipWaiting` + `clientsClaim`: a new worker activates at once and takes control
  of open pages. Both are set explicitly in `vite.config.ts`, because the plugin drops them silently
  when it doesn't inject the registration itself. `npm run verify:pwa --workspace frontend` (in CI
  after the build) checks this, the missing `registerSW.js`, the completion page below, and the
  build id.
- **Update checks:** at startup, every 30 minutes, when the tab becomes visible (at most once a
  minute), when a response reports a newer `X-Api-Level`, when a lazy chunk fails to load
  (`vite:preloadError`), and every minute while an update is required. A preload error is taken
  over by the manager (`preventDefault()`, so Vite doesn't also rethrow it) and recovered through
  the same guarded reload. The app has no lazy chunks today.
- **Detecting a new build:** `controllerchange` on a page that already had a controlling worker (or
  had an active one it bypassed, e.g. after Shift+Reload). The first installation claiming a page is
  not an update.
- **When it reloads:** never while a guard is active in that tab (below). If it's safe, it reloads
  automatically within 15 s of launch or while the tab is hidden. A safe, visible tab shows
  **"A new version is ready — Reload"** instead. An update-required tab reloads as soon as it's safe
  and a newer build has actually arrived.
- **Guards** (per tab; tabs never coordinate or lock each other):
  - any non-GET request, for its whole lifecycle (session lookup, request, response, the clock-skew
    retry);
  - a Hosted Link attempt, from the click until it completes, is cancelled, fails or unmounts;
  - the Reconnect (Update Mode) flow, from the click until Link exits or the completion settles
    (`onExit` now also clears the stuck "Reconnecting..." state);
  - unsaved edits (`unsaved_edit`): the add/edit loan form, manual payment add/edit, a linked
    payment's principal, the split editor, add-category and budget amounts, credit limit, savings
    goal, the Financial Preferences numbers, account nickname, a custom emoji, and typed sign-in
    details;
  - changes applied on screen but not yet durably saved (`pending_save`). The request's own guard
    ends when the request ends, which is too early for these:
    - Financial Preferences, Safe to Spend toggles, appearance, dashboard layout and reporting
      range: held by their save tracker (`useSaveStatus`) from the edit until the latest value
      saves. A failed save keeps it until Retry succeeds or a newer change saves. Dashboard layout
      and reporting range used to fail silently; they now show "Couldn't save. Retry".
    - Navigation: held by the navigation write queue while a layout is in flight, queued behind
      another, or failed awaiting Retry.
    - Unmounting (sign-out) releases it: those changes go with the component.
- **Discarding (never automatic, never a dead end):** when only the user's own unsaved changes are
  holding an update back, the banner offers **"Discard unsaved changes and reload"**. This applies
  both when a new version is ready and when an update is required: once an update is required,
  saving is turned off, so Retry can't help. Discarded changes are lost, except an unconfirmed
  "Add loan" save, which is already persisted per user (`pendingManualLoanCreation.ts`) and is
  resumed, never auto-sent, after the reload. Discard is never offered:
  - over a mutation, Hosted Link attempt or reconnect in progress (the banner waits for those);
  - while no newer build is available. An update-required page with unsaved changes says **"the
    newer version isn't available yet"**, keeps its changes on screen and saving turned off, and
    keeps checking. Discarding would only reload the same incompatible build.
- **Reload-loop protection** (per-tab `sessionStorage`, `my-finances:update-reloads`): each update
  reload records the build it left. If the page comes back on the **same** build within 5 minutes,
  automatic reloads stop for that page until a genuinely new worker takes control. Other limits: at
  most 3 automatic reloads in 10 minutes, 30 s between automatic reloads (a user's own Reload
  doesn't count), and no automatic reload at all if the record can't be read or written. The banner
  always keeps a manual Reload.
- **Build id** (`frontend/scripts/build-id.mjs`): `VERCEL_GIT_COMMIT_SHA` (first 12 characters),
  else `VERCEL_DEPLOYMENT_ID`, else `local-<timestamp>`. None of these is secret. It's baked into
  the bundle (`<html data-app-build="…">` at runtime) and into `index.html` as
  `<meta name="app-build" content="…">`. The verifier checks that both agree, that the id has a
  valid form, and that it's the id the environment should produce (`EXPECTED_APP_BUILD_ID`
  overrides). After a Vercel deploy, confirm the deployed commit without running the app:
  `curl -s https://<frontend>/ | grep app-build`. A `local-…` id means the system variables aren't
  exposed to the build. Updates and loop protection still work (every build gets a unique id), but
  diagnostics are weaker.
- **Plaid completion page:** `/plaid-link-complete.html` is precached as itself and excluded from
  the SPA navigation fallback, with or without a query string (and in its extension-less form), so
  Hosted Link's redirect always gets the real completion page.

### Frontend: client API level

- Every app API request (`authedFetch` in `lib/api.ts`, the only caller of `fetch`) sends
  `X-Client-Api-Level: 1` (`CLIENT_API_LEVEL`). The Supabase client doesn't send it.
- Every response's `X-Api-Level` / `X-Min-Client-Api-Level` is read, strictly (a malformed value is
  ignored):
  - **`X-Api-Level` above the client's level:** check for an update (throttled); nothing is blocked.
  - **`X-Min-Client-Api-Level` above the client's level, or a 409 `client_update_required`:**
    **update required.** The banner shows **"Update required — reload to continue"**, a check runs
    now and every minute, and every new mutation is refused **before it is sent**. Reads continue
    (the backend refuses them itself). A later response putting the minimum back at or below the
    client clears the state (e.g. after a backend rollback).
- Nothing is replayed: a request refused with 409 is final. A network/CORS failure propagates
  without a retry. No request is ever re-sent without the header. A Hosted Link attempt or reconnect
  whose completion is refused ends with its error, and must be started again after the update.

### Release rules for API levels and service workers

- **Backend first.** Backend support for a header or level ships and is verified before any
  frontend sends or requires it. (Phase 1, `a8265f9`, is live, so the frontend may send level 1.)
- **Raising `MIN_CLIENT_API_LEVEL` to N** is allowed only when all of these hold:
  1. a frontend sending level ≥ N has been live in production long enough for open tabs to update;
  2. the installed-PWA check below passed on that release;
  3. it's accepted that any tab still running a build older than this update manager can't update
     itself. It will show the 409 message until the user reloads it.

  Raising it also blocks completing any Hosted Link attempt or reconnect started from an older
  client.
- **Rollback limitation:** this frontend sends `X-Client-Api-Level`. A backend rolled back to before
  `a8265f9` doesn't allow that header in CORS, so every request from this frontend would fail its
  preflight. Keep backend rollbacks at or after `a8265f9`; otherwise roll the frontend back first.
  Rolling the frontend back to a pre-update-manager build works while `MIN_CLIENT_API_LEVEL = 0`
  (open tabs reload onto it), but reinstates the stale-tab problem. After the minimum is raised, a
  frontend below it can't be rolled back to without lowering the minimum first.
- **Manual installed-PWA release check** (automation can't cover an installed app window):
  1. With the production PWA installed and open on the current build, note
     `document.documentElement.dataset.appBuild` (DevTools: Ctrl+Shift+I in the app window).
  2. Deploy the new frontend.
  3. Minimise the window for over a minute, then restore it: it should be on the new build (hidden
     and safe means an automatic reload).
  4. Repeat with a half-typed form visible: it must show "finish your current edit first" and keep
     the text.
  5. Clear the field: it must offer Reload.
- **Local two-build check:**
  1. Build twice with `VITE_UPDATE_DEBUG=1` (this exposes `window.__appUpdate`; normal builds never
     set it) and dummy `VITE_*` values.
  2. Serve the first build, open two tabs, then switch the server to the second build.
  3. Call `navigator.serviceWorker.getRegistration().then(r => r.update())`.
  4. Observe the hidden tab reloading, and a tab with a dirty form deferring.

  On Windows, give a headless browser a short profile path: Cache Storage fails under `MAX_PATH`
  and the worker never installs.

## Frontend resilience note

`App.tsx`'s `refreshAll` uses `Promise.allSettled`, not `Promise.all` — with five parallel dashboard fetches, one endpoint failing (as `net-worth-history` currently does, pending the migration above) used to reject the whole batch and leave every section on its empty initial state, silently, with only an uncaught promise rejection in the console. Now each successful fetch still updates its own section, and a single error banner (`actionError`) surfaces if anything failed — check the browser console for which endpoint, since the banner doesn't say.

## Webhooks

Plaid pushes updates to `POST /api/webhooks/plaid` instead of the app relying solely on the user manually clicking "Sync transactions"/"Refresh balances". This endpoint is intentionally **not** behind `requireAuth` — Plaid calls it directly as a server, not as a signed-in user — so authenticity is verified a different way: every delivery carries a `Plaid-Verification` header (a JWT signed with a key Plaid rotates periodically), which `backend/src/services/webhookVerification.ts` checks against Plaid's `/webhook_verification_key/get` endpoint (caching keys for 24h) and against a hash of the exact raw request body, rejecting anything that doesn't match or is older than 5 minutes. `backend/src/index.ts` captures the raw body via `express.json()`'s `verify` callback specifically so this check has the exact original bytes to hash, since the parsed `req.body` isn't guaranteed to re-serialize identically.

Two webhook types are handled (`backend/src/controllers/webhookController.ts`):
- `TRANSACTIONS` / `SYNC_UPDATES_AVAILABLE` — runs the same sync logic as the manual "Sync transactions" button (`backend/src/services/syncService.ts`, shared by both paths so they can't drift out of sync with each other).
- `ITEM` / `ERROR` with `ITEM_LOGIN_REQUIRED` — flips the item to `login_required` immediately, so the reconnect banner appears without the user having to trigger a manual refresh first.

**Enabling this**: set `BACKEND_PUBLIC_URL` on Railway to the backend's own public URL once you have it (same chicken-and-egg as `FRONTEND_URL` — deploy once first, then set it). `plaidService.createLinkToken`/`createReauthLinkToken` only pass a `webhook` URL to Plaid when this is set, so items linked before it's configured won't have a webhook registered — clicking **Refresh balances** afterward backfills it onto existing items (`plaidService.updateItemWebhook`, called best-effort inside `refreshAccounts`). Left unset in local dev, since Plaid can't deliver webhooks to `localhost`.

**Testing in Sandbox**: `POST /api/plaid/items/:itemId/sandbox-fire-webhook` (same auth/ownership/404-outside-sandbox pattern as the existing `sandbox-reset-login` route) asks Plaid to actually deliver the `SYNC_UPDATES_AVAILABLE` webhook for that item, so you can exercise the real receiver — signature verification included — rather than only trusting it in theory.

## Plaid access-token encryption

🟢 **Phase 1 + Phase 2a live in production, verified, and the V1 → V2 key rotation fully complete** — schema migration applied, dual-write/dual-read encryption running against real traffic, all 3 items encrypted under `RAILWAY_PROD_V2`, and the exposed `RAILWAY_PROD_V1` key fully removed from Railway (the app redeployed successfully running on V2 only). See §21 of `PLAID_TOKEN_ENCRYPTION_DESIGN_REVIEW.md` for the original Phase 2a production verification, §23 for the rotation/backfill/V1-removal completion record, and §25 for the exact post-soak checklist that was followed. **Phase 2b (encrypted-only writes for new items) is also done**: Codex-approved and merged to `main` as `ca05fa3` (§27 of the design doc), so newly-linked items never get a plaintext token; Hosted Link's `store_plaid_link_item` stores the encrypted token only. Full design in `PLAID_TOKEN_ENCRYPTION_DESIGN_REVIEW.md` (read that before touching any of this — this section is a pointer, not the source of truth).

**What's implemented**: `backend/src/services/tokenEncryption.ts` — AES-256-GCM, a fresh random 12-byte nonce per encryption, an AAD binding each ciphertext to its own `plaid_items.id` (so one row's ciphertext can never be decrypted as another row's), a versioned logical key ring (`PLAID_TOKEN_KEY_<ID>` env vars + `PLAID_TOKEN_CURRENT_KEY_ID`), and a family of typed errors (`PlaidCredentialError` and its subclasses) with fixed, non-sensitive messages. `dataService.ts`'s four Plaid-item functions are the *only* place any of this is encryption-aware (§6.1 of the design doc) — every other consumer (`plaidService.ts`, `syncService.ts`, `loans.ts`, every controller) still just receives a plain decrypted string, unchanged. New items are written with **both** the plaintext and the encrypted representation together (Phase 2a, a deliberately brief dual-write kept only for initial rollback safety — see the design doc §7); existing/updated items are read via dual-read, preferring the encrypted representation whenever present and never falling back to plaintext if decryption fails (the fail-closed rule, §8).

**A real correctness issue found and fixed during implementation, not anticipated by the design doc**: `getPlaidItemsForUser` returns every one of a user's items in one batch call, then `refreshAccounts`/`syncTransactions` loop over them with a per-item `try/catch` meant to isolate one item's failure from the rest (the same way an item needing re-auth today doesn't break refreshing everyone else's accounts). Resolving every token eagerly inside that one batch call would mean a single undecryptable row aborting the *entire* batch before the per-item loop even started — silently defeating that isolation for every other item too. Fixed by making `access_token` a lazy, memoized getter on each returned item: decryption only happens (and can only fail) at the point something actually reads that specific item's token, which is always inside the existing per-item `try/catch`.

**Status values**: a new `'credential_error'` status (`plaid_items.status`), distinct from `'login_required'` — set when this app fails to decrypt/read a stored credential, never when Plaid itself rejects it. The Accounts tab shows a plain, blame-free message for it with no reconnect button (reconnecting can't fix a local decryption failure, and offering it would misleadingly suggest the bank connection itself is the problem).

**Tests**: `tokenEncryption.test.ts` (22 tests — round-trip, nonce uniqueness, tamper detection, AAD/key/key-id mismatches, malformed input, startup key validation, no-secret-in-error-messages), `dataService.test.ts` (11 new tests covering dual-write, dual-read preferring encryption over stale plaintext, the fail-closed rule, and the per-item isolation fix above), `webhookController.test.ts` (new file, 4 tests covering the async webhook path's credential-error handling specifically, since it's fire-and-forget relative to the HTTP response).

**Done**: the Phase 1 migration is applied to production Supabase; Phase 2a is deployed and live-verified (§21); the two originally plaintext-only items were backfilled and, along with the third item, rotated from `RAILWAY_PROD_V1` to `RAILWAY_PROD_V2` after V1 was accidentally exposed (§23) — all 3 rows encrypted under V2, plaintext still present on all 3 (Phase 2a dual-write unchanged by the rotation), zero anomalies. Two purpose-built, Codex-audited one-off scripts did this work: `backend/src/scripts/rotateTartanTokenKey.ts` and a retargeted `backend/src/scripts/backfillTokenEncryption.ts` — both inert (never imported by the running server, guarded by `require.main === module`). **`RAILWAY_PROD_V1` has since been fully removed from Railway** (§25), confirmed via a clean redeploy running on V2 alone.

**Not yet done (Phase 3, release hardening)**: items linked before Phase 2b may still carry their plaintext `access_token`, and the read path keeps its explicit legacy plaintext-only fallback (`dataService.ts`). Before removing either, confirm with a read-only production query which rows still hold plaintext; then clear it, remove the fallback, and finally drop the column. See "Roadmap to V1".
