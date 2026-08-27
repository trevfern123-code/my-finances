# My Finances — Development Handoff for Independent Review
**Prepared for**: an independent senior AI/software reviewer (Gemini), by Claude (Anthropic), at the request of the project owner (Trevor).
**Covers**: all work completed 2026-08-25, verified directly against the Git repository at `C:\Users\Trevor\OneDrive\Documents\My finances` (all timestamps below are Git-authoritative; a few of this session's own memory notes mislabeled some of today's work as "2026-08-26" — that is a documentation typo on the assistant's part, not a real date. Every commit referenced here is timestamped 2026-08-25 in `git log`).

**A note on evidence**: every factual claim below was checked against one of: `git log`/`git show --stat`, the actual current file contents, a fresh `npm run test`/`typecheck`/`build` run, or a migration file's SQL. Where a claim instead rests on this session's own prior live-browser verification (not something re-run for this report) or on judgment/inference, it is labeled as such. Nothing here should be taken as independently re-verified by a third party — that is exactly what this handoff is for.

---

## 1. Starting point (state at the end of 2026-08-24, before today's work)

The app was a working, single-user personal finance dashboard: Express+TypeScript backend, React+Vite+TypeScript PWA frontend, Supabase (Postgres+Auth+RLS), Plaid (Transactions Sync, Recurring Transactions, Liabilities, Investments). Seven tabs existed and were considered feature-complete after a full UI/UX polish pass the night before: Overview, Monthly Breakdown, Budget, Subscriptions & Recurring, Loans, Income & Savings, Accounts. Net-worth-over-time tracking, manual loan entry with payment ledgers, and an Overview "command center" redesign were all already shipped.

Known technical debt going into today (per an outside-AI handoff report Trevor had commissioned and reviewed the same day, described in this session's own project memory): **no tracked database migrations** (schema changes had been applied ad hoc with nothing committed to the repo), **raw-float money math** with no rounding discipline, **zero frontend tests** and no CI pipeline at all, a **monolithic `App.tsx`** with all dashboard state and fetch logic in one component, and a duplicated-formatting/date-helper problem scattered across components. Trevor's explicit direction: keep shipping product, but work through this debt in priority order, folded into ongoing feature work rather than as a standalone rewrite.

A known pre-existing bug was also carried in: an intermittent "JWT issued at future" 500 error caused by local clock skew against Supabase's JWT validation (mitigated, not eliminated, before today — see §5/§9).

---

## 2. Everything completed today (chronological)

Git shows **24 commits** on 2026-08-25, from `4dbf91e` (07:41) through `b0e9e4e` (20:38). They fall into two phases: early-morning feature work (07:41–09:37, 4 commits, not part of the technical-debt/personalization initiative), then the technical-debt-and-personalization arc the rest of the day (11:17–20:38, 20 commits) that this handoff focuses on most closely.

### 2.0 Early-morning feature work (pre-dates the technical-debt initiative)

- **`4dbf91e` Category Mapping** — auto-categorizes future synced transactions by Plaid's own category, mapping each Plaid category to one user budget category, with an "apply to existing transactions" backfill action. New `category_mappings` table/controller/route, `CategoryMappings.tsx` settings UI. 522 insertions across 15 files.
- **`8c57127` Transaction Splitting** — divide one transaction's amount across multiple budget categories. New `transaction_splits` table, `SplitEditor.tsx`, validation logic. 626 insertions across 11 files.
- **`80d6671` crash fix** — a one-line fix aliasing `transaction_splits` to `splits` in a Supabase query that had just broken the transactions endpoint (introduced by the previous commit, caught and fixed same session).
- **`2c20d36` drill-downs + collapse toggle** — click-through from Monthly Breakdown/Budget category totals down to the underlying transactions; a collapse toggle on the Transactions feed. New `lib/budgetDrilldown.ts`.

*(Verification note: these four commits are described here from commit messages and diff stats only — they predate the detailed live-verification narrative captured in this session's memory, which begins at the CI/migrations work below.)*

### 2.1 Foundation / engineering debt (11:17–13:34)

**Problem**: the technical debt listed in §1 — no migration tracking, no CI, float money math, zero frontend tests, monolithic App.tsx, no verified production schema.

- **`a9a8e66` CI workflow + migration tracking scaffolding.** Added `.github/workflows/ci.yml` (backend+frontend typecheck/test/build on every push/PR to `main`), `supabase/config.toml`, `supabase/SCHEMA_NOTES.md` (a hand-reconstructed schema doc, later verified against the real thing — see below).
- **`517988c` Money precision + frontend testing bootstrap.** Added `roundToCents()` as two independent, deliberately-not-shared helpers (`backend/src/services/money.ts`, `frontend/src/lib/money.ts`), applied only where a *computed* money value is written (manual-loan balance adjustments, net-worth snapshots, transaction-split validation — replacing an old ad hoc 1-cent tolerance with exact rounded-equality comparison). Display-only aggregations were deliberately left unrounded-at-source (recomputed fresh every request, no compounding-drift risk). Also stood up Vitest for the frontend for the first time (`frontend/vitest.config.ts`) and wrote the first frontend tests (`budgetDrilldown.test.ts`, `money.test.ts`, `recurringDates.test.ts`, `splitValidation.test.ts`). **Currency**: confirmed every aggregation (net worth, budget spend, monthly breakdown, Safe to Spend) sums raw amounts with no currency-code check, documented as a deliberate USD-only assumption in the README rather than an oversight (`PLAID_COUNTRY_CODES=US`); `iso_currency_code` is still preserved on every record for future use.
- **`3195ae9` Real production schema pull + reconciliation.** `npx supabase db pull` was run from a separate clone outside the OneDrive-synced directory (the synced repo's `supabase/.temp` had sync conflicts with the Supabase CLI). The pulled file, `supabase/migrations/20260825195130_remote_schema.sql` (**verified: 367 lines, 18KB**), was copied in as the authoritative baseline. `SCHEMA_NOTES.md` was reconciled against it, surfacing three things code-reading alone hadn't: (1) `budget_categories.name` had a database-wide unique constraint, not scoped per user (later fixed — see Budget Customization below); (2) exact RLS/policy status per table, confirmed rather than guessed (see §8); (3) `transactions.amount`/`accounts.current_balance`/`accounts.available_balance`/`budget_categories.budget_amount` were already `numeric(12,2)`/`numeric(10,2)` at the schema level.
- **`e848417` More frontend test coverage.** `assets.test.ts`, `monthlyBreakdownDrilldown.test.ts` (extracted `transactionsForMonthCategory` out of the component), `upcomingItems.test.ts` (gained a deterministic `today` override param).
- **`3b45391` CSS token consolidation.** Found and fixed 8 hardcoded color literals bypassing the existing `:root` custom-property system, consolidating into `--text-on-accent`/`--text-on-warn`/`--info-hover`/RGB triplets. Visually byte-identical before/after — groundwork for Appearance v1, not a redesign.

**Verified today**: `npm run test`/`typecheck`/`build` for both workspaces, CI green in the GitHub Actions UI (per session memory — not re-checked for this report). **Outcome**: all five foundation items from the outside-AI report's priority list (migrations, CI, money precision, currency audit, frontend testing) were substantively addressed same-day; CSS tokens were addressed for the color half only (a spacing-scale token pass was explicitly deferred as its own larger task).

### 2.2 Dashboard Customization v1 (13:34, commit `d106c12`)

- **Problem**: Trevor wanted the Overview tab's 8 cards to be personalizable (show/hide, reorder, presets) as the first of several planned customization features, without over-building before validating the pattern.
- **Implementation**: show/hide + up/down reorder for all 8 cards; 4 presets (Standard/Budget Focus/Net Worth Focus/Minimal) that apply a layout snapshot, not a locked mode; auto-save on every toggle/reorder/preset click (no Save/Cancel staging); a "Done" control that only closes the editor UI.
- **Architecture decision**: this was the **first real extraction** of business logic out of `App.tsx` — `hooks/useDashboardLayout.ts` (state + persistence) + `lib/dashboardLayout.ts` (pure layout logic, including a `mergeDashboardLayout` function that forward-compatibly appends any card unknown to a saved layout at the end, visible by default, rather than hiding a future new card forever). This became the template every subsequent preference hook followed.
- **Schema**: new `user_preferences` table — `user_id` (PK), `dashboard_layout jsonb`, `created_at`, `updated_at`. Migration: `20260825210000_create_user_preferences.sql` (verified, 12 lines).
- **API**: `GET /api/user-preferences`, `PUT /api/user-preferences/dashboard-layout`.
- **Frontend**: `DashboardCustomizer.tsx` (the editor UI), `dashboardLayout.test.ts` (158 lines of tests).
- **Live verification** (per session memory): Trevor confirmed the interactive behavior himself in-browser; drag-and-drop was explicitly not implemented (up/down arrows only, a deliberate scope cut).
- **Outcome**: shipped, fully verified, no known issues.

### 2.3 Appearance v1 (14:10–14:47, commits `226a49f`, `ec2b8aa`)

- **Problem**: System/Light/Dark theme + accent color personalization, the second item on Trevor's stated customization-priority list.
- **Implementation**: System (default, no `data-theme` attribute, relies on `@media (prefers-color-scheme)`) / Light / Dark; 6 curated accent presets (Green/Blue/Teal/Indigo/Purple/Amber), each a `[data-accent="..."]` CSS block defining its own `--accent`/`--accent-strong`/`--accent-rgb` trio.
- **A real, substantial semantic-color audit was done as part of this**, not scoped separately: every existing `--accent`/`--accent-strong` usage in `App.css` was individually reclassified as "brand" (stays on accent) vs. "financial meaning" (10 call sites moved to a new `--positive`/`--positive-rgb` token — stat deltas, Safe to Spend figure, split-balanced indicator, income bars/totals, etc.), so that changing your accent color can never make a financial good/bad signal ambiguous. `--warn` was similarly split into a theme-dependent and a theme-independent (`--warn-strong`) variant.
- **Architecture**: `lib/theme.ts` (pure preset/validation logic) + `hooks/useAppearance.ts` — this hook introduced a **localStorage pre-paint cache** (read synchronously in an inline `<script>` in `index.html` before React mounts, applied immediately, then reconciled against the server value once fetched) specifically to prevent a flash-of-wrong-theme on load — the one hook in this app that legitimately needs that mechanism (numeric preferences added later deliberately do not use it — see §4).
- **Schema**: two columns on `user_preferences` (`theme text default 'system'`, `accent_color text default 'green'`). Migration `20260825230000_add_appearance_preferences.sql` (11 lines).
- **API**: `PUT /api/user-preferences/appearance`.
- **A follow-up same-day pass (`ec2b8aa`) expanded accent coverage** to nav tabs, link-buttons, focus rings, reorder/emoji-picker hover states, and the neutral chart-bar fill — after Trevor felt v1's first cut only touched a handful of elements. Caught a latent miss in the same pass: the Net Worth chart's default line color was still on the now-being-retired `--info` token even though it should have followed `--positive`/`--danger` like everything else; fixed, and `--info`/`--info-hover` were removed entirely since nothing used them afterward.
- **Live verification** (per session memory): all 3 themes × all 6 accents in-browser (persistence confirmed end-to-end via a raw `GET /api/user-preferences` check, not just the UI), and specifically confirmed financial-semantic colors stay visually constant across every accent while brand UI correctly shifts.
- **Outcome**: shipped, fully verified, no known issues. A follow-up hardening pass later the same day (§2.6) fixed two contrast shortfalls found during an accessibility audit of this feature (see §7).

### 2.4 Budget Customization v1 (15:35, commit `f276191`)

- **Problem**: category color, icon, and a real archive workflow to replace an old unguarded hard-delete that could throw a raw foreign-key-violation error if a category had any transaction history.
- **Implementation**: 10 curated color swatches (`lib/categoryColors.ts` — deliberately excludes red/orange/amber/green so a color dot is never mistaken for a semantic status signal); a broadened ~70-option curated emoji picker plus free-paste custom-emoji input; archive/unarchive replacing hard-delete.
- **Archive semantics** (verified live, per session memory): archiving removes any `category_mappings` row targeting the category (new synced transactions revert to "Unmapped") but never touches `transactions.budget_category_id` or `transaction_splits` — historical attribution is preserved. Unarchiving restores the category exactly but does not recreate the removed mapping (a deliberate choice).
- **Schema/correctness fix bundled in**: `budget_categories.name`'s pre-existing database-wide unique constraint (flagged during the schema reconciliation above) was replaced with a per-user, **active-only** unique index — closing a real second-user-readiness gap. Migration `20260826000000_budget_category_archiving.sql` (21 lines — note the filename says "0826" though the commit is Git-timestamped 08-25, a naming-convention artifact, not a date error).
- **Two category-list views were formalized**: active-only (anything that budgets/selects going forward: the Budget tab, Safe to Spend/Cash Flow Pace math, mapping dropdowns) vs. full-list (anything resolving a possibly-archived category historically: the transaction feed, split editor). `lib/categoryLabels.ts`'s `selectableCategories()`/`budgetCategoryLabel()` centralize this rule.
- **Live verification** (per session memory): archived a real category with $531 of spend, one split, and one active mapping — confirmed the mapping reverted, historical labels stayed correct with an "(archived)" suffix, split editors behaved correctly for old vs. new rows; verified the new per-user-active-unique constraint by creating a same-named active category alongside an archived one (succeeded) and attempting to unarchive into a name collision (failed cleanly with a surfaced error, no data corruption).
- **Outcome**: shipped, fully verified. A same-day follow-up (`6294bbb`, 17:19) extracted the reorder logic this feature shared with account ordering into `lib/reorder.ts`, and in writing tests for it, found and fixed a real bug in the emoji picker's custom-emoji validation (an 8-UTF-16-code-unit length cap was rejecting legitimate multi-codepoint emoji it claimed to support — e.g. a 4-person family ZWJ sequence needs 11; raised to 16).

### 2.5 Account Customization v1 (17:04, commit `7ec5aeb`)

- **Problem**: nickname/color/icon/ordering personalization for linked accounts, plus a way to exclude an account from specific calculations without deleting or unlinking it.
- **Implementation**: nickname (`accountDisplayName()` = `nickname ?? name`, used everywhere an account name renders), icon+color (the same `EmojiPicker`/`ColorPicker` components from Budget Customization, extracted into shared files), manual ordering, a display-only `hidden` flag, and **two independent exclusion flags** — `exclude_from_net_worth` (balance-based: net worth stat, net-worth chart, liquid cash) and `exclude_from_cash_flow` (transaction/recurring-stream-based: Monthly Spending, Monthly Breakdown, Budget spend, Cash Flow Pace, Savings Rate, Upcoming Bills). Individual transactions always stay visible in the feed regardless of either flag.
- **A real bug was caught and fixed during live verification, before sign-off**: the first implementation had the assets-summary aggregation function drop `hidden` accounts from its bucket *total*, not just its display list — since that same function also backs Safe to Spend's Liquid Cash figure, hiding an account was silently reducing Liquid Cash, violating "hidden must never affect a calculation." Fixed by filtering `hidden` only at the display layer, never inside the shared aggregation function.
- **Schema**: `nickname`, `color`, `icon`, `sort_order`, `hidden`, `exclude_from_net_worth`, `exclude_from_cash_flow` columns on `accounts`. Migration `20260826010000_account_customization.sql` (21 lines).
- **Live verification** (per session memory): each exclusion flag tested independently and in combination (hidden-only, net-worth-only, cash-flow-only, all three together on one account); confirmed excluding a credit card's cash flow dropped Budget spend by exactly its transaction total and removed a bill from Upcoming Bills while net worth stayed untouched (and the reverse for net-worth exclusion); confirmed a net-worth-exclusion toggle immediately re-triggers a net-worth snapshot (`recordSnapshotForUser`), verified via the raw history endpoint showing only today's row changed; confirmed customizations survive a real Plaid balance refresh (`upsertAccountsForItem`) unchanged.
- **Outcome**: shipped, fully verified, one real bug caught and fixed pre-sign-off.

### 2.6 Post-launch hardening pass (17:19–18:23, commits `6294bbb` through `39658b0`)

Done autonomously per Trevor's ordered priority list (test-gap review → accessibility/mobile audit → CI deprecation → low-risk cleanup → docs):

- **`6294bbb`** — reorder-logic extraction + emoji-length-cap bug fix (see §2.4).
- **`e086cd4`** — accessibility/mobile fixes: a reorder button under the WCAG 2.5.8 24×24px minimum touch target, a category-name label that could shrink to ~3px on narrow viewports, and account-exclusion checkboxes with no visible keyboard-focus indicator. All three fixed with small, scoped CSS changes (see §7).
- **`f3a5fd9`** — bumped `actions/checkout`/`actions/setup-node` from `@v4`→`@v5` to resolve a GitHub Actions Node-20-runtime deprecation warning (the Node version the *Actions themselves* run in, unrelated to this project's own `node-version: 20` build target, which was deliberately left alone — **verified**: `package.json`'s `engines.node` is still `>=20.0.0`).
- **`5018e06`** — README documentation of the pass.
- **`cfcfb11`** — extracted `formatCurrency`/`formatCurrencyWhole` into `lib/currency.ts`, removing **12 independently-duplicated definitions** across component files (**verified**: `AccountQuickView`, `BudgetCategories`, `CashFlowPace`, `IncomeSavings`, `LoanProgress`, `MonthlyBreakdown`, `MonthlySpendingChart`, `NetWorthChart`, `OverviewStats`, `SafeToSpend`, `SplitEditor`, `SubscriptionsRecurring`, `UpcomingBills` all touched in this one commit).
- **`39658b0`** — README documentation of the extraction.

### 2.7 Accessibility contrast fixes (18:47, commit `1df2086`)

Two WCAG AA shortfalls flagged (not fixed) by the hardening-pass audit above were fixed once Trevor decided to proceed: light-mode Green accent (`#059669`→`#047857`, 3.44→5.01:1 against the worst-case surface) and Teal accent (`#0d9488`→`#0f766e`, 3.42→5.00:1), plus light-mode `--text-muted` (`#64748b`→`#60708a`, verified specifically against `--surface-raised`, not just `--bg`, after an initial candidate passed against one surface but failed against the other). Dark theme and both accents' solid-fill variants were confirmed already compliant and left untouched.

### 2.8 Financial Preferences v1 (19:17, commit `510699b`)

- **Problem**: let users tune four calculation inputs that were previously hardcoded, without touching underlying account/budget/transaction data.
- **Implementation**: minimum cash buffer (dollar amount, default $0, ≥0), upcoming-bills look-ahead window (1–90 days, default 14, shared by Upcoming Bills and Safe to Spend), recent-average comparison window (1–12 months, default 2, drives the Budget tab's "recent avg" label), savings-rate target (0–100%, default 15%, changes only the target/tier shown against the already-calculated rate — deliberately kept separate from the pre-existing per-account `savings_goal` dollar target).
- **Schema**: 4 columns on `user_preferences` (`minimum_cash_buffer numeric(12,2)`, `upcoming_bills_days integer`, `recent_avg_months integer`, `savings_rate_target numeric(5,2)`), each with a `check` constraint matching its validated range. Migration `20260826020000_financial_preferences.sql` (20 lines).
- **API**: `PUT /api/user-preferences/financial`.
- **Frontend**: `lib/financialPreferences.ts` (pure clamp/validation), `hooks/useFinancialPreferences.ts`, `FinancialPreferencesSettings.tsx`.
- **A real bug was found and fixed during verification, not before**: the hook's first version hydrated its state by mutating a `useRef` flag directly in the render body instead of inside a `useEffect`. This is a genuine React anti-pattern — it worked on the very first paint, but React's dev-mode double-render could run that branch on a throwaway pass whose `setState` never reached the committed render, so the preference **silently reverted to its default on every page reload** even though the ref itself correctly read "hydrated." The symptom only appeared when testing reload-persistence specifically, not the in-session live-update path (which was never buggy). Root-caused with layered `console.log`s rather than guessed at; fixed by moving hydration into a `useEffect`, matching the already-proven `useAppearance` pattern. This exact fix pattern was then correctly applied from the start in the two subsequent preference hooks (`useReportingRange.ts` never had this bug).
- **Live verification** (per session memory): set a custom 7-day bills window + $200 buffer together, confirmed Safe to Spend's breakdown reconciled exactly to the cent; confirmed defaults preserved byte-for-byte for an untouched account; confirmed the reload-persistence fix.
- **Outcome**: shipped, fully verified, one real hydration bug found and fixed during verification.

### 2.9 Safe to Spend Customization v1 (20:07, commit `fbc23d4`)

- **Problem**: Trevor asked for a written proposal analyzing the exact current Safe to Spend formula and double-counting risks *before* any implementation (a proposal-then-approval pattern used for this and the next feature). He approved a specific smallest-useful scope, explicitly deferring credit-card-full-balance obligations and savings-goal-contribution modeling as too risky/underspecified for v1.
- **Implementation**: two toggles (`safe_to_spend_include_upcoming_bills`, `safe_to_spend_include_remaining_budget`), both default `true`; credit-card minimum payments broken into their own breakdown line, structurally guaranteed not to double-count against the generic "Upcoming bills" line (`splitUpcomingTotals` sums each `UpcomingItem` into exactly one of two totals, never both — the split is enforced by a discriminated `kind` field, not by convention). Every disabled component renders as `$0` with a muted "— Not included" label rather than being hidden, per an explicit transparency requirement.
- **A real pre-existing bug was found and fixed, at Trevor's explicit request**: `getLoansForUser` never filtered by `exclude_from_cash_flow`, unlike the equivalent recurring-streams function — a loan's minimum payment could keep counting toward Safe to Spend even after its account was flagged excluded from cash flow. Fixed identically to the recurring-streams pattern, with regression tests for both the exclusion case and the "loan with no linked account" edge case.
- **Schema**: 2 boolean columns on `user_preferences`, both default `true`. Migration `20260826030000_safe_to_spend_customization.sql` (6 lines).
- **Live verification** (per session memory): all four toggle combinations reconciled exactly; combined with a nonzero buffer and a custom bills window (`$640 − $500 − $0 − $300 = −$160.00`, exact); the cash-flow-exclusion fix verified via direct API calls (flagged a sandbox credit-card account, confirmed `/api/plaid/loans` dropped from 3 to 2 entries, then reversed it) — chosen specifically because the sandbox credit card's due date was too stale to prove the fix through a dollar-amount change alone. One verification-process mistake was caught and corrected mid-pass: a browser-automation `form_input` call had set a checkbox's DOM `checked` property without firing the event React's `onChange` listens for, so the checkbox looked toggled on screen while the underlying preference silently never changed — caught by cross-checking the calculated Safe to Spend figure rather than trusting the checkbox's visual state.
- **Outcome**: shipped, fully verified, one real pre-existing bug found and fixed, one real credit-card-minimum-payment scenario left verifiable only via unit tests (the sandbox data has no credit-type loan with a near-term due date — see §6).

### 2.10 Date-Range Customization v1 (20:38, commit `b0e9e4e`)

- **Problem**: same proposal-then-approval pattern as above, this time analyzing the app's date-range architecture. Trevor approved: one shared reporting-range preference for the three historical/trend widgets that already shared one hardcoded "N months" concept, explicitly kept independent from Safe to Spend, Cash Flow Pace, the Budget tab's recent-average window, and the Transactions feed.
- **Implementation**: `reporting_range` (`this_month | last_month | last_3_months | last_6_months | last_12_months`, default `last_6_months`) drives Monthly Breakdown, the Overview spending chart, and the Net Worth chart, via a shared horizontally-scrollable pill selector rendered in both places (one state, can't drift). `this_month`/`last_month` reuse the pre-existing `getCurrentMonthRange`/`getRecentMonthsRange(1)` (true bounded periods); the three rolling presets reuse the pre-existing `getMonthsAgoStart` (open-ended through today, preserving the existing "current month is the still-filling-in most-recent bar" chart behavior unchanged).
- **Backward compatibility**: the three affected endpoints (`/summary`, `/monthly-breakdown`, `/net-worth-history`) gained an optional `range_id` query param; the legacy `months` param (default 6) is preserved as an unconditional fallback whenever `range_id` is absent or unrecognized.
- **A real correctness gap was found and fixed, exactly per Trevor's explicit instruction** ("fix wherever it represents a real correctness issue... do not blindly make every metric follow the reporting range"): Cash Flow Pace and Income & Savings' Savings Rate card used to derive "current month" by reading the *last bucket* of a 6-months-back array — a coincidence, not a query. The new `last_month` preset would have silently broken this (that preset's array deliberately excludes the current month entirely). Fixed by having `GET /api/plaid/summary` always separately compute an explicit `current_month: { income, spent }` field via its own current-month-bounded query, fully decoupled from whatever historical range was requested.
- **Schema**: 1 column on `user_preferences` (`reporting_range text default 'last_6_months'`, check-constrained to the 5 valid ids). Migration `20260826040000_reporting_range.sql` (10 lines).
- **API/architecture groundwork for later**: `getRecentTransactionsForUser` and the transactions endpoint gained optional, additive `start`/`end` (inclusive) query params — not wired to any UI, deliberately, since the Transactions feed stays independent of this feature — so a future drill-down/date-picker has real server-side range filtering instead of client-side-filtering an already-fetched, 200-row-capped array.
- **Live verification** (per session memory): all 5 presets individually; confirmed the three range-following widgets update together and stay in sync across tabs; confirmed Safe to Spend/Cash Flow Pace/Budget's recent-average/Upcoming Bills stayed unchanged across every switch; confirmed the `last_month` case specifically proved the current-month fix (Monthly Breakdown correctly showed July-only data while Cash Flow Pace and Savings Rate kept showing the real current month, August, matching what `this_month` independently produced); confirmed persistence through reload, including one deliberate, harmless double-fetch on initial load for a saved non-default value.
- **Outcome**: shipped, fully verified, one real correctness gap found and fixed.

---

## 3. Database migrations completed today

All 8 migration files below live in `supabase/migrations/` and are committed to Git (**verified**: `ls` output cross-checked against the commit list). None have been rolled back or superseded.

| Migration file | Table(s) | What changed | Backward compatible? |
|---|---|---|---|
| `20260825195130_remote_schema.sql` (367 lines) | all 11 app tables | The real, `supabase db pull`-verified production schema baseline, replacing a hand-reconstructed doc. Not a change to the live database — a *record* of what was already there. | N/A (baseline) |
| `20260825210000_create_user_preferences.sql` | new `user_preferences` | `user_id` PK, `dashboard_layout jsonb`, timestamps | Yes — new table |
| `20260825230000_add_appearance_preferences.sql` | `user_preferences` | + `theme text`, `accent_color text`, both `not null default` + check constraints | Yes — additive, defaulted |
| `20260826000000_budget_category_archiving.sql` | `budget_categories` | Replaced a database-wide unique constraint on `name` with a per-user, active-only unique index | Yes for existing single-user data; this is the fix for a real multi-user readiness gap |
| `20260826010000_account_customization.sql` | `accounts` | + `nickname`, `color`, `icon`, `sort_order`, `hidden`, `exclude_from_net_worth`, `exclude_from_cash_flow` | Yes — additive, defaulted |
| `20260826020000_financial_preferences.sql` | `user_preferences` | + `minimum_cash_buffer`, `upcoming_bills_days`, `recent_avg_months`, `savings_rate_target`, each with a range check constraint | Yes — additive, defaulted to pre-existing hardcoded values |
| `20260826030000_safe_to_spend_customization.sql` | `user_preferences` | + `safe_to_spend_include_upcoming_bills`, `safe_to_spend_include_remaining_budget`, both boolean default `true` | Yes — additive, defaults preserve prior behavior exactly |
| `20260826040000_reporting_range.sql` | `user_preferences` | + `reporting_range text default 'last_6_months'` + check constraint | Yes — additive, defaults preserve prior hardcoded behavior exactly |

*(Naming note: the last 6 filenames say "20260826" though every commit is Git-timestamped 2026-08-25 — a migration-naming-convention quirk from this session, not evidence of work actually happening on a different date.)*

**Migration tracking state, as of tonight**: every schema change from `20260825210000` onward went through the same discipline — a new migration file committed alongside the feature, SQL handed to Trevor to paste by hand into Supabase (this project does **not** use `supabase db push` for auto-apply), confirmed applied before any schema-dependent live verification proceeded. This is a real, working process, not just an aspiration — 7 migrations were successfully applied this way today.

**One known, explicitly-flagged gap remains**: when the baseline `db pull` first ran, Trevor declined the CLI's offer to update the remote migration-history bookkeeping table (`supabase_migrations.schema_migrations`), so Supabase's own record of "what's applied" does not yet include the baseline or the `user_preferences` migration — even though both are genuinely live. This session's standing instruction is to **never** reconcile that as a side effect of unrelated feature work; it needs its own dedicated pass (likely `supabase migration repair`) before `supabase db push` can be trusted as the normal apply path. Until then, the hand-paste-and-commit workflow above is the correct and only-safe way to apply schema changes to this project.

---

## 4. Architecture changes

**Movement of logic out of React components.** Before today, `App.tsx` held essentially all dashboard state and fetch orchestration directly. Today established (and then repeated 6 times) a consistent three-layer pattern:
1. A **pure, framework-agnostic module** in `lib/` — validation, clamping, formula computation, date-range resolution — fully unit-testable without rendering anything.
2. A **thin React hook** in `hooks/` — owns state + persistence (a `useEffect`-based hydrate-once from a fetched value, then an auto-save `set*` function), nothing else.
3. **Presentational components** that receive already-computed values as props and know nothing about where they came from.

This exact shape now backs Dashboard layout, Appearance, Financial Preferences, and Reporting Range (`useDashboardLayout`/`dashboardLayout.ts`, `useAppearance`/`theme.ts`, `useFinancialPreferences`/`financialPreferences.ts`+`safeToSpend.ts`, `useReportingRange`/`reportingRange.ts`). It is now the established template for any future preference, not something reinvented each time.

**Preference storage strategy**: one `user_preferences` table, one row per user, with a **dedicated column per simple scalar preference** (theme, accent_color, minimum_cash_buffer, reporting_range, etc.) rather than a single growing JSON blob — the one exception is `dashboard_layout jsonb`, deliberately chosen because a card-visibility/order list is genuinely structured, variable-length data, not a scalar. This is a considered, consistently-applied rule, not an accident — verified by inspecting every migration added today, all of which add plain typed columns with check constraints rather than touching the JSONB column.

**How user-owned customization fields are protected from Plaid refreshes**: `upsertAccountsForItem` (the function that writes fresh Plaid balance data) only ever sets Plaid-sourced columns; it was never given the customization columns to write, so a "refresh balances" call cannot clobber nickname/color/icon/hidden/exclusion flags by construction, not by a defensive check. This was explicitly live-verified for Account Customization (§2.5).

**How financial inclusion/exclusion rules are implemented**: two independent boolean flags per account (`exclude_from_net_worth`, `exclude_from_cash_flow`) are read at the point each calculation aggregates data, not baked into a single "is this account active" flag — this is what let the two flags be verified as genuinely orthogonal (see §2.5) rather than accidentally coupled. The Safe to Spend toggles and the account-exclusion flags are two separate, deliberately non-overlapping mechanisms: exclusion flags decide *whether an account's data enters an aggregate at all*; the Safe to Spend toggles decide *whether an already-computed aggregate line is subtracted in the final formula*.

**Mobile/React Native readiness — assessment**: today's work makes this **meaningfully easier**, though nothing mobile-specific was built. The pure `lib/` modules (formula math, date-range resolution, validation/clamping) have zero DOM/React dependency and would port to a React Native or any other client unchanged — that was an explicit design goal of the extraction pattern, not a side effect. The backend API is already the sole source of truth (no logic lives only in the browser that a mobile client would need to reimplement), and today's `range_id`/`start`/`end` additions specifically anticipated needs a future client would have. What is **not** yet true: no mobile client exists, no design system/component library separate from these specific React components exists, and the hooks layer (React-specific) would still need a React Native equivalent rewritten per platform — the pure-logic layer is reusable, the hook/component layers are not.

**Backend organization**: `dataService.ts` grew from 1,198 lines (as of this morning) to **1,433 lines** (verified via `wc -l`) — still one large file covering ~9+ domains, not yet split, tracked as ongoing debt (§9). `App.tsx` is **953 lines** (verified) — smaller than it would otherwise be given today's 6 new preference systems, specifically because each one only added a hook call + prop-passing to `App.tsx`, with the actual logic living in the extracted layers described above.

---

## 5. Financial correctness

**Monetary precision strategy**: `roundToCents()` (two independent copies, backend and frontend) applied only at points that *write* a computed value — not applied to every display-time aggregation, which are recomputed fresh from stored `numeric(12,2)`/`numeric(10,2)` values on every request (no compounding drift risk because nothing is accumulated across requests).

**Account exclusions**: `exclude_from_net_worth` and `exclude_from_cash_flow` are read independently at each calculation site (§4) — verified today (for Account Customization) that they affect disjoint sets of figures and that a transaction always stays visible in the feed regardless of either flag.

**Safe to Spend formula, as it stands tonight**:
```
safeToSpend = liquidCash
            − (includeUpcomingBills ? upcomingBillsTotal + creditCardMinimumsTotal : 0)
            − (includeRemainingBudget ? remainingBudget : 0)
            − minimumCashBuffer
```
where `upcomingBillsTotal` and `creditCardMinimumsTotal` are guaranteed disjoint (each `UpcomingItem` is tagged with exactly one `kind`, summed into exactly one of the two totals — this is enforced by a discriminated-union field, not by a convention that could silently be violated later).

**Credit-card minimum handling**: only Plaid-reported `loan_type: 'credit'` liabilities with both a `minimum_payment_amount` and a `next_payment_due_date` inside the look-ahead window are counted, and only their *minimum* payment — not the full statement balance. This was a deliberate v1 scope decision (see §12), specifically to avoid a real double-counting risk: a card's full balance mixes new charges (which may already be reducing "remaining budget" headroom if categorized) with any carried debt, and Plaid's data doesn't cleanly separate the two.

**Upcoming bills / minimum cash buffer**: both are already-existing, previously-verified mechanisms (Financial Preferences v1, §2.8), unchanged in meaning today beyond the loan cash-flow-exclusion fix.

**Budget calculations**: "this month" spend uses a true bounded `[start, end)` query (`getCurrentMonthRange`); "recent average" uses a separately bounded range (`getRecentMonthsRange(N)`) that **excludes** the current in-progress month by design, so a partial month never dilutes the baseline. This is a genuinely different "N months" convention from the historical-chart endpoints (see next point) — both are correct for their own purpose, but a reviewer should be aware the codebase now has two distinct "N months" semantics living side by side, distinguished by intent (baseline vs. trend-display), not by a shared abstraction.

**Current-month vs. historical-reporting calculations — the most significant correctness work of the day**: prior to today's Date-Range Customization work, "current month" figures for Cash Flow Pace and the Savings Rate card were derived by reading the last element of a rolling historical array — correct only by coincidence (because that array always happened to include the current month, since nothing before today let a user request a range that excluded it). This is now an explicit, independent query (`getCurrentMonthRange()`), decoupled from whatever historical reporting range is selected. This was verified live specifically under the one condition that would have broken the old approach (`last_month` selected) — not just under the default range where the old bug would never have surfaced.

**Net-worth snapshot behavior**: unchanged today except for the one Account Customization interaction already covered (§2.5) — a snapshot is written once per day (upserted, not appended), only when live balances are actually refetched (initial link, manual refresh, or a net-worth-affecting exclusion toggle).

**Areas where double-counting was explicitly designed against** (not just hoped to be avoided): the credit-card-minimums/generic-bills split (structural, via discriminated union); the loans `exclude_from_cash_flow` fix (a loan's obligation cannot enter Safe to Spend twice through two different code paths, because there's only one path now, matching the recurring-streams path exactly); the decision to *not* build a full-credit-card-balance obligation for v1 specifically because it couldn't be reliably kept disjoint from already-categorized budget spend with current data.

**Remaining financial-correctness risks** (inference/opinion, not verified bugs):
- The two different "N months" conventions (budget-baseline excludes current month; historical charts include it) are correct individually but rely on a developer remembering which is which — there is no type-level or naming distinction forcing this, only comments.
- Multi-currency is entirely unhandled — every aggregation sums raw `amount` values with no `iso_currency_code` check. Safe today only because the app is contractually USD-only (`PLAID_COUNTRY_CODES=US`), but this would silently produce wrong totals the moment that assumption changes, with no guard rail in the code to catch it.
- Manual loans (personal loans not covered by Plaid Liabilities) have no `exclude_from_cash_flow`-equivalent concept at all, since they aren't tied to a Plaid `account_id` — this is architecturally consistent (they're user-entered, not synced) but means the exclusion model has a real, if narrow, blind spot for that one loan type.
- RLS policy gaps exist on 5 of 11 tables (see §8) — not exploitable today given the backend's exclusive service-role-key access pattern, but worth an independent reviewer's opinion on whether that's an acceptable long-term posture.

---

## 6. Testing and verification

**Beginning of day** (verified via `git ls-tree` against commit `f8ea907`, the last commit before today): backend had **11 test files** across service modules (`auth`, `assetsSummary`, `budgetPeriod`, `dataService`, `loans`, `monthlyBreakdown`, `netWorth`, `plaidErrors`, `recurringStreams`, `syncService`, `webhookVerification`); frontend had **zero** test files and no Vitest configuration at all.

**End of day** (verified via a fresh `npm run test` run just now, both workspaces):

| | Test files | Tests | Result |
|---|---|---|---|
| Backend | 13 | **168** | all passing |
| Frontend | 18 | **158** | all passing |

Backend gained 2 new test files today (`money.test.ts`, `reportingRange.test.ts`); the rest of its growth came from adding `describe` blocks to already-existing files (most of it in `dataService.test.ts`). Frontend's entire test suite — all 18 files, all 158 tests — was written today, since none existed this morning.

**Typecheck/build, verified just now**: `tsc --noEmit` clean on both workspaces; `tsc -p tsconfig.build.json` (backend) and `tsc && vite build` (frontend) both succeed with no errors. CI (`.github/workflows/ci.yml`, verified current contents) runs exactly these four steps per workspace on every push/PR to `main`; per this session's own memory it was checked green in the GitHub Actions UI after being introduced and again after the Node-runtime-warning fix, though that was not re-checked for this report.

**What automated tests cover vs. what only live-browser verification covers — an important distinction for a reviewer**: this codebase has **zero dedicated controller-level tests** (confirmed via `Glob` — every `*.test.ts` file lives under `services/` or `lib/`, none under `controllers/`). Every `updateXController`'s request validation, every route's wiring, and the entire persisted-preference round-trip (save → reload → confirm) was verified **only** via live browser testing this session, not by an automated regression test. This means: a future refactor of a controller's validation logic has no automated safety net today, only whatever manual re-verification a developer chooses to do.

**Bugs caught only through live verification, not automated tests** (all described in detail in §2):
1. The `useFinancialPreferences` render-body ref-hydration bug — every unit test of the pure clamp functions passed; only testing an actual page reload in a browser surfaced that the persisted value silently reverted to default.
2. The Account Customization `hidden`-accounts-affecting-Liquid-Cash bug — a pure-function unit test of the aggregation function in isolation would not obviously have caught this without a test specifically asserting "hidden accounts still contribute to totals," which didn't exist until after the bug was found.
3. The `getLoansForUser`/`exclude_from_cash_flow` gap — found because Trevor explicitly asked for it to be checked, then confirmed via a direct API before/after comparison, not via a pre-existing test that happened to fail.
4. The Cash Flow Pace/Savings Rate "last bucket" current-month bug — only observable by deliberately selecting the one reporting-range option (`last_month`) that would expose it; the default range never would have revealed it.
5. A verification-tooling gotcha (not an app bug): a browser-automation `form_input` call on a checkbox updated the DOM but not React state, producing a false-positive "it worked" screenshot during Safe to Spend Customization verification — caught by cross-checking the actual calculated dollar figure rather than trusting the visual checkbox state.

None of these five would have been caught by the current automated test suite as it exists today.

---

## 7. Accessibility and responsive/mobile-browser work

- **Touch targets**: `.reorder-btn` was found at ~21×14px, under the WCAG 2.5.8 24×24px minimum; fixed with a scoped CSS change (§2.6).
- **Keyboard focus**: the new Account Customization exclusion checkboxes had no visible `:focus-visible` state at all (inherited a global `input:focus{outline:none}` rule with no fallback border for checkboxes specifically); fixed and verified via **real Tab-key navigation** — per session memory, a simulated `.focus()` call was specifically avoided because it doesn't reliably trigger `:focus-visible` in this browser-automation environment, a nuance worth another reviewer knowing about if they try to reproduce this class of finding.
- **Narrow-screen layout**: `.budget-category-header`'s name label could shrink to ~3px/effectively invisible at 375px width (no `min-width`, while its sibling amount-input and Archive link refused to shrink); fixed.
- **Contrast**: light-mode Green accent, Teal accent, and `--text-muted` on `--surface-raised` all corrected from below-4.5:1 to 5.00–5.01:1 (§2.7); dark theme and both accents' solid-fill variants were confirmed already compliant and deliberately left untouched.
- **Light/Dark and accent testing**: all 3 themes × all 6 accent presets were exercised in-browser during Appearance v1 verification (12 combinations, screenshotted per session memory), confirming financial-semantic colors stay visually constant across every combination.
- **Mobile-width testing**: the audit above was explicitly done at 375px viewport width across Dashboard/Appearance/Budget/Account customization UI.

**Still known to need accessibility work** (not fixed today, not claimed to be): no accessibility audit was performed on Financial Preferences, Safe to Spend Customization, or Date-Range Customization's UI (all three shipped later the same day, after the one dedicated a11y pass) — the new checkbox/pill-selector controls in those features have not been independently confirmed against touch-target size or focus-visible behavior the way the earlier features were. This is an honest gap, not an inferred one: no commit or session note describes such an audit happening for these three.

---

## 8. Security / production-readiness impact

**What today's work did *not* change** (baseline, verified unchanged): authentication is Supabase-issued JWTs, verified server-side on every request via `supabaseAdmin.auth.getUser(token)` in `requireAuth` middleware (real verification against Supabase, not a local decode) — confirmed by reading `backend/src/middleware/auth.ts` directly; every route sits behind this middleware. The backend uses the Supabase **service-role key** exclusively (bypasses RLS by design), authorizing every data access by checking `req.user!.id` against ownership in application code, not by relying on RLS as the enforcement layer.

**RLS status, verified directly against the pulled schema migration** (`20260825195130_remote_schema.sql`): **11 of 11 app tables have RLS enabled**, but only **6 have an explicit policy** (`category_mappings`, `manual_loan_payments`, `manual_loans`, `net_worth_snapshots`, `budget_categories`, `plaid_items`). The other 5 (`accounts`, `loans`, `recurring_streams`, `transaction_splits`, `transactions`) have RLS enabled with **no policy at all**, which in Postgres means deny-by-default for any non-service-role connection. This is a known, accepted gap (documented in this session's own memory as "matches the documented join-derived-ownership pattern") rather than an oversight discovered today — but it was verified today by directly reading the real schema, not just repeated from memory. **Independent-reviewer question worth raising explicitly**: this is safe *only* as long as the frontend never receives anything but the anon key and never queries these tables directly — that invariant is not enforced by any test, only by current code convention.

**Multi-user readiness — improved today**: `budget_categories.name`'s uniqueness constraint was global (would have rejected a second real user creating a category named "Groceries") and is now correctly scoped per-user (§2.4/§3) — a genuine, verified fix, not just documentation.

**What was not touched, and remains exactly as risky as before today**: Plaid `access_token` values are stored as a **plain text column** on `plaid_items` (verified: `dataService.ts` selects/inserts `access_token` as an ordinary string field, no encryption function anywhere in the codebase) — protected only by whatever encryption-at-rest Supabase's infrastructure provides, not by anything this application does. No rate limiting exists on any endpoint (not verified as absent by exhaustive search, but no rate-limiting middleware or library appears in `package.json` dependencies). No audit logging exists. Environment secrets (`SUPABASE_SERVICE_ROLE_KEY`, `PLAID_SECRET`, etc.) are required-at-startup env vars (`backend/src/config/env.ts`, verified), sourced from `.env` locally (gitignored, verified) and presumably Railway's env config in production (not independently verified for this report).

**Net assessment**: today's work improved multi-user data-integrity readiness (the unique-constraint fix) and left the authentication/authorization baseline unchanged (still sound: real JWT verification, ownership checks in every controller). It did not address, and was not asked to address, access-token encryption, rate limiting, or audit logging — all pre-existing, still-open items.

---

## 9. Technical debt remaining (updated priority list, items resolved today removed)

**Resolved today, removed from the list**:
- ~~No tracked DB migrations~~ — real workflow now exists and was used 8 times today.
- ~~No CI~~ — exists, green, Node-warning-free.
- ~~Zero frontend tests~~ — 158 tests across 18 files now exist (still not exhaustive — see below).
- ~~`budget_categories.name` global-unique constraint~~ — fixed.
- ~~Duplicated `formatCurrency` across 13 files~~ — consolidated.
- ~~Duplicated reorder logic across 2 components~~ — extracted.

**Still open, in rough priority order**:
1. **Transaction pagination** — the transactions endpoint still has a hard 200-item fetch cap (`limit`, clamped 1–200); today's `start`/`end` param additions lay groundwork but do not themselves implement pagination. Per standing instruction, this waits until the transaction system itself is next worked on, not preemptively.
2. **`dataService.ts` size** — grew from 1,198 to 1,433 lines today (verified), still one file covering ~9+ domains. No split has begun.
3. **`App.tsx` size** — 953 lines (verified); smaller than it would be without today's extraction pattern, but still the single largest orchestration point in the frontend.
4. **Zero controller-level automated tests** (a gap this report surfaced explicitly in §6, not previously called out as its own line item in prior planning) — every request-validation code path in every controller is verified only by hand/live-browser testing.
5. **Remote Supabase migration-history reconciliation** — flagged, explicitly deferred, `supabase db push` should not be relied on until this is done as its own dedicated pass.
6. **Plaid access-token encryption at rest** — unchanged, still plaintext at the application layer.
7. **RLS policy coverage** — 5 of 11 tables have RLS enabled with no policy; acceptable today only because of the service-role-key access pattern.
8. **No rate limiting** on any endpoint.
9. **No audit logging.**
10. **No staging/production environment separation** — not evaluated this session; no evidence found either way in the repo of a staging deploy target.
11. **No E2E test suite** — only unit/integration-style Vitest tests exist; nothing exercises the app through a real browser as part of CI (today's live-browser verification was manual, per-feature, not automated or repeatable).
12. **Two divergent "N months" semantics** (§5) — correct individually, not unified or type-distinguished.
13. **Multi-currency**: entirely unhandled beyond preserving `iso_currency_code`; fine only under the current USD-only assumption.
14. **A11y coverage gap** for the three latest-shipped features (Financial Preferences, Safe to Spend Customization, Date-Range Customization) — no dedicated audit has been done on their new controls.

---

## 10. Roadmap status

*(Framing below is this report's own organization of the work, for the reviewer's convenience — it is not a section header that existed verbatim in this session's planning documents, which instead tracked a flat prioritized list; the phase grouping is a reasonable read of that list, not an independently-established formal roadmap.)*

1. **Foundation** — migrations, CI, money precision, currency audit, initial frontend testing, first architecture extraction, CSS token consolidation. **Complete** for the scope tackled today; ongoing practices (backend file-splitting, further extraction) remain open by design, not oversight.
2. **Personalization/customization** — Dashboard, Appearance, Budget, Account, Financial Preferences, Safe to Spend, Date-Range: **7 of 7 planned v1 customization areas shipped and live-verified today.** This was the dominant work of the day.
3. **Financial intelligence** — arguably not yet its own phase; Safe to Spend Customization and Date-Range Customization both touch calculation *transparency and configurability* rather than new intelligence (forecasting, anomaly detection, recommendations). **Not started** as a distinct initiative.
4. **Reporting/flexibility** — Date-Range Customization v1 is a real, if partial, start (5 presets, 3 widgets); custom start/end dates and a true drill-down UI remain deliberately deferred. **Partially complete.**
5. **Production/multi-user hardening** — one real fix landed (`budget_categories.name` scoping); RLS policy gaps, token encryption, rate limiting, audit logging, and migration-history reconciliation all remain open. **Early/partial.**
6. **Mobile preparation** — the pure-logic extraction pattern is real groundwork and was explicit intent, not accidental; no mobile-specific code, design system, or React Native scaffolding exists yet. **Groundwork only, not started as its own effort.**
7. **Native mobile application** — **not started.**

**Overall completion estimate — clearly an estimate, not a measured metric**: if the above 7 phases are weighted roughly by the amount of remaining product/engineering effort a mobile-capable, production-hardened multi-user app would need, this reviewer's own rough guess would put the project at **roughly 25–35% of the way** to that end state — heavily weighted toward "phase 2 (customization) is unusually far along for a single-user prototype" and "phases 5–7 (hardening, mobile prep, mobile app) are barely started." Treat this number as a conversation-starter for Gemini's own independent estimate, not as a claim this session is confident in.

---

## 11. Important product/engineering decisions made today

- **USD-only now, multi-currency later**: explicitly documented as a deliberate assumption (not an oversight) in the README; `iso_currency_code` preserved everywhere specifically to make a future multi-currency pass additive rather than a rewrite.
- **No full frontend rewrite**: the extraction pattern (§4) was chosen specifically so architecture improves incrementally, folded into feature work, per explicit standing instruction against a dedicated rewrite project.
- **Incremental mobile preparation**: same reasoning — pure-logic extraction as groundwork, no dedicated mobile-prep sprint.
- **Archive instead of delete for budget categories**: chosen specifically to make an unreachable failure mode (hard-delete on a category with transaction history) actually unreachable, while preserving historical attribution.
- **Hidden account vs. calculation exclusions kept as three independent flags** (`hidden`, `exclude_from_net_worth`, `exclude_from_cash_flow`) rather than one combined "archived account" concept — chosen because a real bug (§2.5) demonstrated that conflating "don't show me this" with "don't count this" is exactly the kind of mistake independent flags prevent.
- **Dedicated preference columns, not a growing JSON blob** — a consistent rule applied across 6 separate features today, not a one-off choice.
- **Reporting range kept independent from the Transactions feed's own filters** — an explicit decision to avoid one shared control silently restricting a view where a user expects to see everything, at the cost of two logically-similar-but-separate range concepts existing in the same app.
- **Custom budget-period start days deferred** — explicitly named as its own future feature, judged too broad (touches "too many date-range calculations") to bundle into either Financial Preferences or Date-Range Customization.
- **Savings-contribution logic deferred until a true contribution model exists** — the existing `savings_goal` is a target *balance*; inferring a monthly contribution from a balance target alone was judged to require assumptions (a target date, a contribution rate) the current data model doesn't support, rather than building something that looked plausible but wasn't reliably correct.
- **Current-period operational metrics kept distinct from historical-reporting metrics** — the organizing principle behind both Safe to Spend Customization and Date-Range Customization, made explicit rather than left as an implicit convention, and used to justify fixing the Cash Flow Pace/Savings Rate current-month bug rather than leaving every metric to follow the new reporting range.
- **A proposal-then-approval pattern for the two most calculation-sensitive features** (Safe to Spend Customization, Date-Range Customization): a written analysis of the existing formula/architecture and explicit trade-offs was produced and approved *before* any code was written, rather than proposing and building in the same pass — a process decision, not a technical one, but one that shaped what got built (both features shipped a narrower scope than what was originally brainstormed, by design).

---

## 12. Known limitations / deliberately deferred features

- **Custom start/end date ranges** — deferred from Date-Range Customization v1; the 5 presets cover common cases and none of the three bucketed-chart widgets render partial-month buckets today. Server-side `start`/`end` support exists on the transactions endpoint for a future drill-down to use, but no UI consumes it.
- **Credit-card full-statement-balance obligations** — deferred from Safe to Spend Customization v1; judged to carry a real double-counting risk against already-categorized budget spend, and Plaid's data doesn't cleanly separate "this cycle's new charges" from carried debt.
- **Savings-goal monthly contributions** — deferred; the current `savings_goal` is a balance target, not a contribution rate, and the two concepts were deliberately not conflated.
- **Custom budget-period start days** (e.g., a billing cycle that doesn't start on the 1st) — deferred as its own future feature, judged too broad to bundle into anything shipped today.
- **Category grouping** (folders/groups of budget categories) — evaluated during Budget Customization v1 and explicitly deferred; no existing scaffolding anywhere in schema/UI/calculations, and not on the must-have list.
- **Drag-and-drop card reordering** — Dashboard Customization v1 uses up/down arrows only; drag-and-drop was explicitly not implemented.
- **Density/compact-vs-comfortable spacing option** — deferred from Appearance v1, pending a separate spacing-token pass.
- **A11y audit for the three latest features** — not yet performed, unlike the dedicated pass given to the four earlier customization features.

---

## 13. Questions for Independent Reviewer

1. Were today's architectural decisions sound — in particular, the pure-logic/hook/component three-layer split repeated across 6 features, and the one-column-per-preference storage strategy?
2. Was too much functionality added too quickly? Seven "v1" customization features plus a foundation pass shipped in a single day — is that pace itself a red flag independent of any specific bug found?
3. Is any of today's implementation likely to become technical debt in its current form — the two divergent "N months" semantics, the still-untested controller layer, or something else?
4. Are there financial-correctness risks in the Safe to Spend formula, credit-card-minimum handling, or budget/current-month calculations that this handoff missed?
5. Is the current preference data model (one row per user, dedicated columns) scalable as more preferences accumulate, or should some subset move to a structured JSON column before it grows further?
6. Are the account/budget-category exclusion and archival semantics (§2.4, §2.5) correct and complete, or are there edge cases (e.g., manual loans with no `exclude_from_cash_flow` equivalent) that need addressing sooner than assumed?
7. Is the reporting-range architecture (§2.10) sensible, particularly the decision to keep the Transactions feed independent and to give current-period metrics their own explicit query rather than deriving them from a shared array?
8. Is the app being prepared appropriately for a future React Native/mobile client, given what actually exists today (pure-logic modules, an API-first backend) versus what would still need to be built?
9. What should be refactored before adding substantially more functionality — `dataService.ts`, `App.tsx`, controller test coverage, something else?
10. What are the five highest-priority things that should happen next, given everything above?
11. Are there security/privacy concerns (RLS policy gaps, plaintext Plaid tokens, no rate limiting/audit logging) that should move higher on the roadmap than they currently sit?
12. Based on the current state, how close is this to being a robust personal-finance product versus a well-organized prototype?

---

## 14. Final reviewer snapshot

### Current State in One Paragraph

My Finances is a single-user (soon-to-be-tested-for-multi-user) personal finance web app with a real Plaid integration, seven feature-complete dashboard tabs, and — as of today — seven independently-shipped, live-verified customization systems (dashboard layout, appearance, budget categories, accounts, financial preferences, Safe to Spend calculation, and reporting date ranges), all persisted server-side through a consistent one-column-per-preference architecture. The backend now has 168 passing tests and a working CI pipeline; the frontend went from zero tests to 158 in a single day. Authentication is sound (real server-side JWT verification); authorization relies entirely on backend-code ownership checks rather than RLS, which is enabled everywhere but only fully policy-covered on about half the tables. Several real bugs were found and fixed today specifically *because* of insistence on live-browser verification over trusting unit tests or visual screenshots alone — a pattern this report recommends the independent reviewer weigh when judging the codebase's actual reliability versus what its test-count alone would suggest.

### Top 10 Accomplishments Today

1. Established a real, working, from-scratch database migration workflow (baseline pull + reconciliation + 7 subsequent tracked migrations).
2. Stood up CI (backend+frontend typecheck/test/build) from nothing, kept it green through a Node-runtime-deprecation fix.
3. Took frontend automated testing from zero to 158 passing tests across 18 files.
4. Shipped and fully live-verified Dashboard Customization v1 (show/hide, reorder, presets), including the first real extraction of logic out of `App.tsx`.
5. Shipped and fully live-verified Appearance v1 (theme + 6 accents), including a genuine semantic-color audit keeping financial meaning independent of brand color.
6. Shipped and fully live-verified Budget Customization v1 and Account Customization v1, fixing two real bugs (a hard-delete crash risk; a hidden-account-affecting-a-calculation bug) in the process.
7. Shipped and fully live-verified Financial Preferences v1, catching and fixing a genuine React hydration anti-pattern that silently broke persistence across reloads.
8. Shipped and fully live-verified Safe to Spend Customization v1 via an explicit proposal-then-approval process, fixing a real pre-existing cash-flow-exclusion gap in the loans path.
9. Shipped and fully live-verified Date-Range Customization v1, fixing a real "current month" correctness bug that the new feature would otherwise have silently exposed.
10. Consolidated 12 duplicated `formatCurrency` definitions and 2 duplicated reorder implementations into shared, tested modules.

### Top 10 Remaining Risks / Priorities

1. Zero controller-level automated tests — every request-validation path is only manually/live-browser verified.
2. Plaid access tokens stored in plaintext at the application layer.
3. RLS enabled but unpoliced on 5 of 11 tables — safe only under the current service-role-key access pattern, worth independent scrutiny.
4. Remote Supabase migration-history bookkeeping is out of sync with reality; `supabase db push` is not yet safe to use.
5. `dataService.ts` (1,433 lines) and `App.tsx` (953 lines) remain large, unsplit files.
6. Transaction pagination still capped at 200 rows; the feed can silently show incomplete data for an active account under a wide date filter.
7. No rate limiting or audit logging anywhere in the backend.
8. No accessibility audit yet performed on the three most-recently-shipped features.
9. Two divergent, only-comment-distinguished "N months" semantics in the codebase (budget baseline vs. historical chart range).
10. No E2E/browser-automation test suite exists — all of today's live-browser verification was manual and is not repeatable by CI.

### Files Gemini Should Ask to See If It Wants Deeper Review

- `backend/src/services/dataService.ts` — the largest, most central file; every table's real query logic lives here.
- `frontend/src/App.tsx` — the orchestration root; shows exactly how much has (and hasn't) been extracted.
- `backend/src/services/reportingRange.ts` + `backend/src/services/budgetPeriod.ts` + `backend/src/services/netWorth.ts` — the three files whose date-range conventions genuinely differ; worth reading together.
- `frontend/src/lib/safeToSpend.ts` + `frontend/src/lib/upcomingItems.ts` — the full Safe to Spend formula and the credit-card-minimum split.
- `frontend/src/hooks/useFinancialPreferences.ts` vs. `frontend/src/hooks/useReportingRange.ts` — compare the fixed-after-the-fact hydration pattern against the one built correctly from the start.
- `supabase/migrations/20260825195130_remote_schema.sql` — the real, verified production schema, including every RLS policy (or lack of one).
- `supabase/SCHEMA_NOTES.md` — the reconciliation findings, in the project's own words.
- `.github/workflows/ci.yml` — the entire CI surface, small enough to read in full.
- `backend/src/middleware/auth.ts` — the entire authentication mechanism, 35 lines.
- `README.md` — this project's own running documentation of every feature above, written contemporaneously with each ship, not reconstructed after the fact.
