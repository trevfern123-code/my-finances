# Phase B integration slice I1: backend read path and semantic aggregation

**Status (2026-10-03, revision 2): corrected implementation candidate for independent re-review. Uncommitted, unpushed, not released.**
Nothing here changes a response for any client released so far, and nothing was run against a hosted database.

- Branch `feature/phase-b-i1-backend-read-path`, created from `a95281bcd8d32ba86d3e0b2c2711e2f8db00d676` (draft PR #13's head).
- One additive migration (`20261004120000`). No frontend, dependency or workflow change.
- Authoritative designs: `FINANCIAL_SEMANTICS_PHASE_B_DESIGN.md` (rev 6) and `CARD_PAYMENT_PAIRING_DESIGN.md` (rev 3), as amended by Trevor's I1 decisions recorded in §5.

**Revision 2** answers the independent review of revision 1 (findings F1–F7). Revision 1 paged its reads and bracketed them with the matching version; that could publish a total assembled from several database states. Revision 2 reads one statement instead. §9 lists what revision 1 said that was wrong.

## 1. What I1 does

| Area | Before I1 | After I1 |
|---|---|---|
| Aggregate reads | One request each; PostgREST's row cap could silently truncate a total | One statement each, proven complete or refused: never truncated, never assembled from several database states |
| Card payments in the pure module | Paired inside the module within ±5 days; "no partner" became "untracked" (the R3 defect) | Read from stored matching states; an unestablished destination is a range, never a guessed figure |
| Stored matching state | Written by the evaluator, read by nothing | Read in the same statement as the transactions it describes; stale or unreadable state withholds every dependent figure |
| Drill-down rows | Effect rows for budget and Plaid-category spending only | Effect rows for every published amount, paged, with a continuation that detects a changed result |
| Endpoints | Sign-based fields only | The same sign-based fields, unchanged; role-aware fields and the drill-down endpoint for clients at API level 2 only |

## 2. The consistency rule and how it is met

**Rule (amends design §7.4):** a published aggregate must be computed from one coherent financial state and must never be silently truncated.

Several Data API requests are several committed database states. A read assembled from them can combine states that never existed together: a pending row with the posted row that replaced it (counted twice), one payment's principal before an edit with another's after it, a transaction with another allocation's splits. The matching version cannot detect that; it watches only the matching inputs.

So every read is **one statement**:

| Read | Mechanism |
|---|---|
| Any level-2 aggregate or drill-down | One call of `get_financial_read_snapshot` |
| A level-1 aggregate that fits one response | The single request `main` has always made, now with an exact row count that proves it complete |
| A level-1 aggregate beyond one response | `get_financial_read_snapshot` (its legacy projection) |
| …when that function is unusable | The request fails with `aggregate_snapshot_unavailable`. Never truncated, never paged |
| Net-worth history beyond one response | Keyset pages by date. Its rows are independent facts (one per date), so pages cannot double count |

### The migration

`supabase/migrations/20261004120000_financial_read_snapshot.sql` adds one function and nothing else.

- **Signature:** `get_financial_read_snapshot(user, from, to, include_splits, include_budget_categories, include_card_states, card_states_from, card_states_to) returns jsonb`.
- **Returns, from one `select`:**
  - `transactions`: the user's rows on accounts included in cash flow with `date` in `[from, to)`, ordered `(date, id)`, with every consumed column, the lineage ids, the display fields and the account's name, nickname and type;
  - `splits` of those transactions, ordered `(transaction_id, id)`;
  - `budgetCategories`, ordered `(sort_order, id)`;
  - `cardPayments`: the result of the existing `get_card_payment_states`, called inside the statement.
- **Properties:** `language sql`, `STABLE`, `SECURITY INVOKER`, empty `search_path`, executable by `service_role` only. A postcondition block checks all of that, the owner, the return type and that no overload exists.
- **Limits:** 10 000 transactions and 25 000 splits, constants inside the function. Beyond either it returns counts and no rows, and the backend fails with `aggregate_too_large`. These are development-stage safety limits, to be revisited with measurements before release.
- **Rollback:** `supabase/rollback/20261004120000_financial_read_snapshot_rollback.sql` drops the function. No table, trigger, index or existing function is touched.

### Card-payment freshness

The matching state is read inside the snapshot, so fresh states describe exactly the transactions beside them. The existing contract still decides freshness (`evaluated_version = input_version`). When the states are stale the read polls the versions twice (after 100 ms and 300 ms), takes at most one more snapshot if a poll reports fresh, and otherwise withholds every card-dependent figure.

`inputs_changing` is no longer reachable: it described the version bracket, and one statement has no window for it. The value stays in the type because it is part of the design's vocabulary.

## 3. Behaviour on the wire

### Levels

- **Below API level 2** (every released bundle): exactly today's body, from the frozen reads. A frozen read that fits one response uses the single legacy request. A range beyond one response uses the snapshot function's legacy projection, so level 1 is not independent of that function; if completeness cannot be established, the request fails closed rather than returning a truncated total (§2). No role-aware calculation runs, no card state is requested and no semantic failure can occur. The drill-down endpoint answers 404.
- **Level 2:** frozen and role-aware fields are computed from the same snapshot rows. `API_LEVEL` stays 1 and `MIN_CLIENT_API_LEVEL` stays 0.

### Statuses

| `semantic_status` | Meaning | HTTP | Role-aware figures | Frozen fields |
|---|---|---|---|---|
| `ok` | One snapshot, fresh matching state | 200 | yes (possibly a range) | from the snapshot |
| `updating` | The snapshot was read; its matching state is not fresh (`matching_pending` or `matching_failed`) | 200 | none | from the snapshot |
| `unavailable` | The snapshot could not be read at all | 200 | none | from the frozen reads |
| `refused` (budget only) | A split no longer adds up | 200 | none | from the snapshot, with the category list |

`unavailable` is distinct from `updating`: it establishes nothing about the data.

### Failures

| Failure | Response |
|---|---|
| `SemanticIntegrityError` (R9), level 2 | 500 `semantic_integrity_error` with the user's own `transaction_id` |
| A card leg with no usable stored state in a fresh snapshot | 500 `card_payment_state_integrity` with `transaction_id` |
| Beyond the snapshot limits | 500 `aggregate_too_large` |
| A level-1 range beyond one response with the function unusable | 500 `aggregate_snapshot_unavailable` |
| Frozen and role-aware months disagree under `ok` (cannot happen from one snapshot) | 500 `semantic_result_inconsistent` |
| Split mismatch on a budget drill-down | 409 `split_allocation_mismatch` |
| A drill-down continuation whose result changed | 409 `effects_restart_required`, reason `snapshot_changed` |

Each `error` is a fixed message. The underlying message, which can quote amounts, is never sent.

### New fields for level-2 clients

| Endpoint | Added |
|---|---|
| `/api/plaid/summary` | On each `monthly_spending[]` entry and on `current_month`: `spending`, `income_semantic`, `debt_payments`, `known_principal`, `debt_payments_unknown_principal`, `transfers_internal`, `transfers_external`, the six `credit_card_payments_*` totals, `card_payments_unresolved_credit`, `refunds`, `cash_flow`, `cash_flow_range`, `savings_rate`, `savings_rate_range`, `card_payments_unresolved`, `unclassified_count`, `unclassified_amount`. Top level: `semantic_status` |
| `/api/plaid/monthly-breakdown` | On each month: `semantic: { spending, income, by_category, excluded }`. Top level: `semantic_status` |
| `/api/budget-categories` | On each category: `spending`, `recent_avg_spending`. Top level: `semantic_status` |

### Unresolved card credits

A credit-side card leg the evaluator calls `unresolved` is reported under `card_payments_unresolved_credit` ("Unresolved card credits"). It asserts nothing about the source of funds, and its cash-flow effect is zero. `credit_card_payments_externally_funded` and `…_reversed_externally` now hold only what is established: a leg paid from an account excluded from cash flow, and the card excess of a fee pair.

The total is the signed net of those legs as credits to the card: a payment into the card counts positive, a reversal negative.

### The drill-down endpoint

`GET /api/plaid/transactions/effects`, level 2 only.

- **Parameters:** `start`, `end` (exclusive), `measure` (default `spending`), `cursor`, `limit` (default 50, maximum 200). For `spending`, optionally one of `budget_category_id` (an id, or `unassigned`) or `plaid_category` (`LOAN_INTEREST` allowed); without either, every spending effect of the period.
- **Row:** the shape in design §7.3. `effect_amount` is the row's contribution to the total, in the total's own sign convention.
- **Totals:** `total_amount` and `total_count` are the bucket's complete figures, on every page.
- **Paging:** `(date desc, id desc)`. A page never splits one transaction's effects and may exceed `limit` to keep them together.
- **Measures:** `spending`, `income`, `debt_payments`, `known_principal`, `debt_payments_unknown_principal`, `refunds`, `transfers_internal`, `transfers_external`, the six `credit_card_payments_*` totals, `card_payments_unresolved_credit`, `card_payments_unresolved_payments`, `card_payments_unresolved_returns`, `unclassified`.

**Continuation.** Every request reads one snapshot and computes the complete bucket. The cursor is base64url of `version|fingerprint|date|id`. The fingerprint is SHA-256 over a canonical representation of the query (range, measure, bucket), the complete ordered result with every returned field, the total and the count. A later page is served only if the result it recomputes has the same fingerprint. Otherwise the answer is 409 `effects_restart_required` with no rows, total or cursor, and the client restarts from page 1. A cursor used with another range, measure or bucket fails the same check. If the matching state is stale on a later page, the answer is `updating`, not a restart.

## 4. Changed and new files

**New**

| File | What |
|---|---|
| `supabase/migrations/20261004120000_financial_read_snapshot.sql` | The snapshot function |
| `supabase/rollback/20261004120000_financial_read_snapshot_rollback.sql` | Its rollback |
| `supabase/tests/access_control/sql/a17_financial_read_snapshot.sql` | Catalog, ownership, ordering, limits and client-role refusal |
| `supabase/tests/read_path_integration/{run.sh,seed.sql,check.cjs,keys.cjs}` | The local Data API integration check |
| `backend/src/services/financialSnapshot.ts` | The snapshot reader and payload validation |
| `backend/src/services/cardPaymentStateReader.ts` | Matching-state payload validation and the version poll |
| `backend/src/services/semanticReadPath.ts` | The read path: summary, breakdown, budget, effects |
| `backend/src/controllers/semanticResponse.ts` | Wire shape, the level gate, month alignment |
| `backend/src/middleware/semanticErrors.ts` | Sanitized failures |
| `backend/src/testUtils/cardStatesFromOracle.ts`, `semanticSnapshot.ts` | Test-only helpers |
| Tests | `financialSnapshot.test.ts`, `cardPaymentStateReader.test.ts`, `semanticReadPath.test.ts`, `dataService.aggregateReads.test.ts`, `controllers/semanticEndpoints.test.ts`, `middleware/errorHandler.importBoundary.test.ts` |

**Modified**

| File | Change |
|---|---|
| `backend/src/services/semanticAggregation.ts` | Card legs from stored states; ranges; effect rows per total; the neutral credit bucket; the new measures |
| `backend/src/services/dataService.ts` | Frozen reads are one statement with an exact count, then the snapshot; `categorySpendRowsOf` |
| `backend/src/services/fetchAllPages.ts` | Error classes; the header now says what the helper is safe for |
| `backend/src/controllers/plaidController.ts`, `budgetCategoryController.ts` | Level-2 fields from one snapshot; the drill-down endpoint |
| `backend/src/routes/plaid.ts`, `backend/src/middleware/errorHandler.ts`, `backend/src/config/env.ts` | Route, error mapping, a comment |
| `backend/src/testUtils/supabaseMock.ts` | The mock can carry an exact count |
| Tests: `semanticAggregation.test.ts`, `fetchAllPages.test.ts`, `dataService.test.ts`, `cardPaymentMatching.test.ts` | See §6 |
| `FINANCIAL_SEMANTICS_PHASE_B_DESIGN.md`, `CARD_PAYMENT_PAIRING_DESIGN.md` | Status pointers and the amendments of §5 |

## 5. Decisions (Trevor, 2026-10-03)

| # | Decision | Implemented as |
|---|---|---|
| 1 | `unavailable` stays distinct from `updating` | Separate status; both withhold figures |
| 2 | Backend API level stays 1; every semantic surface is level-2 opt-in, including the drill-down endpoint | Level gate on all four endpoints; 404 for the drill-down below level 2 |
| 4 | Level-1 keeps frozen behaviour; level-2 fails closed | No role-aware calculation, card-state request or semantic failure below level 2. A level-1 range beyond one response uses the snapshot function's legacy projection, else fails closed (§2) |
| 5 | Budget split mismatch: HTTP 200, list and frozen fields kept, result refused, every new figure withheld | `semantic_status: refused` |
| 7 | Unresolved credit-side legs are never "externally funded" | `card_payments_unresolved_credit` |
| 8 | Retry-on-read stays out of I1 | The read path never evaluates |
| 9d | HTTP 200 for `updating` and `unavailable` | As decided |
| — | One single-statement snapshot function; amends §7.4 | §2 |
| — | Limits: 10 000 transactions, 25 000 splits | In the function |
| — | Level-1 beyond one response: the function, else fail closed | §2 |
| — | Drill-down continuation by fingerprint; 409 on change | §3 |
| — | Every published amount has a drill-down; the contract is not narrowed | §3, and the coverage test in §6 |

Classified by the independent review as safe implementation details: snake-case wire names; the distinct card-state integrity error; a page exceeding its limit to keep a transaction whole (already required by §7.3).

## 6. Tests

**Converted or replaced in revision 1, unchanged in revision 2**

- **Three `it.fails` → `it`** (`semanticAggregation.test.ts`), as the pairing design §5 requires: two through a stored user pair, R7 through the excluded card.
- **Two `it.todo` removed** (`cardPaymentMatching.test.ts`), now real tests; the file's coverage table names where. Three remain.
- **Slice-1 characterization tests replaced** with the approved rule's expectations.

**Changed in revision 2**

- **§9.1 "checking not linked":** the card leg is an unresolved card credit of 900, no longer "externally funded 900". Three related assertions changed the same way.
- **The paged-read tests** (`dataService.aggregatePaging.test.ts`) were replaced by `dataService.aggregateReads.test.ts`: single request with exact count, snapshot beyond one response, fail closed.
- **The two `getCategorySpendRows` tests** in `dataService.test.ts` are the parent's again, with the exact counts added. The two `getTransactionsSince` tests gained a count of zero.
- **The input-version read** and its tests were removed with the version bracket.

**Added in revision 2**

| Finding | Regression coverage |
|---|---|
| F1 | A pending row replaced by its posted row around a read is counted once, for the summary, the budget and both spending drill-downs |
| F2 | Principal-only edits and a split re-allocation give one committed state or the other, never a mixture |
| F3 | A later page after any change to the result is refused; an unchanged result continues; a change elsewhere does not restart; stale is `updating`; the cursor is bound to its query |
| F4 | A month created or removed around a request is in both halves or neither; `alignMonths` refuses a one-sided month |
| F5 | The coverage test enumerates the published wire fields, not the measure list; unbucketed spending and unknown principal reconcile |
| F6 | The integration check (§7) |
| F7 | A repeated or structured `measure` is refused; a cursor with an impossible date is refused |
| Review note | The error handler's import graph never reaches the data service, the read path or the configuration |

**Sensitivity.** The mutation checks are in the evidence folder, with each mutant's full test output.

## 7. Local Data API integration check

`supabase/tests/read_path_integration/run.sh` starts a throwaway local stack (PostgreSQL 17.6.1.155, PostgREST v16.2, Kong 2.8.1) with the pinned Supabase CLI 2.117.0, from a scratch copy of the config and migrations, on its own ports. It runs the backend's compiled services through the real service-role client and compares every result with direct SQL in integer cents. It removes the stack afterwards. It is not a CI step.

It covers:

- **Static dataset:** 1 500 generated transactions for one user over 13 months, 1 002 splits, a second user's sentinels and an excluded account's sentinels.
- **The snapshot:** counts, cents, exact row identity and order against SQL; not capped at 1 000; nothing of the other user or the excluded account; nested and open-ended ranges; card states; the anon key refused.
- **The frozen reads:** the Data API cap at 1 000; the exact count equals SQL's count for the same nested filters; one request when the range fits; one capped request then one snapshot when it does not.
- **The read path:** summary, budget and drill-downs against SQL.
- **Scheduled cases, with explicit barriers:**
  1. a pending row replaced by its posted row, committed right after the response and also held open by another session;
  2. principal-only edits, which leave the matching version unchanged;
  3. a watched input changed right after the snapshot: the read is the before-state, the next is `updating`, and after a standalone evaluation the next is `ok` with no sync.
- **The limits**, and the rollback: without the function a level-1 read that fits still works, a larger one fails closed, level 2 is `unavailable`, and the migration re-applies.

Results and measurements are in the evidence folder.

## 8. Remaining work, risks and limits

- **Retry-on-read is not built.** A later read observes fresh state once some existing evaluator has run. The read path never evaluates, so a user left stale by an account toggle, a loan link, a role change, or a sync with the evaluation flag off stays `updating`. Autonomous recovery is a separate packet.
- **The limits fail level-1 requests too.** A range over 10 000 transactions fails with `aggregate_too_large` for every client. Before I1 it was silently truncated at the row cap.
- **The level-1 budget read is still two statements** (transactions, then splits), as on `main`. That exposure predates I1 and is unchanged. A level-2 budget read is one snapshot.
- **`card_payments_unresolved_credit` is a signed net.** The approved name is one field; payments into the card and reversals are netted. Confirm that is the intended reading.
- **Category objects in a level-2 budget response list their keys in a different order** from a level-1 response (the snapshot returns `jsonb`, which orders keys its own way). The fields and values are identical, and JSON does not treat key order as significant. The integration check records both orders.
- **Hosted behaviour is unmeasured:** the hosted row cap, statement timeouts and payload limits. The exact count makes the frozen reads independent of the cap's value.
- **Transfer pairing is quadratic in the number of transfer legs**, and every aggregate resolves it. The drill-down recomputes the whole bucket for every page. Neither was measured at the limits.
- **The unresolved measures are reconciliation rows only.** A "card payments to review" list, with candidates and actions, is later work.
- **Unused exports:** the `(date, id)` and `(transaction_id, id)` key builders in `fetchAllPages.ts` have no application caller now. They are kept with their tests.
- **Still gates, unchanged:** the three remaining todos, institution-removal conversion, other-writer evaluation, frontend, the Phase A backfill, preflight and postflight, and independent verification plus CI on the actual candidate.

## 9. Corrections to revision 1

- **"A pending row and its posted replacement briefly coexist, as today" was wrong.** The v2 sync RPC removes the pending row and inserts the posted one in a single transaction; no committed state holds both. Only a read made of several requests could see both.
- **"Rows and states are one version" was wrong.** The matching version does not cover principal, the loan link, categories or splits.
- **"All semantic paths require level 2" was wrong** in revision 1: the drill-down endpoint had no gate. It has one now.
- **"Recovery" overstated what was tested.** The tests changed mocked state externally. They show later-read observation, not autonomous recovery.
- **"Linear in the period's rows" was wrong.** See §8.
