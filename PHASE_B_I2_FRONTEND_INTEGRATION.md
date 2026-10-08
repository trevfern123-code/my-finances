# Phase B integration slice I2: frontend semantic integration and API level 2

**Status (2026-10-04, revision 3): corrected implementation candidate for final focused verification. Uncommitted, unpushed, not released.**
Nothing here was run against a hosted database, and no migration or SQL changed.

**Revision 3** closes the one item the focused re-review of revision 2 left open: signing out did not end the automatic refetch of the summary and the monthly breakdown (§4b, §7). F1, F2 and F4 were closed by that review and are unchanged.

**Revision 2** answers the independent review of revision 1 (four P2 findings, F1–F4; §7). The review accepted, without change: the removal of the monthly "net", withholding budget figures after a failed refresh, and keeping the two unused sign-based helpers.

- Branch `feature/phase-b-i2-frontend-semantics`, created from `aa8ce6ad6bbd167e636e49aa15f798f96c4adda2` (draft PR #14's head).
- Frontend integration of the reviewed I1 read contract (`PHASE_B_I1_BACKEND_READ_PATH.md`). The only backend source change is the advertised API level.
- Authoritative designs: `FINANCIAL_SEMANTICS_PHASE_B_DESIGN.md` §5, §6.3, §6.4, §7.3, §9.4 and `CARD_PAYMENT_PAIRING_DESIGN.md` §6.2, as amended by the I1 decisions.

## 1. What I2 does

| Area | Before I2 | After I2 |
|---|---|---|
| API level | Backend 1, frontend 1 | Backend 2, frontend 2. Minimum client level stays 0 |
| Overview, Cash flow, Savings rate, Monthly spending | Computed in the browser from the sign-based `spent` / `income` | The server's role-aware figures, shown as sent |
| Monthly Breakdown | Sign-based months and categories; "net" = income − spent | The server's `semantic` block per month; signed categories; no "net" |
| Budget | Sign-based `spent`; refunds invisible | Role-aware `spending`, signed; refunds named |
| Safe to Spend | Remaining budget from `spent` | Remaining budget from `spending`; same clamp |
| Drill-downs | Filtered in the browser from at most 200 transactions, positive amounts only | Effect rows from `GET /api/plaid/transactions/effects`, paged, reconciled to the server total |
| When figures are not available | Not applicable | A dash and the reason in words. Never a frozen or rebuilt number |

## 2. API level 2

| Constant | File | Before | After |
|---|---|---|---|
| `API_LEVEL` (response header `X-Api-Level`) | `backend/src/middleware/clientApiLevel.ts` | 1 | 2 |
| `MIN_CLIENT_API_LEVEL` (`X-Min-Client-Api-Level`) | same | 0 | 0 |
| `SEMANTIC_FIELDS_MIN_CLIENT_API_LEVEL` | `backend/src/controllers/semanticResponse.ts` | 2 | 2 |
| `CLIENT_API_LEVEL` (request header `X-Client-Api-Level`) | `frontend/src/lib/appUpdate.ts` | 1 | 2 |

That is the whole backend change: one constant and two comments. No controller, service, route or SQL changed. A level-1 or level-0 client receives exactly the body it received before; the only difference it can observe is `X-Api-Level: 2`, which makes it look for a newer build (the existing update banner).

`frontend/src/lib/semanticContract.test.ts` reads the backend source and fails if the two levels or the measure list drift apart.

## 3. How the frontend reads the contract

- **`frontend/src/lib/semanticModel.ts`** takes each response body as `unknown` and returns either validated figures or a state that carries no figure. The role-aware fields are deliberately not typed on the response interfaces, so no component can read a half-present field.
- **States:** the server's `ok`, `updating`, `unavailable` and (budget only) `refused`, plus three the client needs:
  - `backend_outdated`: the response has no `semantic_status`, i.e. the backend does not publish the role-aware fields (one older than I1). Shown as "Updating…" (design §6.4). This is decided from the response body, never from the `X-Api-Level` header.
  - `loading`: nothing has arrived yet, or the figures were invalidated and their replacement is pending (§4a).
  - `invalid`: the status is `ok` but a figure is missing, malformed, or contradicts another (for example a single cash-flow figure while a card payment is unresolved).
  - `failed`: the request itself failed. Only its machine-readable `code` is kept.
- **No fallback.** The frozen fields (`spent`, `income`, `total_spent`, `total_income`, `by_category`, `recent_avg_spent`) stay typed as deprecated and are not displayed anywhere.
- **Wording** is fixed in `frontend/src/lib/semanticPresentation.ts`. Nothing the server sent (a message, a reason string, a transaction id) is displayed.

## 4. Surfaces

| Surface | Figures (server field) | When withheld |
|---|---|---|
| Overview "Monthly cash flow" | `cash_flow` of the latest month in range; a change only between two single figures; `cash_flow_range` plus "N card payments aren't matched yet" when unresolved | "—" and "Updating…" / "Unavailable". Net worth and liquid cash stay |
| Cash flow & budget pace | Bars: `income_semantic`, `spending`; `debt_payments`, `credit_card_payments_untracked` and transfers out only when non-zero. "Cash flow this month" from `cash_flow` or the range. Budget pace = Σ category `spending`, signed | A notice with "Check again"; no bar |
| "What's counted this month" | Every published amount as a line, grouped: counted, already inside, not counted, not settled. Each opens its drill-down | Not rendered |
| Savings rate | `savings_rate` or `savings_rate_range`; copy from `cash_flow`, `known_principal`, `debt_payments_unknown_principal`, `transfers_external`. Income at or below zero is stated as a figure ("Income this month is −$60.00: reversed income exceeded what came in. The savings rate is shown as 0%."), never as "no income" | "— this month" and the reason |
| Monthly spending chart | `spending` per month; "(refund)" when negative | A notice |
| Monthly Breakdown | `semantic.spending`, `semantic.income` (always shown, signed: "$3,002.10 in", "$0.00 in", "−$60.00 in (income reversed)"), `semantic.by_category` (signed), "Not counted as spending: …" from `semantic.excluded`. The months are exactly the ones the server returned | A notice; no month |
| Budget | `spending`, `recent_avg_spending` per category, signed | The list, names and budget inputs stay; every figure is a dash; no drill-down |
| Safe to Spend | Remaining budget from `spending`, clamped at zero per category as before. It exists only when the budget state is `ok`; an empty category list under any other state is not a zero | "—" while remaining budget is included; unaffected when it is not |

"Unresolved card credits" (`card_payments_unresolved_credit`) is listed under "Not counted in cash flow" with the note "For information only. It does not change cash flow and does not show where the money came from."

## 4a. When figures are withheld before an answer arrives

- **A change that can alter the figures withholds them at once.** Every budget read withholds the budget figures when it STARTS (`loading`), not when it is answered: after a sync, a categorisation, a split, a mapping backfill, an account's cash-flow setting, a loan change, a new or removed bank link, or "Check again". The category list, names and budgeted amounts stay. The summary and the breakdown are cleared the same way by the existing range-data path.
- **A loan change does both.** Adding, editing or deleting a manual loan, and editing or unlinking a linked payment, clear the summary and the breakdown and withhold the budget figures as soon as the change is committed, then refetch them.
- **If the replacement read fails,** the figures stay withheld, with "Check again".
- **A budget read superseded by a local edit of the list** (a category created or changed while the read was pending) is not used, and the read is repeated, so the figures do not stay withheld.

## 4b. Refetch after `updating`

`updating` means the server read the data but its card-payment matching state is not fresh. The pairing design (§6.2) has the client ask again after the server's `retry_after_ms`. This client does, for the summary, the monthly breakdown and each drill-down (`frontend/src/lib/updatingRefetch.ts`, `hooks/useUpdatingRefetch.ts`, and the drill-down loader).

| | |
|---|---|
| What it is | A read of that one resource again. It evaluates nothing and asks the server to evaluate nothing |
| Bound | At most 3 automatic refetches per load |
| Delay | The server's hint, kept within 1 to 30 seconds (the server sends 5 seconds). A zero or absurd hint cannot spin or stall |
| Concurrency | Within one load, one timer and one automatic request per resource: the next wait starts only when an answer has arrived |
| A load | Whatever the user, a range change, a sync or a sign-in started. Automatic refetches stay inside it and never start a new one, so they clear nothing and re-request no other dataset |
| Ended by | A new load, another drill-down query, a sign-out, a sign-in as someone else, an unmount, or a manual retry. The pending wait is cancelled, and a late answer of a superseded request — a success, another `updating`, or a failure — changes nothing and schedules nothing |
| Sign-out | The app stays mounted when the user signs out, so this does not rely on an unmount: the session effect ends the load for every lifecycle change, including the change to "signed out", before it returns; the two schedulers get no answer while no one is signed in or in the render in which the session changes; and the refetch functions ask nothing when no one is signed in and commit only to the lifecycle and the load that asked |
| Not network cancellation | For the summary and the breakdown, "dropped" means the answer is ignored when it arrives; the request itself is not aborted. Drill-down requests are aborted |
| While it runs | The figures stay withheld. The text says "Card-payment matching isn't up to date, so these figures are withheld. Checking again automatically." |
| Afterwards | Still withheld, without the last sentence; "Check again" starts a fresh load with a fresh budget |
| Never applies to | `unavailable`, a refused budget, an integrity error, a malformed response, a missing endpoint, or any failed request. A failed automatic refetch is shown as the failure it is and ends the retries |

The budget endpoint never answers `updating` (it does not depend on matching), so it has no automatic refetch.

## 5. Drill-downs

`frontend/src/lib/effectsDrilldown.ts` (loader), `hooks/useEffectsDrilldown.ts`, `components/EffectsDrilldown.tsx`.

- **On demand.** A list is requested when its row is opened. Nothing is requested for a closed row.
- **Server rows, server signs.** Rows are listed in the server's order with the server's `effect_amount`. Nothing is filtered or re-signed.
- **Footer.** While pages remain: "Showing 50 of 120 items · $1,240.00 of $2,980.50", the second amount being the server's `total_amount`. When complete: "120 items · $2,980.50".
- **Reconciliation in integer cents.** When the last page arrives the rows must number `total_count` and sum to `total_amount`. A later page must declare the same total and count. A transaction must not reappear on a later page. Anything else is a client integrity failure and nothing is listed.
- **Restart.** On `409 effects_restart_required` the loaded rows are dropped at once and page 1 is requested again, at most 2 times per load. Beyond that the list stops with "These transactions kept changing while the list loaded. Try again in a moment."
- **Updating.** A list answered `updating` shows no rows and is asked again automatically under the policy of §4b, independently of the 409 restart bound.
- **Cancellation.** Each request carries an `AbortSignal`. Another query, a retry or an unmount aborts the request in flight, and a late answer is ignored. Rows of one query are never shown under another, not even for one render.
- **The figure it explains.** The list and the figure above it come from two requests. When they differ the list says so and offers to reload either one.

Measures used: every measure in the backend's `CASH_FLOW_MEASURES`. `spending` is bucketed by `budget_category_id` (Budget) or `plaid_category` (Monthly Breakdown, `LOAN_INTEREST` included), or unbucketed (Cash flow).

## 6. Mixed versions

| Case | What happens | Safe? |
|---|---|---|
| A. New backend, old frontend (level 1 or 0) | Identical bodies as before I2. `X-Api-Level: 2` makes the old bundle look for a newer build; the minimum is 0, so nothing is refused | Yes |
| B1. A backend older than I1, new frontend | Responses have no `semantic_status`: every role-aware figure shows "—" / "Updating…". The effects endpoint does not exist: a drill-down says "This list isn't available yet." Net worth, accounts, feed, loans and settings are unaffected | Safe, but degraded: no cash-flow, breakdown or budget figures |
| B2. The I1 backend (`aa8ce6a`: advertises level 1, but serves the role-aware fields and the effects endpoint to a request that declares level 2), new frontend | Works as with the I2 backend. The frontend decides from the response body, not from the advertised level, so it does not refuse a usable answer | Yes |
| C. New bundle loaded while the backend rolls out | As B1 until a request reaches a backend that publishes the fields. There is no automatic re-check for that state (the automatic refetch is for `updating` only); the figures appear on the next refresh or "Check again" | Safe |

**Deployment ordering that this candidate requires.** The new frontend shows role-aware figures only when the server can produce them. That needs, before the frontend is released:

1. the backend at level 2;
2. migration `20261004120000` (the snapshot function) and the matching migrations applied; and
3. card-payment matching evaluated for the user, and kept fresh (today: `CARD_PAYMENT_SYNC_EVALUATION_ENABLED`, which is off, plus a backfill).

Without 2 the summary, breakdown and budget are `unavailable`. Without 3 the summary and breakdown are `updating` indefinitely, because a read never evaluates (I1 §8). In both cases the new frontend shows no cash-flow figures where the level-1 frontend showed sign-based ones. This is a release gate, not something I2 can work around: falling back to the frozen figures is exactly what the design forbids.

## 7. Corrections and bugs

### Revision 2: the independent review's findings

| Finding | Correction | Regression tests |
|---|---|---|
| **F1.** Safe to Spend showed a number under a non-ok budget state when the category list was empty (`[].every(...)` is true) | `SafeToSpend.tsx`: remaining budget requires the `ok` state first, whatever the list holds. `ok` with no categories is still a real zero; a figure that does not include remaining budget is unaffected | `semanticSurfaces.test.tsx` "F1 — Safe to Spend with an EMPTY category list" (eight non-ok states × three cases, an ok control, an ok → withheld transition); `App.production.test.tsx` "…correction F1" (a number on screen, then a failed background refresh; four 200 answers with an empty list) |
| **F2.** After a successful loan change the old budget figures stayed on screen until the replacement read was answered | `App.tsx`: `refreshBudgetCategories` and the grouped read withhold the budget figures when they start (§4a). A read superseded only by a local edit is repeated | `App.production.test.tsx` "…correction F2": each of the five loan actions with both replacement reads held open, then answered; a failed replacement; a failed mutation; a sync; a new bank link; a category added during a pending read. `semanticSurfaces.test.tsx` "F2 — …" (an open drill-down closes) |
| **F3.** The server's retry hint was parsed and never acted on | §4b. The wording no longer says matching is in progress, only that it is not up to date and what the client is doing | `hooks/useUpdatingRefetch.test.tsx`; `effectsDrilldown.test.ts` and `EffectsDrilldown.test.tsx` "automatic refetch after an updating answer"; `App.production.test.tsx` "…correction F3". All with fake timers |
| **F4.** Negative income was hidden in Monthly Breakdown and described as "No income recorded" in Savings | `MonthlyBreakdown.tsx` always shows the server's income, signed; `IncomeSavings.tsx` states the figure for income at or below zero | `semanticSurfaces.test.tsx` "F4 — …": positive, zero, negative, a one-cent negative, and every withheld state, on three surfaces; `semanticPresentation.test.ts` |

Review notes also addressed: the mixed-version table now separates a backend older than I1 from the I1 backend (§6); the five loan actions are each driven in a test, not only "add"; and the range presentation limit is stated precisely (§8).

### Revision 3: the focused re-review's remaining finding

| Finding | Correction | Regression tests |
|---|---|---|
| **F3, remaining part.** Signing out left the App mounted with a live retry load: the session effect returned for "no session" before invalidating the load, so a pending wait could still fire and a late `updating` answer could be accepted and schedule another | `App.tsx`: the session effect invalidates the range-data load and clears its answers before the "no session" return; the two schedulers are bound to the login lifecycle; the refetch functions ask nothing when signed out and commit only to the lifecycle and load that asked | `App.production.test.tsx` › "…correction F3" › "signing out ends the retry lifecycle": a wait pending at sign-out (summary, breakdown); a request in flight at sign-out answered `updating`, `ok` or with a failure (summary, breakdown); and A signs out, B signs in. Fake timers and held promises |

### Found in the correction pass's own review

| Bug | Fix | Regression test |
|---|---|---|
| Withholding the budget figures when a read starts would have left them withheld for good if that read was then superseded by a local edit of the category list (its answer is discarded, and nothing else was going to read) | A read that is still the newest read when it finds itself superseded is repeated; a failure of the newest read is recorded even after a local edit | `App.production.test.tsx`, "a category edited while a budget read is pending does not leave the figures withheld for good…", and existing test 51 (its stale read is now followed by a fresh one) |
| The first wording for a negative income put the explanation inside a sentence where it read as part of the amount ("…of −$60.00 (income reversed) income…") | Two phrases: the month header's own label, and a separate note in Savings | `semanticSurfaces.test.tsx` "F4 — …", exact strings |

### Found in revision 1's self-review

| Bug | Fix | Regression test |
|---|---|---|
| Adding, editing or deleting a manual loan, and editing or unlinking a linked payment, left the Overview, breakdown and budget figures of the previous state on screen under `ok`. Before Phase B a loan link changed none of them, so these handlers refreshed nothing | `refreshRoleAwareFigures()` in `App.tsx`, called after each of the five mutations commits under the session that started it. (Revision 2 made the budget half of it immediate: F2 above) | `App.production.test.tsx`, "a manual-loan change refetches the role-aware figures…" (creation: refetch, no refetch on failure, no refetch under another user's session), and the five-action tests of F2 |
| The "list and figure differ" notice assumed the figure was the older one. After the figure is refreshed the list can be the older one | Neutral wording, with "Reload list" and "Refresh figure" | `EffectsDrilldown.test.tsx`, "says so when the list and the figure above differ…" |
| A repeated row was detected by a key built from the allocation and split id, an assumption about the server's row shape | The server-guaranteed rule instead: a transaction's effects are returned together, so a transaction on two pages is a repeat | `effectsDrilldown.test.ts`, "a transaction that reappears on a later page…" and "several effects of one transaction on the same page…" |

## 8. Deliberately not in I2

| Item | Why | What it needs |
|---|---|---|
| Role badges, overridden marker and loan decomposition text on feed rows; "Review roles" queue | `GET /api/plaid/transactions` does not return `effective_role`, `user_role_override`, `principal_portion` or `semantic_effects`, and has no `review=roles` filter | Those fields and the filter on the list endpoint (design §6.1) |
| Role override, two-row transfer correction, loan-decomposition acknowledgement, card-payment decisions | Write actions; `PATCH /role` is not built | The Phase B migration and endpoint |
| Feed pagination and server-side feed filters | Not built in the backend | Design §7 |
| "Card payments to review (N)" list with reasons and actions | The unresolved measures are reconciliation rows only (I1 §8) | Candidate and decision endpoints |
| The integrity banner naming the transaction, with a link into the feed (design §6.3) | The error body carries only an id; the feed cannot be opened at a row | A named row in the error, or a lookup, and a feed deep link |
| Recurring-stream merging and the Safe to Spend label changes (design §4.8, C7) | Not built in the backend | §4.8 |
| The one-time Budget notice after release (design D12) | A release item that needs persisted dismissal | The release packet |
| A hatched range segment in charts and bars (pairing design §6.2) | Ranges are shown as text (both bounds). The Savings rate progress bar is the one drawn element of a card-dependent figure: while the rate is a range it is drawn at the lower bound, with no segment to the upper one | The range drawn on that bar, and on any future cash-flow chart |
| Server-side recovery of stale matching (retry-on-read, autonomous evaluation) | Out of I1 and I2 by decision. The client's refetch (§4b) only observes state that became fresh some other way | The recovery packet |

## 9. Tests

Frontend: 47 files, 1 213 tests at revision 2 (parent: 39 files, 800; revision 1: 46 files, 1 079). Revision 3 adds 9 tests to `App.production.test.tsx`; the whole suite was not run again for it, only that file and the scheduler's own. Backend: 46 files, the same tests as before; four test files had level literals updated (revision 1; revision 2 changes no backend file).

| File | What it covers |
|---|---|
| `lib/semanticModel.test.ts` | Each reader: `ok`, every withheld state, no frozen figure in the result, months never dropped, malformed and contradictory figures → `invalid`; the effects response; cents |
| `lib/effectsDrilldown.test.ts` | First page, append in order, server total, signed rows, restart clears and restarts, bounded restarts, reconciliation in cents, changed totals, repeated transaction, no-progress cursor, `updating` / `unavailable`, cancellation, superseded requests |
| `lib/semanticPresentation.test.ts` | Signed and refund formatting, ranges, every state has words and no number or id, neutral credit wording, every line maps to a supported measure |
| `lib/semanticContract.test.ts` | Client level = backend level = 2; minimum 0; measures equal the backend's list |
| `lib/api.effects.test.ts` | `X-Client-Api-Level: 2` on the four reads; effects parameters; cursor; abort signal; 409 with code, reason and status; 404 |
| `components/EffectsDrilldown.test.tsx` | The same behaviours on screen, with roles and button names |
| `components/semanticSurfaces.test.tsx` | Every surface: figures from the API, no reconstruction, every withheld state, refunds, unresolved ranges, neutral credit copy, drill-down parameters, accessibility attributes |
| `hooks/useUpdatingRefetch.test.tsx` (revision 2) | The delay window, one refetch per answer, the bound, a zero hint, a new load, unmount, no schedule for other states |
| `App.production.test.tsx` (15 added in revision 1, 30 in revision 2, 9 in revision 3) | The real App against level-2 responses, an old backend, `updating`, `unavailable`, an integrity error and its retry, stale figures after a failed refresh, budget refusal, loan changes; revision 2: F1, F2 and F3 as listed in §7 |

**Changed existing tests.** Level literals were made relative to `CLIENT_API_LEVEL` (`appUpdate.test.ts`, `api.test.ts`, `updateSafety.test.tsx`) or raised from 1 to 2 where they pin the production policy (`backend/src/app.test.ts`, `app.clientApiLevel.auth.test.ts`, `clientApiLevel.test.ts`, `semanticEndpoints.test.ts`). `safeToSpend.test.ts` passes `spending` instead of `spent`, with the same expected values. One `App.production.test.tsx` fixture gained the level-2 block. No assertion was removed.

In revision 2: existing test 51 in `App.production.test.tsx` (a stale budget read must not erase a just-created category) gained the server's answer to the fresh read that now follows a superseded one; its two assertions are unchanged. Three revision-1 tests had the `updating` wording or state shape updated. The `App.production.test.tsx` module mock gained the four other loan mutations and the payment list, which no earlier test reaches.

**Order.** Most tests were written after the code they cover, not before. The mutation checks in the evidence folder show the tests fail for the defects they are meant to catch.

## 10. Open questions and limits

Settled by the independent review, with no product decision needed: the client refetch after `updating` is required (now built, §4b); removing the monthly "net" is correct for this response; withholding budget figures after a failed refresh is consistent with the fail-closed design; the two unused sign-based helpers (`getCurrentMonthCategoryItems`, `transactionsForMonthCategory`) stay, with their tests.

- **Budget figures blink on every change that can alter them.** A categorisation, a split, a sync or a loan change shows "Loading these figures…" until the read is answered. That is the price of never showing a figure of the previous state.
- **A budget read that never settles leaves "Loading these figures…" with no button.** Any other refresh replaces it.
- **A zero recent average is not printed** (as before I2); a withheld one is not printed either. The two are told apart by the dash and the notice on the same row, not by that line.
- **The feed still shows each row's own amount with a sign-based + / −.** That is the row's amount, not an aggregate; role badges are deferred (§8).
- **Month boundary.** The drill-down period for "this month" is computed in the browser in UTC, like the server's. Around midnight UTC on the last day of a month the two can differ for a moment; the list then reports that it does not match the figure.
- **No browser-level check.** Verification is automated tests, typecheck, build and the PWA contract. A local browser session would need the auth container, which is not among the images authorized so far.
- **Bundle size** is 542 kB minified, 152 kB gzipped (revision 1: 540 / 151). The parent is 516 kB / 144 kB and already carries the build's 500 kB warning, so I2 added about 26 kB (8 kB gzipped).
