# Financial Semantics Phase B — Design for review

**Status:** revision 6, approved at design level (Codex). **Implementation slice 1 in progress** on
`feature/phase-b-aggregation-slice1` — see §14. No migration, endpoint, production data or live
calculation has been changed by Phase B.

**Reconciled 2026-09-29 with the completed continuity release** (`PENDING_POSTED_CONTINUITY_RELEASE.md`):
pending→posted continuity shipped in PR #6 (merge `a1b4120`), migration `20260927120000` is applied in
production, and PR #7 (`ea5c90f`) closed the release out. References below that described continuity as
future work now say so; no Phase B product decision was changed. Genuinely open questions found while
implementing are in §13.

**Revision 6:** §9.1 refund-tie fixture corrected — the competing original 8f is dated **09-18** (7 days
before the 09-25 refund, the same distance as 8a), not 09-11 (14 days), so the case actually produces
a tie. Codex confirmed the Phase B refund and RPC changes of revision 5 as resolved.

**Revision 5 — changes from Codex's second review:**
1. §4.9: refund-dependent discovery now uses Phase A's **actual** eligibility and ranking
   (`findRefundOriginalCandidates` + `rankRefundCandidates`): same account, original amount ≥ the
   refund (partial refunds), identity match, exact-amount preference, closest date, tie → ambiguous;
   it runs when the primary row's effective role changes in **either** direction, because a new
   eligible original can make an existing match ambiguous.
2. §6.2/§6.1: the override RPC returns **one** `jsonb` value `{ rows, dependents_reset }` (a `setof`
   with an out-parameter was not a valid signature).
3. §9.3 `c11`: the link-versus-override race now expects the later-arriving override to be **refused**
   (`role_stale`, and it would also lack the loan acknowledgement) when the link commits first.
**Decided (Trevor, 2026-09-26):** D1, D2, D3, D4, D6, D7, D10, D12, D13, D14 as recommended; D15 = (b);
the direction of D5, D8 and D11 agreed; D9's product behaviour accepted, its dependent-row write
required a complete atomic design (now §4.9 / §6.2, revision 4). Continuity C1–C5 agreed.

**Revision 4 — changes from Codex's review:**
1. §4.9/§6.2: the override RPC **discovers** dependent transfer-partner and refund rows itself, in SQL,
   under the per-user lock — completeness is by construction, not by validating a list assembled
   before the lock. The single-row and two-row forms are one RPC (array form). The SQL fallback is
   asserted equal to the compiled classifier by the harness.
2. Text/tests reconciled: the half-linked transfer rule (§4.2) now follows the tracked-set principle;
   `by_category`, `total_spent`, `total_income`, `spent`, `recent_avg_spent` are frozen everywhere
   (§5, §9); the loan acknowledgement is an object everywhere (§9.4); recurring streams are merged or
   retained, never "covered" (§4.7, §8.1); an ambiguous stream match keeps the bill (§4.8).
3. §9.1: the savings-account-excluded variant's legacy cash flow is **1 325**, not −135 — equal to the
   Phase B figure, as §6.4 predicts; legacy figures added for the other variants.
4. §6.2: `user_role_override_at` and `replace_transaction_splits` are created by the continuity
   migration (`PENDING_POSTED_CONTINUITY_DESIGN.md` §4/§6); Phase B replaces the splits function to
   add the role-eligibility check and reuses continuity's mutation-RPC pattern.

**Revision 3 — changes from Trevor's second review:**
1. Continuity is now its own document, `PENDING_POSTED_CONTINUITY_DESIGN.md` (covers removal-before-
   posting, an override racing a posting, and approval on an amount change). Appendix A points to it.
2. §4.1–4.3: the **tracked-set principle**. Cash flow measures the accounts included in cash flow.
   A card payment or transfer whose other leg is on an account that is unlinked **or excluded from
   cash flow** is a real flow and counts (signed, labelled); only legs whose partner is inside the
   tracked set net to zero.
3. §4.8: a recurring card or loan payment and its liability/loan item are **merged into one** upcoming
   item at the expected amount (never only the minimum, never twice).
4. §4.9/§6: an override no-op is judged on the **stored** override, not the effective role; the loan
   acknowledgement carries the acknowledged amounts and is verified under the lock; dependent
   relational rows (a transfer partner, refunds matched to this row) are reset **in the same RPC**,
   so a 200 never leaves totals inaccurate.
5. §6.4: legacy fields (`spent`, `income`, `total_spent`, …) keep their sign-based meaning forever;
   Phase B semantics arrive in **new** fields. A level-1 bundle therefore shows exactly today's
   numbers (1 827.10 for the fixture), not a hybrid.
6. §4.1: positive `refund` overrides defined; §7.3: a drill-down's loaded subtotal vs its complete
   total; §8.4: the rollback that reset backfilled `auto_role` rows is removed.
7. §8: production facts (historical audit, Trevor's read-only check on 2026-09-26 — not re-verified since) — 221 transactions in the last 12 months, **219 with `auto_role IS NULL`**; the
   Phase A backfill stays a release gate; D15 = (b), pagination ships inside Phase B.
**Baseline inspected:** `main` at `0916de0` (Linked Institution Management V1 released; production
migration head `20260926120000`).
**Author:** Claude (Fable 5.1), 2026-09-26. **Reviewers:** Trevor (product decisions in §12), then
Codex (financial / migration / release-critical).

**Revision 2 (same day) — changes from Trevor's review of revision 1:**
1. §4.1/§12 D2–D3: *Cash flow* is defined as cash retained after debt service; *Savings rate* adds
   back **known** principal only. No claim is made about interest inside an unlinked Plaid loan
   payment (its split is unknown; the whole payment is a debt outflow).
2. §4.3/§12 D5: a card payment whose card is not linked never disappears from cash flow. It is an
   **untracked card outflow**, detected per payment by pairing with a leg on a linked `credit`
   account, subtracted in cash flow and labelled separately.
3. §4.8/§12 D8: recurring `LOAN_PAYMENTS`/`TRANSFER_OUT` streams stay in Upcoming bills unless their
   latest occurrence is shown to be *covered* by another upcoming item or to be an internal transfer.
4. §7.3: drill-downs are served by an **effects** endpoint (effect-aware, split-aware) whose rows
   reconcile to the totals by construction; the feed's role filter is documented as a row filter.
5. §7.4: every aggregate fetch pages internally — Supabase's default 1 000-row response cap means
   today's range totals can already be silently truncated. Flagged as a probable live defect.
6. §4.1 R0/R9 and Appendix A: `SemanticIntegrityError` is surfaced, never masked by the NULL-role
   fallback; pending→posted continuity gets its own atomic design (amount changes, exact loan
   restoration, idempotent retry); split replacement becomes one atomic RPC.
7. §4.9/§6: overriding a linked loan payment requires an explicit acknowledgement of the reporting
   consequence; the two-row transfer correction is one atomic RPC with defined failure handling;
   §6.4 shows why an old client is safe with `MIN_CLIENT_API_LEVEL = 0`; rollback keeps
   `user_role_override_at`.

Phase A (`20260912120000_transaction_semantic_roles.sql`, `transactionClassifier.ts`,
`roleReconciliation.ts`, `semanticEffects.ts`) stores a semantic role for every transaction but no
calculation reads it. Phase B makes every user-facing money calculation read the roles, lets the user
correct a role, and replaces the 200-row transaction cap with real pagination. The V1 decision this
implements: *"ALL meaningful user-facing calculations adopt semantic roles, and user role correction is
REQUIRED in V1"* (roadmap, 2026-09-25).

---

## 1. What exists today (audit)

### 1.1 The role model (Phase A, unchanged by this design)

| Column | Meaning |
|---|---|
| `auto_role` | classifier output: `expense`, `income`, `internal_transfer`, `credit_card_payment`, `debt_payment`, `refund` |
| `role_source` | how it was decided: `manual_loan_link`, `category_detailed`, `category_primary_fallback`, `category_detailed_account_transfer`, `account_pair_match`, `refund_match`, `transfer_like_unconfirmed`, `sign_default` |
| `role_confidence` | `high` / `medium` / `low` |
| `classifier_version` | `1` today (`CURRENT_CLASSIFIER_VERSION`) |
| `user_role_override` | the user's correction; **exists, but no API or UI writes it** |
| `effective_role` | generated: `coalesce(user_role_override, auto_role)` |

Classifier precedence (`classifyCore`): A manual-loan link → `debt_payment`; B
`LOAN_PAYMENTS_CREDIT_CARD_PAYMENT` at HIGH/VERY_HIGH → `credit_card_payment`; C any other
`LOAN_PAYMENTS` → `debt_payment` (low); D `TRANSFER_*_ACCOUNT_TRANSFER` at high confidence →
`internal_transfer`; E other `TRANSFER_IN`/`TRANSFER_OUT` → sign fallback tagged
`transfer_like_unconfirmed`, upgraded to `internal_transfer`/`account_pair_match` only when
reconciliation finds a reciprocal opposite-amount row in another of the user's accounts within ±3 days;
F sign fallback (`+` = `expense`, `−` = `income`). Reconciliation also upgrades a negative
`sign_default` row to `refund`/`refund_match` when a matching earlier expense (same merchant identity,
same amount) exists within 120 days. `getSemanticEffects()` is the declared aggregation contract: one
effect per row, except a manual-loan-linked row without an override, which yields
`debt_payment(principal)` + `expense(interest)`.

Nothing in the frontend reads any role column; `TransactionItem` (`lib/api.ts`) doesn't carry them.

### 1.2 Every user-facing calculation and how it treats a transaction today

All of these are **sign-based**: `amount > 0` is spending, `amount < 0` is income. All of them already
honour `accounts.exclude_from_cash_flow`.

| # | Surface | Source | Today | Consequence |
|---|---|---|---|---|
| C1 | Overview → *Monthly cash flow* (income − spent, vs last month) | `GET /api/plaid/summary` → `monthly_spending[]` (`plaidController.getSpendingSummary`) | sign | a card payment counts as spending on the checking side **and** as income on the card side; a transfer to savings counts as both |
| C2 | Overview → *Cash flow & budget pace* (income/spending bars, projected spend) | `summary.current_month` (`sumIncomeAndSpent`) | sign | same |
| C3 | Overview → *Monthly spending chart* | `summary.monthly_spending` | sign | same |
| C4 | Income & Savings → *Savings rate* `(income − spent)/income` | `summary.current_month` | sign | gross income and gross spend are both inflated by transfers/payments; the *rate* is wrong whenever the two legs are not both linked |
| C5 | Monthly Breakdown (Plaid taxonomy, per month, per category, drill-down) | `GET /monthly-breakdown` → `aggregateByMonth` | sign | `LOAN_PAYMENTS` and `TRANSFER_OUT` appear as spending categories |
| C6 | Budget → per-category `spent` and `recent_avg_spent`; Cash Flow Pace's budget total; Safe to Spend's *remaining budget* | `GET /api/budget-categories` → `getCategorySpendRows` (parent row **or** its splits) | sign, no role | a card payment the user filed under a "Credit card" budget category is "spending" |
| C7 | Safe to Spend | frontend `computeSafeToSpend` = liquid cash − upcoming bills − credit-card minimums − remaining budget − buffer | balances + recurring streams + Plaid liabilities + C6 | role-blind twice: C6 (remaining budget) and recurring "bills" that are really card payments or transfers (see C9) |
| C8 | Net worth, Liquid cash, Net worth chart | account **balances** + `net_worth_snapshots` | balance-based | **correct as is** — roles never apply to balances (§4.7) |
| C9 | Subscriptions & Recurring; Overview *Upcoming bills*; Safe to Spend's bills | `recurring_streams` (Plaid), `loans` (Plaid liabilities) | Plaid streams, no role | a monthly card-payment stream is a "bill" **and** the card's `minimum_payment_amount` is a credit-card minimum → double counted in Safe to Spend; a monthly transfer to savings is a "bill" |
| C10 | Transactions feed (Accounts tab), Recent activity | `GET /transactions?limit=` (API cap **200**, `TRANSACTIONS_FETCH_LIMIT = 200`) | sign for the ± display | no role shown; nothing to correct; every filter and both drill-downs (`budgetDrilldown.ts`, `monthlyBreakdownDrilldown.ts`) run over the ≤200 fetched rows, so a drill-down silently under-reports once a month has more than the cap |
| C11 | Loans tab (manual-loan payment history, lifetime totals) | `manual_loans`, linked transactions, `manual_loan_payments` | link-based | correct as is; not a role consumer |

Also relevant: `exclude_from_cash_flow` (account flag) is applied in C1–C6 and stays exactly as is.
`iso_currency_code` is USD-only by configuration (README "Financial precision"); unchanged.

### 1.3 Two prerequisites the roadmap already names

1. **Pending → posted continuity is released** (D1, decided and done: PR #6 merged as `a1b4120`,
   migration `20260927120000` applied in production, closeout PR #7 `ea5c90f`). Its design is
   `PENDING_POSTED_CONTINUITY_DESIGN.md`; the properties Phase B relies on are its §3 (P1–P5):
   corrections including `user_role_override` survive posting in every arrival order, the loan ledger
   stays exact, and a mutation racing a posting gets `409 transaction_superseded` and re-targets.
2. **Production was almost entirely unclassified at the 2026-09-26 audit.** That historical read-only check (Trevor, 2026-09-26; not re-verified since) found 221
   transactions in the last 12 months, **219 of them with `auto_role IS NULL`** — the Phase A
   backfill never ran, and relational reconciliation (transfer pairing, refund matching) has never
   run over history either. Consequences: rule R0 (§4.1) must be correct because it is the common
   case until the backfill runs; the backfill is a **release gate** (§8.2); and the before/after
   snapshot (§8.1-10) is taken after the backfill so it isolates Phase B's effect.

---

## 2. Goals, non-goals, invariants

**Goals**
- G1. Every calculation in §1.2 marked "sign" reads roles through one shared contract.
- G2. The user can set or clear `user_role_override` on any transaction, safely (ownership, atomicity,
  concurrency), and the change is reflected everywhere at once.
- G3. Transaction listing is paginated server-side; every filter and drill-down is correct beyond 200
  rows.
- G4. Production data is reclassified where needed, with a dry run first, and every step is reversible.
- G5. The numbers are explainable: every headline figure can show what was excluded and why.

**Non-goals (explicitly unchanged)**
- Manual-loan balance semantics: `principal_portion`, `loan_balance_applied`, the invariant
  Σ restored = Σ `loan_balance_applied`, balance-as-of (separate design), link/unlink/deletion RPCs.
- Linked Institution Management: removal scope, state machine, `plaid_item_removals`.
- The Phase A classifier's rules (`CURRENT_CLASSIFIER_VERSION` stays 1) — see §12 D10 for the
  deliberately deferred "classifier v2" items.
- Net worth math, snapshots, liquid cash (§4.7).
- Service-worker architecture, API-level machinery; `MIN_CLIENT_API_LEVEL` stays `0`.
- Multi-currency, investments, category groups.

**Invariants Phase B must keep**
- I1. Σ over a row's semantic effects = the cent-rounded row amount (`getSemanticEffects`).
- I2. Reporting never changes bookkeeping: an override never touches `manual_loans.current_balance`,
  `principal_portion`, `loan_balance_applied`, splits or budget categories.
- I3. Later automation never resets an explicit user choice: sync/backfill/reconciliation never write
  `user_role_override` (Phase A contract), and Phase B adds no path that does.
- I4. A calculation never fails because a row is merely *unclassified*: a NULL role degrades to the
  sign fallback **and** is reported (§4.1 R0). A row whose loan-linked data is *inconsistent*
  (`SemanticIntegrityError`) is a genuine integrity failure and is surfaced, never masked (R9).
- I6. Every total the UI shows can be drilled into, and the rows shown sum exactly to it (§7.3).
- I7. No aggregate is computed from a truncated fetch (§7.4).
- I5. Every aggregate that excluded money can say how much it excluded (G5).

---

## 3. Architecture: one aggregation contract, three layers

```
transactions (+ splits) ──► fetch rows with role columns (dataService, per range, per user,
                            exclude_from_cash_flow applied)            ──► semanticAggregation.ts
                                                                          (pure; getSemanticEffects
                                                                           + the rules in §4)
                                                                        ──► controllers shape the
                                                                            response (summary,
                                                                            monthly-breakdown,
                                                                            budget-categories)
frontend: renders; never re-derives spend/income from signs (delete the ± assumptions in
budgetDrilldown.ts / monthlyBreakdownDrilldown.ts; drill-downs read effect rows from the server,
§7.3, so what is listed always sums to the total shown)
```

Every fetch feeding an aggregate pages internally (§7.4); the pure module also performs the
card-payment leg pairing (§4.3) and emits the effect rows the drill-downs display (§7.3), so totals
and their breakdowns can never be produced by two different code paths.

- **Where the rules live:** a new pure module `backend/src/services/semanticAggregation.ts`
  (`aggregateCashFlow`, `aggregateBudgetSpend`, `aggregateMonthlyBreakdown`), calling
  `getSemanticEffects()` for every row. No SQL view: the contract module already says every
  dollar-aggregating calculation must go through `getSemanticEffects()` (manual-loan decomposition
  can't be expressed by `WHERE effective_role = …`), the data volume is personal-scale, and the pure
  module is directly testable with the fixture in §9.
- **What the DB fetches change:** `getTransactionsSince` / `getCategorizedTransactionsSince` /
  `getCategorySpendRows` select the role columns and `manual_loan_id, principal_portion`. Same
  filters, same ranges. Splits are fetched as today (two queries) and combined in the module.
- **Role classification itself is untouched.** Phase B only *reads* `effective_role`,
  `user_role_override`, `role_source`, `role_confidence`.

---

## 4. The rules

### 4.1 Effect → aggregate mapping

Every row produces effects via `getSemanticEffects()`; each effect is `{role, amount}` with `amount`
carrying the Plaid sign (`+` out, `−` in). Rules:

| Effect role | Spending | Income | Debt payments | Known principal | Informational | Cash flow | Notes |
|---|---|---|---|---|---|---|---|
| `expense` (+) | + | | | | | − | ordinary spend; splits apply (§4.6) |
| `expense` (−) | − (refund-like) | | | | | + | a negative row overridden to `expense` reduces spending |
| `income` (−) | | + | | | | + | |
| `income` (+) | | − | | | | − | a positive row overridden to `income` (a reversed deposit) reduces income |
| `refund` (−) | − | | | | refunds | + | reduces spending in the refund's month and category (§4.5); **never** income |
| `refund` (+) | **+** | | | | refunds (reversed) | − | a positive row overridden to `refund` is a **refund reversal** (a chargeback re-debit, a returned refund): it adds back to spending in the same category; the picker warns about the unusual sign |
| `credit_card_payment`, **tracked** (cash-side leg paired with an opposite credit-side leg on an included `credit` account; §4.3) | | | | | card payments (tracked) / returns (tracked) | 0 | both legs excluded; the purchases were the spending — a matched return nets to zero the same way |
| `credit_card_payment`, **untracked outflow** (+, partner leg missing **or on an account excluded from cash flow**; §4.3) | | | | | card payments (untracked) | **−** | money left the tracked set; its purchases are invisible to cash flow: subtracted, labelled with the reason |
| `credit_card_payment`, **untracked return** (−, on a cash-side (non-credit) account, no credit-side partner; §4.3) | | | | | card payments (returned, untracked) | **+** | a payment came back into an included account: the cash arrived, so it is added — the counterpart of an untracked outflow |
| `credit_card_payment`, **externally funded inflow** (−, on a credit account, no cash-side leg in the tracked set; §4.3) | | | | | card payments (externally funded) | 0 | a liability fell by money from outside the tracked set; no tracked cash moved |
| `credit_card_payment`, **reversed externally** (+, on a credit account, no cash-side leg in the tracked set; §4.3) | | | | | card payments (reversed externally) | 0 | a payment was reversed on the card; its cash side is outside the tracked set |
| `internal_transfer`, **within the tracked set** (partner leg on an included account; §4.2) | | | | | transfers (internal) | 0 | nets to zero |
| `internal_transfer`, **external** (partner leg missing, or on an account excluded from cash flow; §4.2) | | | | | transfers (external) | **signed** | money moved between the tracked set and outside it: counted in cash flow with its sign, never as spending or income |
| `debt_payment` (+), manual-loan principal | | | + | + | | − | from `getSemanticEffects`; its interest is a separate `expense` effect |
| `debt_payment` (+), Plaid-categorised, no manual link | | | + | | | − | whole amount; split unknown, so **no** part is called interest or principal |
| `debt_payment` (−) | | | − | | | + | a reversed loan payment |
| **NULL** effective role (R0) | sign fallback | sign fallback | | | | sign | counted exactly as today **and** counted in `unclassified_count` / `unclassified_amount` (I4, I5) |

**The tracked-set principle.** Cash flow measures the accounts **included** in cash flow (not
`exclude_from_cash_flow`, and linked). Money that moves *within* that set nets to zero and is only
informational. Money that moves *between the set and the outside* — an unlinked account, an account
the user excluded from cash flow, an unlinked card — is a real flow: it counts in cash flow with its
sign and is labelled by what it is, but it is never Spending or Income (those are consumption and
earning categories). Partner detection for card payments and transfers therefore considers **only
legs on included accounts** as partners; a leg on an excluded account is, for cash-flow purposes,
outside. This is what makes "a payment to a credit account excluded from cash flow still registers as
an outflow from the included checking account" hold (Trevor's item 2), and it is symmetric for
transfers.

Definitions (R1–R6):

- **Spending** = Σ expense effects (signed) + Σ refund effects (signed: refunds negative, reversals
  positive). Never includes transfers, card payments or debt payments. Manual-loan *interest* is in
  Spending because it is a real, known `expense` effect; the interest inside an unlinked Plaid loan
  payment is **unknown** and is not in Spending (it stays inside Debt payments).
- **External transfers** = Σ signed `internal_transfer` legs on included accounts whose partner is not
  in the tracked set (a transfer to an unlinked brokerage: −; a transfer in from an excluded savings
  account: +). Reported as "Transfers to/from accounts not tracked" and counted in cash flow; a user's
  single-row override to Transfer moves a row here **out of Spending without making the money
  vanish** (fixture #9). Not added back in the Savings rate — the app cannot verify it was saved.
- **Income** = Σ income effects (as positive magnitudes).
- **Debt payments** = Σ debt-payment effects: known principal of manual-loan-linked rows **plus** the
  whole amount of Plaid-categorised loan payments that have no manual link (§12 D3).
- **Known principal** = Σ debt-payment effects that came from a manual-loan link (the
  `principal_portion` ledger). Exactly known; a subset of Debt payments.
- **Untracked card outflows** = Σ positive cash-side `credit_card_payment` legs with no paired leg on a
  linked `credit` account (§4.3).
- **Untracked card returns** = Σ |negative cash-side `credit_card_payment` legs| with no paired leg on a
  linked `credit` account — a returned payment arriving in an included account (§4.3).
- **Cash flow** = Income − Spending − Debt payments − Untracked card outflows + Untracked card returns
  + External transfers (signed). **This is cash retained after debt service**: what stayed in the user's tracked accounts
  after consumption, every debt payment (principal or not), money sent to cards this app cannot see
  into, and money moved to or from accounts outside the tracked set. Tracked card payments and
  internal transfers are excluded because they move money between the user's own tracked
  balance-sheet lines and net to zero. Externally funded card inflows are excluded because no
  tracked *cash* moved (a liability fell; cash flow is a cash view — the balances already show it).
- **Savings rate** = (Cash flow + Known principal) / Income (0 when Income ≤ 0). Known principal is
  added back because paying it raises net worth exactly as saving does. Nothing is added back for a
  Plaid-categorised loan payment: its principal is unknown, so it is left as an outflow — the rate
  is conservative for users with unlinked loans, and the card says so ("$300 of loan payments with
  an unknown principal share counted as outflow"). (§12 D2 — the alternative definitions are there.)

Every aggregate response also returns the excluded/informational totals (`transfers_internal`,
`transfers_external` (signed), `credit_card_payments_tracked`, `credit_card_payments_untracked`,
`credit_card_payments_externally_funded`, `debt_payments`, `known_principal`, `refunds` (signed),
`unclassified_count`, `unclassified_amount`) so the UI can show "what's not in this number" (G5).
These arrive in **new** fields; the pre-existing fields keep their sign-based meaning (§6.4).

**R9 — integrity failures are not fallbacks.** `getSemanticEffects()` throws `SemanticIntegrityError`
for a manual-loan-linked row whose amount/`principal_portion` is impossible (Round 3 §9 of Phase A).
Phase B preserves that: the aggregate request fails with 500 and a sanitised body
`{ code: 'semantic_integrity_error', transaction_id }` (the user's own row id, nothing else), and the
UI shows "One loan payment has inconsistent data, so these figures are paused. Open it to fix or
unlink it." — never a plausible-looking number. R0 applies **only** to `effective_role IS NULL`.

### 4.2 Transfers

- `internal_transfer` rows are never Spending or Income. Whether a leg counts in **Cash flow** follows
  the tracked-set principle (§4.1): the aggregation module finds the leg's partner among the fetched
  rows (opposite sign, equal cents, another account, ±3 days — the same rule reconciliation used to
  pair it; the fetched context is padded per the contract in §4.3). Partner on an **included** account → both legs net to
  zero (internal). Partner on an account **excluded from cash flow**, or no partner (a transfer to an
  unlinked account, a `category_detailed_account_transfer` single leg, a user's single-row override)
  → the leg is an **external transfer**, counted in cash flow with its sign and shown on its own line.
  A transfer between two included accounts still nets to zero and leaves Net worth and Liquid cash to
  the balances (where they belong).
- **Unpaired transfer-like rows** (`transfer_like_unconfirmed`, i.e. Plaid says `TRANSFER_OUT`/
  `TRANSFER_IN` but no reciprocal leg was found — Venmo/Zelle to a person, a transfer to an unlinked
  brokerage, a transfer whose other leg is on an `exclude_from_cash_flow` account): they keep their
  sign fallback (`expense`/`income`) **and are surfaced for review** (§6.3) with one-tap "Mark as
  transfer". Rationale: hiding them would hide real spending (a Venmo payment to a friend *is*
  spending); counting them keeps today's behaviour until the user says otherwise. (§12 D4.)
- Half-linked pairs: reconciliation pairs across **all** the user's accounts, so if one leg's account
  is `exclude_from_cash_flow` the other leg is still `account_pair_match`/`internal_transfer` — its
  *role* is right. But for **cash flow** the partner is outside the tracked set, so that leg is an
  **external transfer** (counted, signed, labelled "to Savings, which you excluded from cash flow"),
  not an internal one. Role and cash-flow treatment are deliberately different questions.

### 4.3 Credit-card payments

- A card payment has two legs: the payer side (`+`, usually a depository account) and the card side
  (`−`, a `credit` account). Plaid labels both `LOAN_PAYMENTS_CREDIT_CARD_PAYMENT` (classifier step B
  is sign-agnostic), so both classify as `credit_card_payment`.
- **Tracked payment** (both legs present on the user's accounts): excluded from Spending, Income and
  Cash flow. The purchases on the card were the spending; the payment settles a liability that the
  app can see. Nets to zero.
- **Untracked card outflow** (payer leg with no card leg **in the tracked set**): the money left the
  tracked accounts and the purchases it settles are invisible to cash flow, so it **must not vanish
  from cash flow**. Two reasons produce it, both labelled: the card is **not linked** ("Card payments
  to a card that isn't linked — link it to see that spending"), or the card is linked but **excluded
  from cash flow** ("Card payments to Chase Sapphire, which you excluded from cash flow"). In both
  cases the leg is excluded from Spending (it is not consumption we can categorise), reported on
  its own line, and **subtracted in Cash flow** (§4.1). A row can be overridden to `expense` if the
  user prefers to see it as spending.
- **Externally funded inflow** (a credit-side −leg with no cash-side leg — the card was paid from an
  account this app does not track): the liability fell by money from outside the tracked set. Excluded
  from Income and Cash flow, reported as "Card payments funded from an unlinked account".
- **Returned card payments** (Codex review of slice 1). A payment can come back: the bank returns it
  or the user reverses it. Legs are told apart by the ACCOUNT, not only the sign — a leg on a `credit`
  account is the liability side, any other account holds cash:
  - cash −, paired with a credit + → **tracked return**, 0 (like a tracked payment);
  - cash −, unpaired → **untracked return**: the money arrived in an included account, so it is
    **added** in cash flow. It is the exact counterpart of an untracked outflow, so a payment to an
    untracked card and its return net to zero; never income;
  - credit +, unpaired → **reversed externally**, 0 (the cash side is outside the tracked set).
  Pairs are always one cash-side and one credit-side leg of opposite cents, so a payment can never
  pair with a return and nothing is counted twice. Two cash-side legs never pair: each counts once as
  cash, so money moved between two included accounts nets to zero.
- **Pairing is per payment, never per user.** Having *some* linked credit account proves nothing
  about *this* payment's card. A cash-side leg is tracked iff there is exactly one unmatched
  `credit_card_payment` leg of the opposite sign and equal cent amount on one of the user's
  **included** `type = 'credit'` accounts within ±5 days (card payments post with a delay); the
  match is reciprocal (the same rule shape as Phase A's transfer pairing); an ambiguous or missing
  match leaves the leg untracked. Legs on accounts excluded from cash flow are **not** candidates
  (§4.1 tracked-set principle): a payment to an excluded card is an outflow from the included
  checking account, and the fetch for aggregates simply doesn't load excluded accounts' rows.
  Pairing is computed inside the aggregation module over the fetched rows. **Fetched-context
  contract:** the caller supplies every row in `pairingContextRange(period)` = [start − 10 d, end + 10 d)
  — `PAIRING_PAD_DAYS` is **twice** the widest matching window, because reciprocal matching is two
  hops deep: an in-period leg's candidates are within one window, and whether a candidate's own best
  match is that leg (or a tie with a competitor) needs the candidate's candidates, one more window
  out. The matching windows themselves stay ±3 days (transfers) and ±5 days (cards). With this pad
  the in-period result is identical to the result over complete history (tested); with one window of
  padding a competitor that makes a match ambiguous is missed and the leg is wrongly paired (e.g. a
  Sep 1 payment whose card leg on Aug 28 is equally close to an Aug 24 payment). Nothing is
  persisted; the same rows always pair the same way.
  Persisting card-payment pairs (a `role_source` value, like `account_pair_match`) is Phase C.
- Residual risk, accepted for Phase B: a payment to a *linked* card whose legs fail to pair (amount
  differs by a fee, or the card leg is more than 5 days late) is counted as an untracked outflow
  while its purchases are also spending — a temporary double count that self-corrects when the leg
  arrives, and is visible in the "untracked" line. (§12 D5.)
- Budget categories that today hold card payments (a "Credit card" category) will fall to ~$0
  spent. §8 preflight lists them; the UI shows "Card payments and transfers no longer count as
  spending" on the Budget tab once. No automatic archiving. (§12 D12.)

### 4.4 Debt payments

- Manual-loan-linked rows: unchanged decomposition — principal → Debt payments, interest → Spending
  (Plaid category `LOAN_PAYMENTS`; shown in Monthly Breakdown under a synthetic **"Loan interest"**
  category so it isn't mixed with the principal bucket — §12 D13).
- Plaid-categorised loan payments without a manual link (`category_primary_fallback`, `debt_payment`,
  low confidence): the whole amount is a Debt payment. Shown as its own line everywhere ("Debt
  payments $X, of which $Y has an unknown principal share"), excluded from Spending, subtracted in
  Cash flow, and **not** added back in the Savings rate. The design makes no claim that any part of
  it is interest or principal. The user can (a) create a manual loan and link the payment to get a
  real split (then the principal becomes known and the interest becomes spending), or (b) override
  the row to `expense` if it is really spending (e.g. Plaid mis-labelled a BNPL purchase). (§12 D3.)
- Loan *interest* on Plaid liabilities (mortgage/student/credit) is not observable per transaction;
  Phase B does not estimate it.

### 4.5 Refunds

- A `refund` effect reduces Spending in the **month of the refund** (not the original's month —
  historical months stay as recorded, the same principle Net worth history follows) and in the
  category the refund row carries: its `budget_category_id` for Budget (auto-mapped from Plaid's
  category like any other row, editable by the user), and its Plaid `category` for Monthly Breakdown.
  A refund with no budget category reduces the Budget tab's *unassigned* total only.
- Category totals **can be negative** in a month (a $60 refund of last month's $60 purchase); the UI
  renders `−$60.00 (refund)` rather than clamping. Cash Flow Pace's *budget total spent* uses the
  signed sum. Safe to Spend's `computeRemainingBudget` already clamps per category at ≥ 0, which is
  correct (a negative spend just means the full budget is still available).
- No new link to the original transaction is persisted in Phase B (reconciliation's `refund_match`
  doesn't record it today). §12 D6 offers the alternative (`refund_of_transaction_id`) if you want the
  refund to inherit the original's *budget* category automatically.
- A negative row that is really income but got `refund_match`ed (same amount from the same payer
  within 120 days — e.g. a repeated reimbursement) is corrected by overriding to `income`.

### 4.6 Splits

Splits (`transaction_splits`) exist only to reallocate a parent's amount across **budget categories**;
they carry no role of their own. Rules:

- A split inherits its parent's *single* effective role. Splits contribute to Budget spend only when
  that role is `expense` or `refund`; for `internal_transfer` / `credit_card_payment` /
  `debt_payment` parents the splits contribute nothing (the parent is excluded), exactly as if unsplit.
- A manual-loan-linked parent without an override has **two** effects, and a split over the whole
  amount would make principal look like categorised spend. Rule: such a row's splits are ignored for
  Budget spend; only its interest effect counts (unassigned). `PUT /transactions/:id/splits` refuses
  to create splits on a row whose effective role is not `expense`/`refund`, or that is loan-linked
  without an override, with 409 `splits_not_applicable`; the frontend hides the Split action for
  those rows. Existing splits on such rows are **not deleted** (I3-adjacent: never destroy user data
  in a reporting change) — they are listed by the §8 preflight and shown with a note in the feed.
- Monthly Breakdown never uses splits (it groups by Plaid taxonomy) — unchanged.
- Split validation (Σ splits = amount, cent-exact) is unchanged; a refund's splits are negative
  amounts summing to the negative total (today `hasIncompleteRow` requires positive amounts — the
  frontend validator must allow the sign of the parent). (§12 D7.)

### 4.7 Net worth, Liquid cash, Safe to Spend

- **Net worth and Liquid cash are balance-based and are not changed.** A transfer or card payment
  already nets to zero in balances (cash down, savings/liability down), which is why roles are the
  right tool for the *flow* figures and the wrong tool for the *stock* figures. Documented in the
  UI ("Net worth comes from account balances, not transactions").
- **Safe to Spend** = liquid cash − upcoming bills − credit-card minimums − remaining budget − buffer.
  Two inputs change:
  1. *Remaining budget* now uses role-aware `spent` (§4.1), so a budget that used to look consumed
     by card payments shows headroom again and Safe to Spend goes **down** accordingly — correct,
     because that budget is genuinely still available to be spent.
  2. *Upcoming bills* (§4.8): a recurring card or loan payment and its liability/loan item are
     **merged into one** item at the expected amount, so a $900 card payment is reserved once as $900
     (not twice, and not only as its $35 minimum); internal transfers within the tracked set are not
     bills; a stream nothing else matches stays a bill.
  The formula, toggles and buffer are unchanged.

### 4.8 Recurring streams (Subscriptions & Recurring, Upcoming bills)

`recurring_streams.category` holds Plaid's primary category for the stream, and the table stores no
transaction ids. Two failure modes must both be avoided: reserving a payment **twice** (today: a
$900 card-payment stream as a bill *and* the card's $35 minimum), and reserving only the **minimum**
when the user reliably pays $900 (Trevor's item 3). The rule is therefore **merge, never drop**:

1. Find the stream's latest occurrence: the transaction on `stream.account_id` with
   `|amount − last_amount| ≤ 0.01` and `date` within ±3 days of `last_date`. **Exactly one** match is
   required; none, or several (an ambiguous match), → the stream stays an ordinary bill at its own
   amount. The same rule applies to the liability match in step 2: if more than one Plaid liability
   matches the amount/date, nothing is merged and the stream stays a bill. Ambiguity always resolves
   to *keeping* the reservation, never to dropping or merging it.
2. Decide by that transaction's effective role and pairing:
   - `internal_transfer` **within the tracked set** → **internal**: not a bill (a transfer to the
     user's own included account is not an obligation). An *external* transfer leg stays a bill (a
     planned outflow of tracked cash).
   - `credit_card_payment` that pairs to a linked card → **merged** with that card's liability item:
     one upcoming item, kind `card_payment`, `expected_amount = stream amount` when the stream is
     reliable (Plaid `status = 'MATURE'`, `is_active`), else the liability's `minimum_payment_amount`;
     `minimum_amount` carried for display; due date = the liability's `next_payment_due_date` if
     present, else the stream's estimated next date. Reserved **once**, at the expected amount.
     Label: "Chase Sapphire payment — expected $900 (minimum $35)".
   - `credit_card_payment` untracked (card not linked) → stays a bill at the stream amount (there is
     no liability item to merge with).
   - `debt_payment` linked to a manual loan → **merged** with that loan's upcoming item:
     `expected_amount = max(stream amount, loan payment amount)`, once.
   - `debt_payment` matching a Plaid liability (`last_payment_amount` ±$1, `last_payment_date`
     ±3 days) → **merged** with the liability's item the same way.
   - anything else (a loan with no liability or manual loan, an unmatched occurrence) → stays a bill
     at the stream amount — possibly the only place that payment is visible.
3. A liability or manual-loan item with **no** matching stream keeps today's behaviour (its minimum
   / scheduled payment).
4. `TRANSFER_IN` inflow streams are excluded from *Recurring income* only when the latest occurrence
   is an internal transfer within the tracked set; otherwise kept.

Safe to Spend's "credit-card minimums" line becomes "Card payments" (the merged items' expected
amounts); the loan line likewise. Both stay under the existing *include upcoming bills* toggle. Each
merged or internal stream stays visible in Subscriptions & Recurring under a collapsed group "Counted
once with its card or loan" / "Transfers between your accounts", with its reason. The
recurring-streams response carries `bill_status: 'bill' | 'internal' | 'merged'`, `merged_with`
(liability or manual-loan id) and `expected_amount`. Streams have no per-stream override in Phase B
(Phase C: include/exclude flag). (§12 D8.)

### 4.9 User role corrections

- **Meaning:** an override is a *reporting* decision. It sets `user_role_override`; `effective_role`
  follows; `auto_role`/`role_source`/`role_confidence` are untouched and keep being refreshed by
  reconciliation (Phase A contract), so clearing the override later reveals the best current
  automatic answer.
- **What it never does (I2):** link/unlink a loan, change `principal_portion`, change a budget
  category or splits, approve the transaction (`needs_review` is separate — §12 D9).
- **Loan-linked rows — the consequence is stated before the write.** An override replaces the
  decomposition: the whole amount is reported as the override role (the `getSemanticEffects`
  contract), so Spending, Debt payments, Known principal, Cash flow and the Savings rate all move
  (fixture #6 in §9.1 shows the exact effect). The loan balance, `principal_portion`,
  `loan_balance_applied` and the Loans-tab payment history do **not** change (I2). Because this is
  easy to misread as "un-linking", the UI shows a confirmation first — "This payment is linked to
  SoFi and is reported as $350 principal + $50 interest. Reporting it as *Spending* will count the
  whole $400 as spending. The loan and its payment history won't change." — and the API enforces it:
  a non-null override on a loan-linked row must carry
  `acknowledge_loan_decomposition: { manual_loan_id, amount, principal_portion }` — **the amounts the
  user was shown** — otherwise 409 `loan_decomposition_ack_required`. The RPC compares those three
  values with the locked row; if a concurrent edit changed the principal, the amount (a resync) or the
  link, it raises and the API answers 409 `loan_decomposition_changed` with the current values, so the
  user never acknowledges numbers that are no longer true (Trevor's item 4).
  **Explicit `debt_payment` on a linked row is a real change.** Without an override the row's
  effective role is already `debt_payment` (auto), but reporting is the $350/$50 split; an explicit
  `debt_payment` override reports the whole $400 as debt. So "no change" is judged on the **stored**
  `user_role_override`, never on `effective_role`: request role = stored override → 200 no-op;
  anything else (including auto `debt_payment` → explicit `debt_payment`) is written, with the
  acknowledgement. The picker shows both states distinctly ("Automatic: $350 principal + $50
  interest" vs "Debt payment: whole $400") and offers "Reset to automatic".
- **Transfers, single row:** overriding a row to `internal_transfer` is allowed on its own — the user
  may be describing a transfer to an unlinked account. The UI additionally proposes the best
  counterpart (opposite amount, another account, ±3 days, the same rule as reconciliation).
- **Transfers, two rows — atomic or not at all.** "Also mark the other side" is **one** request
  (`counterpart_id` in the body) served by the same RPC as the single-row form
  (`set_transaction_role_override` with two ids, §6.2), which writes both overrides under the
  per-user lock, with a compare-and-swap on each row's stored override and auto role, and rolls back
  entirely on any failure: not owned, either CAS mismatch, the two rows not
  opposite-signed/equal-amount/different-account, or either row already overridden by the user.
  Failure → 409 `counterpart_changed` with both rows' current state; the UI re-renders both and
  offers "Mark just this one" (a single-row override) or cancel. There is no path that leaves one leg
  overridden because of a partial failure; only an explicit single-row action does that.
- **Dependent rows are found and reset in the same transaction — a 200 never leaves totals
  inaccurate** (Trevor's item 4; completeness per Codex's item 5). Two kinds of existing relational
  classification depend on the row being overridden: its transfer **partner** (`account_pair_match`,
  when the row is overridden away from `internal_transfer` — it is no longer an eligible participant,
  `isEligibleTransferParticipant`, so the partner's pairing is invalid), and **refunds** matched to it
  (`refund_match` rows whose only eligible original is this row, when it is overridden away from
  `expense`). Revision 3 had the application assemble that list before calling the RPC and the RPC
  verify it; that proves the listed rows are still valid, not that the list is **complete** — a
  candidate inserted by a sync between the read and the lock would be missed. So in revision 4 the RPC
  **discovers** the dependents itself, in SQL, after taking the per-user advisory lock and locking the
  primary row (the same place `confirm_transfer_pair` already performs candidate discovery and
  ranking in SQL):
  - *Transfer partner* (only when the primary row's `role_source = 'account_pair_match'` and the new
    override is not `internal_transfer`): every owned row P with `role_source = 'account_pair_match'`,
    `amount = −primary.amount`, `account_id ≠ primary.account_id`, `|date − primary.date| ≤ 3`, and
    `user_role_override is null or = 'internal_transfer'`, for which the primary row is P's **own
    best reciprocal match** (closest date; a tie counts as dependent, because P's pairing is then
    ambiguous and must not stand). This is the reciprocal rule Phase A pairs with, evaluated on
    current, locked data, so any P whose pairing could rest on the primary row is enumerated.
  - *Refunds* (whenever the primary row's effective role changes **to or from** `expense`, or its
    manual-loan link state is part of the change — anything that alters its eligibility as an
    original). Phase A's rules, exactly as `findRefundOriginalCandidates` and `rankRefundCandidates`
    implement them: an original O is eligible for a refund R iff **same `account_id`**, O ≠ R,
    `O.effective_role = 'expense'`, `O.manual_loan_id is null`, **`O.amount ≥ |R.amount|`** (partial
    refunds allowed, never an over-refund), `O.date ∈ [R.date − 120 days, R.date]`; ranking requires
    the same normalised identity (`lower(trim(coalesce(merchant_name, name)))`), prefers exact-amount
    candidates when any exist, then the closest date (id as tiebreak), and a tie at the best distance
    is **ambiguous** (unresolved → reset, as the repair sweep does). So the RPC enumerates every owned
    R with `role_source = 'refund_match'` on the **primary row's account**, `R.amount < 0`,
    `|R.amount| ≤ primary.amount`, the primary's identity, `R.date ∈ [primary.date, primary.date +
    120]` — every refund whose match could involve the primary row — and **re-runs that ranking in
    SQL under the lock against the post-override state** (the primary counted as eligible only if its
    new effective role is `expense` and it is not loan-linked). R is reset iff the ranking yields no
    winner or an ambiguous tie; a refund that still ranks to some eligible original (this row or
    another) is left alone. This covers leaving `expense` (the primary drops out of R's candidates)
    and entering it (the primary may join them and create a tie). A harness test drives the compiled
    `rankRefundCandidates` over the same rows and asserts the SQL ranking agrees.
  - Every discovered dependent is locked `for update` with its ownership chain, then reset through the
    same all-or-none role-field write `apply_transaction_semantic_roles` uses: a partner to its sign
    role with `role_source = 'transfer_like_unconfirmed'` (low), a refund to `income`/`sign_default`
    (low), `classifier_version` unchanged. These are exactly the fallbacks `classifyRowLevel` produces
    for such rows (a paired row can only have come from step E; a matched refund from step F), and a
    harness test drives the **compiled** classifier over every reset row and asserts equality, the
    way `supabase/tests/phase_a` already checks `delete_manual_loan_atomic`'s reclassification.
  - *Transfer partner discovery mirrors Phase A too:* `findTransferCounterpartCandidates`
    (`amount = −row.amount`, other account, ±3 days, `role_source` filter) and the reciprocal
    best-match rule of `computeReciprocalTransferResolution`, evaluated in SQL under the lock.
  - The override write and every reset commit together; any failure raises and nothing is written.
    The response lists `dependents_reset` ids. The general repair sweep still runs afterwards as an
    idempotent safety net; its failure is logged and retried by the next sync and is not a qualifier
    on the response, because the totals this override affects are consistent when the 200 is sent.
  - The **two-row** transfer form is the same RPC with two ids (array form, like
    `apply_transaction_semantic_roles`): it additionally verifies the pair relation and runs the
    refund discovery for **both** rows (marking two expense rows as a transfer can orphan a refund
    matched to either). Reconciliation never re-pairs an overridden row (Phase A).
- **Racing a posting:** if the row was a pending transaction that Plaid has since replaced, the
  endpoint answers 409 `transaction_superseded` with the posted row, per the continuity design (§8
  there); the UI re-targets.
- **Refunds/income:** override to `income` or `refund` follows §4.1 (a negative `expense` override
  reduces spending; a positive `income` override reduces income). No sign restriction is enforced —
  the user is correcting Plaid — but the UI warns when the sign is unusual for the chosen role.
- **Pending rows:** an override on a pending row survives posting — continuity (§1.3) is released and
  carries `user_role_override` and `user_role_override_at` to the posted row. (§12 D1.)
- **Audit:** add `user_role_override_at timestamptz` (nullable) so the UI can say "You changed this on
  Sep 26" and preflights can count corrections; set/cleared together with the override. Optional
  but cheap (§12 D9).

---

## 5. Calculation-by-calculation specification

| # | Surface | Phase B rule | Response / UI change |
|---|---|---|---|
| C1 | Monthly cash flow | `cash_flow = income − spending − debt_payments − credit_card_payments_untracked + transfers_external` per month (§4.1) | `monthly_spending[]` keeps `spent`/`income` **sign-based** (§6.4) and gains `spending`, `income_semantic`, `debt_payments`, `known_principal`, `transfers_internal`, `transfers_external`, `credit_card_payments_tracked`, `credit_card_payments_untracked`, `credit_card_payments_externally_funded`, `refunds`, `cash_flow`, `unclassified_count`; the card reads the new fields and its ⓘ lists each line |
| C2 | Cash flow & budget pace | income/spending bars from the role-aware `current_month` fields; budget total spent = Σ role-aware `spending` (signed) | bars "Debt payments", "Untracked card payments", "Transfers out" (each hidden when 0) |
| C3 | Monthly spending chart | role-aware `spending` | legend note "excludes transfers, card payments and debt payments" |
| C4 | Savings rate | `(cash_flow + known_principal) / income_semantic` | card copy: "Cash kept after debt service, plus $350 of loan principal paid down"; when applicable: "$300 of loan payments with an unknown principal share counted as outflow", "$75 transferred to accounts not tracked (not counted as saving)"; tier thresholds unchanged |
| C5 | Monthly Breakdown | `total_spent`, `total_income`, `by_category` stay **sign-based** (frozen, §6.4). New per-month `semantic: { spending, income, by_category, excluded: {transfers_internal, transfers_external, credit_card_payments_tracked, credit_card_payments_untracked, debt_payments} }` where `semantic.by_category` is built from `expense` (+) and `refund`/negative-expense effects grouped by Plaid category, with manual-loan interest under synthetic `LOAN_INTEREST` ("Loan interest") | the new UI renders `semantic`; per-month footer "Not counted as spending: …"; drill-down uses the **effects** endpoint (§7.3) with `plaid_category` |
| C6 | Budget `spending`, `recent_avg_spending` (new fields; `spent`/`recent_avg_spent` stay sign-based) | Σ over rows with effective role `expense`/`refund` (parent or its splits, §4.6), signed; loan-linked rows contribute interest to *unassigned* only | copy under the category list: "Spending excludes transfers, card payments and debt payments"; negative category totals rendered as refunds; drill-down uses the effects endpoint (§7.3) with `budget_category_id` |
| C7 | Safe to Spend | unchanged formula; inputs: role-aware remaining budget (from `spending`) and merged upcoming items (§4.8) | "Credit-card minimums" line becomes "Card payments (expected)"; loans likewise |
| C8 | Net worth / Liquid cash / chart | **no change** | tooltip "from account balances" |
| C9 | Recurring / Upcoming bills | merge rules (§4.8): one item per card/loan at the expected amount; internal transfers are not bills; everything else stays a bill | collapsed "counted once with its card or loan" group with reasons |
| C10 | Transactions feed | pagination (§7); role badge, role filter (a *row* filter, §7.3), review queue, role picker (§6) | `TransactionItem` gains role fields, `principal_portion`, `semantic_effects` |
| C11 | Loans tab | **no change** | — |

---

## 6. API and UX

### 6.1 API (all additive; API-level handling in §6.4)

- `GET /api/plaid/transactions` — new query params `cursor`, `account_id`, `budget_category_id`,
  `plaid_category`, `role` (comma list of effective roles; `unclassified` selects NULL),
  `needs_review`, `review` (`=roles` selects the §6.3 review queue), `q` (name/merchant substring).
  `limit` keeps today's meaning (default 50, max 200) and a call **without** `cursor` returns exactly
  what it returns today plus the new fields, so stale bundles keep working. Response adds
  `next_cursor: string | null`. Each item adds `auto_role`, `role_source`, `role_confidence`,
  `user_role_override`, `user_role_override_at`, `effective_role`, `manual_loan_id`,
  `principal_portion`, `semantic_effects: [{role, amount}]` (computed server-side so the UI never
  re-derives the loan split).
- `PATCH /api/plaid/transactions/:id/role` body
  `{ role: SemanticRole | null, expected_user_role_override: SemanticRole | null,
  expected_auto_role: SemanticRole | null,
  acknowledge_loan_decomposition?: { manual_loan_id, amount, principal_portion },
  counterpart_id?: string }` → 200 `{ transaction, counterpart?, dependents_reset: string[] }`.
  Errors: 400 `invalid_role`; 404 not found / not owned; 409 `role_stale` (CAS on the **stored**
  override and the auto role; body carries the current row); 409 `loan_decomposition_ack_required`
  and 409 `loan_decomposition_changed` (§4.9); 409
  `counterpart_changed` (the two-row form failed as a whole; body carries both current rows); 409
  `counterpart_ineligible` (not opposite-signed / unequal amount / same account / already
  overridden); 409 `transaction_superseded` / `transaction_pending_removed` (continuity design §8).
  A request whose `role` equals the **stored** `user_role_override` is a 200 no-op; an explicit role
  equal only to the *auto* role is a real write (§4.9). With `counterpart_id`, `role` must be
  `internal_transfer` and both ids go to the same RPC (`set_transaction_role_override`, array form);
  without it, one id. The application passes **no** dependent list — the RPC discovers dependents
  under the lock (§4.9). The idempotent repair sweep runs after the response is determined and cannot
  change it. Session-owned mutation like every other write (`lib/sessionOwnership.ts`).
- `GET /api/plaid/transactions/effects` — the drill-down endpoint (§7.3): effect rows, not
  transaction rows.
- `GET /api/plaid/summary`, `GET /monthly-breakdown`, `GET /api/budget-categories`,
  `GET /recurring-streams` — additive fields as in §5 and §4.8. **Existing fields are frozen with
  their current sign-based meaning** (`spent`, `income`, `current_month.spent/income`,
  `total_spent`, `total_income`, `by_category`, `BudgetCategory.spent`, `recent_avg_spent`); Phase B
  semantics live in new fields (`spending`, `income_semantic`, `cash_flow`, `semantic: {…}` on
  monthly-breakdown months, `BudgetCategory.spending`, `recent_avg_spending`). See §6.4 for why.
- `PUT /transactions/:id/splits` — already one atomic, locked RPC after continuity
  (`replace_transaction_splits`, continuity design §6); Phase B replaces that function to add the
  role-eligibility check: new 409 `splits_not_applicable` (§4.6); 409 `splits_unbalanced` as before.
- `PATCH …/category` and `PATCH …/approve` — unchanged in Phase B; they already go through
  continuity's locked RPCs (`set_transaction_budget_category`, `approve_transaction`).

### 6.2 Database

One additive migration, `2026xxxx_financial_semantics_phase_b.sql`:

- `user_role_override_at` already exists: the continuity migration creates it (continuity design §4,
  P6), so Phase B's migration adds **no** column to `transactions`.
- `create function public.set_transaction_role_override(p_user_id uuid, p_transaction_ids uuid[],
  p_role text, p_expected_user_role_overrides text[], p_expected_auto_roles text[],
  p_loan_acks jsonb) returns jsonb` — **one** return value,
  `{ "rows": [<the primary transaction rows, as `to_jsonb(t)`>], "dependents_reset": [<uuid>] }`
  (a `setof` plus an out-parameter is not a valid signature; `jsonb` is what
  `begin_plaid_item_removal`/`remove_plaid_item_local` already return). One function for the
  single-row form (one id) and the two-row transfer form (two ids, `p_role` must be
  `internal_transfer`). SECURITY INVOKER,
  `search_path = ''`, `pg_advisory_xact_lock(hashtext(p_user_id::text))` first (the same per-user
  lock every role/loan/sync writer takes); locks the primary rows **and their ownership chains**
  (`for update of t, a, pi`, as `apply_transaction_semantic_roles` does) in a fixed id order;
  verifies ownership and that the ids are distinct; compare-and-swaps each row on the **stored**
  `user_role_override` and on `auto_role` (both as the UI showed them); for two ids, verifies the pair
  relation (opposite sign, equal cents, different accounts, neither already overridden); for any
  loan-linked primary row with a non-null `p_role`, requires its entry in `p_loan_acks` and verifies
  `manual_loan_id`, `amount`, `principal_portion` against the locked row
  (`loan_decomposition_changed` otherwise); validates `p_role` against the six values (or NULL to
  clear); **discovers** the dependent transfer partners and refunds in SQL as specified in §4.9,
  locks them likewise, and resets each through the same all-or-none role-field write
  `apply_transaction_semantic_roles` uses; writes `user_role_override` and `user_role_override_at` on
  the primary rows; returns the `jsonb` above (the API maps `rows[0]` to `transaction`, `rows[1]` to
  `counterpart`, and relays `dependents_reset`). Any failure raises → nothing written. If a primary
  row is missing → `transaction_not_found`, which the controller turns into `transaction_superseded`
  / `transaction_pending_removed` per the continuity design §8. Revoke from `public, anon,
  authenticated`; grant execute to `service_role`. Postcondition block asserting all of that (pattern
  from `20260926120000`).
- `create or replace function public.replace_transaction_splits(…)` — continuity created it (locked,
  atomic, Σ = amount with the row's sign, empty array clears). Phase B **replaces** it to add the
  role-eligibility check: refuses a row whose effective role is not `expense`/`refund` or that is
  loan-linked without an override (`splits_not_applicable`). Same signature, so the controller and
  an old backend keep working (an old backend simply never hits the new refusal for rows it cannot
  see roles on — and if it does, it receives an error and writes nothing).
- Index: `create index transactions_effective_role_date_idx on public.transactions (account_id,
  effective_role, date desc)` — supports the role filter and the review queue. Optional at this
  scale; included because it is cheap and additive.
- Read-only preflight/postflight file `supabase/preflight/2026xxxx_phase_b_preflight.sql` (§8).
- **No** change to any existing constraint or column; one existing function (`replace_transaction_splits`)
  is replaced with a behaviour-superset body. Rollback = `drop function set_transaction_role_override`,
  `drop index`, and restore `replace_transaction_splits`'s continuity body (kept verbatim in the
  migration's rollback notes). **`user_role_override_at` belongs to the continuity migration and is
  never dropped by a Phase B rollback**: it holds the user's own data (when they made each
  correction) and is nullable and harmless to older code (§8.4).
- Continuity (D1 = "first"): its own migration and its own reviewed design,
  `PENDING_POSTED_CONTINUITY_DESIGN.md`; Phase B relies on its §3 contract.

### 6.3 UX

- **Feed row:** a role badge (text, never colour alone — same rule as connection status labels):
  *Spending*, *Income*, *Transfer*, *Card payment*, *Debt payment*, *Refund*; a small "✎" when the
  user overrode it; "Loan payment: $350 principal · $50 interest" for decomposed rows.
- **Role picker:** inline menu with the six roles, one-line meaning each ("Transfer — between your
  own accounts; not spending or income"), a "Reset to automatic" entry when overridden, and the
  counterpart proposal for transfers (§4.9). Saves through the CAS API; on 409 `role_stale` the row
  re-renders with the fresh role and a "This changed while you were looking" note. For a loan-linked
  row the picker opens the confirmation described in §4.9 before anything is sent; for the two-row
  transfer form, 409 `counterpart_changed` re-renders both rows and offers "Mark just this one".
- **Paused figures:** on `semantic_integrity_error`, the Overview/Budget/Income cards show a
  `role="alert"` banner naming the transaction ("SoFi payment on Sep 12 has a principal larger than
  its amount") with a link that opens it in the feed; no number is rendered for that period until
  the row is fixed or unlinked.
- **Review queue:** a filter chip "Review roles (N)" = rows where `role_confidence = 'low'` and
  `role_source in ('transfer_like_unconfirmed', 'category_primary_fallback')` **or** `effective_role
  is null`, excluding rows with an override. Served by `review=roles`. This is where unpaired
  Venmo/Zelle rows and unlinked loan payments land.
- **Explainers:** every headline figure gets an ⓘ listing what was excluded this period, from the
  response's excluded totals. Budget tab shows a one-time dismissible notice after release (§4.3).
- **Accessibility:** badges are text; the picker is a `<select>`-like listbox with keyboard support;
  save errors use `role="alert"`; the queue count is announced on change.

### 6.4 Compatibility

- **The problem revision 2 left open (Trevor's item 5).** If the existing fields changed meaning, a
  level-1 bundle would compute its "Monthly cash flow" as the new `income` − the new `spent` =
  3 002.10 − 525 = **2 477.10** for the fixture, while the correct cash flow is 1 827.10 — a wrong
  financial figure on screen for as long as the user ignores the update banner. A banner does not
  fix that, and raising `MIN_CLIENT_API_LEVEL` would refuse a client that is otherwise harmless.
- **Resolution: existing fields are frozen; Phase B semantics arrive in new fields.** `spent`,
  `income`, `current_month.spent/income`, `total_spent`, `total_income`, `by_category`,
  `BudgetCategory.spent`, `recent_avg_spent` keep their sign-based computation unchanged. A level-1
  bundle therefore shows **exactly what it shows today** — for the fixture, income 4 462.10, spending
  2 635.00, cash flow 1 827.10 — which is correct under its own definitions and, for cash flow,
  numerically the same figure Phase B publishes (sign-based net over included accounts *is* the
  tracked-set cash flow, apart from unpaired credit-side card legs — externally funded payments and
  externally reversed payments — which Phase B deliberately excludes as non-cash). The new UI reads `spending`, `income_semantic`, `cash_flow` and the
  breakdown lines. No client ever sees a hybrid.
- **Levels.** `X-Api-Level` and `CLIENT_API_LEVEL` go to **2** so the banner tells stale bundles a
  better version exists and so the new bundle can detect a backend that doesn't yet publish the new
  fields. `MIN_CLIENT_API_LEVEL` stays `0` (§12 D11): a level-1 bundle reads only frozen fields, and
  every write it can make (category, approve, splits, link/unlink, preferences) either has unchanged
  semantics or is refused server-side by the new RPC rules (an old bundle `PUT`ting splits on a
  transfer row gets 409 `splits_not_applicable`, shows its generic error, writes nothing). It cannot
  call the role endpoint. Nothing it does can leave a state the new bundle rejects, because the
  invariants live in the RPCs.
- **New bundle before new backend** (Vercel finishes before Railway): the new UI treats a response
  without the new fields as "backend updating" — cards show "—" with "Updating…" rather than falling
  back to the frozen fields, so no hybrid is displayed in that direction either. Tested (§9.4).
- **Retirement.** The frozen fields are marked deprecated in the API types and removed only when
  `MIN_CLIENT_API_LEVEL` is raised to 2 in a later release, per the contract's "retire legacy routes
  kept for stale bundles" rule.

---

## 7. Transaction pagination

- **Order:** `(date desc, id desc)` — deterministic, matches the Phase A backfill's keyset approach.
- **Cursor:** opaque base64url of `${date}|${id}` of the last row returned; `next_cursor = null` when
  the page was short. Server rejects a malformed cursor with 400 `invalid_cursor`.
- **Query:** `where (date, id) < (cursor_date, cursor_id)` expressed with supabase-js as
  `.or('date.lt.<d>,and(date.eq.<d>,id.lt.<id>)')`, plus every filter in §6.1, plus the ownership
  join (`accounts!inner(plaid_items!inner(user_id))`) as today. Page size default 50, max 200.
- **Frontend:** `TransactionsFeed` becomes a paged list: filters move server-side (account,
  category, date range, needs_review, role, review queue), "Load more" appends the next page, and
  the store is keyed by id so a role/category/split edit updates in place. `RecentActivity` keeps
  fetching the first 5. Both drill-downs call the server with `start`/`end` (+ `budget_category_id` or
  `plaid_category`) instead of filtering the in-memory array, which fixes the >200 under-reporting
  (C10).
- **Correctness under concurrent sync:** a new row that sorts before the cursor is simply seen on
  refresh; a row deleted between pages is skipped; no row is ever shown twice within one paging
  session because the cursor is strictly monotone.
### 7.3 Drill-downs: effect-aware and split-aware, reconciling to the total (I6)

Filtering *transactions* cannot reproduce a total: `effective_role = 'expense'` omits the interest
effect of a loan-linked payment (its effective role is `debt_payment`), and filtering by the parent's
`budget_category_id` omits money allocated through splits. So drill-downs never query transaction
rows. They query **effect rows** from `GET /api/plaid/transactions/effects`, produced by the *same*
pure module that produces the totals:

- Params: `start`, `end` (exclusive), exactly one of `budget_category_id` (`unassigned` for null) or
  `plaid_category` (`LOAN_INTEREST` allowed), `measure = spending | income | debt_payments |
  transfers | card_payments_untracked | …` (one per published total), `cursor`, `limit`.
- Each row: `{ transaction: {id, date, name, merchant_name, account, pending, effective_role,
  user_role_override, needs_review}, effect_role, effect_amount, allocation: 'row' | 'split' |
  'interest' | 'principal', split_id?, split_note?, budget_category_id, plaid_category }`.
- Rules (spending measure, Budget category K): unsplit rows with effective role `expense`/`refund`
  and `budget_category_id = K` → one `row` effect for the full amount; split parents with role
  `expense`/`refund` → one `split` effect per split whose `budget_category_id = K`; loan-linked rows
  without override → one `interest` effect under `unassigned` only. Monthly Breakdown (Plaid category
  P): `expense`/`refund` effects whose row `category = P`, plus `interest` effects under
  `LOAN_INTEREST`. Other measures analogously (`principal` effects for `debt_payments` etc.).
- **Reconciliation by construction:** `aggregateBudgetSpend` / `aggregateMonthlyBreakdown` return
  both the totals and the contributing effect rows; the endpoint returns the rows for one bucket
  **and** the bucket's complete `total_amount` and `total_count`, computed by the same module over
  the complete (internally paged, §7.4) row set. A test asserts Σ `effect_amount` over **all** pages
  = `total_amount` = the bucket total shown on the card, for every bucket in the fixture.
- **Loaded subtotal vs complete total.** The UI shows two numbers while pages remain: "Showing 50 of
  120 items · $1 240.00 of $2 980.50" — the first from the rows it has, the second from
  `total_amount`. It never presents a loaded subtotal as the total; when the last page arrives the
  two are equal and the line collapses to "120 items · $2 980.50". A mismatch at that point is a
  bug and is asserted against in tests.
- Paging: cursor on `(date desc, id desc)`; all effects of one transaction are returned together, so
  a page boundary never splits a transaction's effects.
- The **feed's** `role=` filter (§6.1) is a *row* filter for browsing ("show me my card payments")
  and is documented as such in the UI; a loan-linked row appears under `role=debt_payment` with its
  decomposition text, never under `expense`.

### 7.4 Every aggregate fetch pages internally (I7)

Supabase/PostgREST returns at most 1 000 rows per request by default (`max-rows`), and
`getTransactionsSince`, `getCategorizedTransactionsSince`, `getCategorySpendRows` (both queries) and
`getNetWorthHistory` use no `.range()`/keyset — a 12-month range with more than 1 000 transactions
**already** yields a complete-looking, silently truncated total. This is a latent defect in `main`
independent of Phase B. Trevor's read-only check (historical audit, Trevor's read-only check on 2026-09-26 — not re-verified since) found **221** transactions in the last 12 months, so
no live total is truncated today and no separate urgent fix is needed (§12 D15 = (b), decided).
Phase B fixes it as part of the aggregation rework:

- One helper, `fetchAllPages(query, keyset)`, drives every aggregate fetch: keyset `(date, id)` for
  transactions, `(transaction_id, id)` for splits, `(date)` for snapshots; page size 1 000; stops only
  on an **empty** page — never on a merely short one, because a server cap below the requested page
  size makes every page short and stopping there would silently truncate (§13 Q5); verifies the key
  strictly increases; a hard ceiling (e.g. 200 pages) that fails the request with
  `aggregate_too_large` rather than returning a partial total.
- The pairing context (§4.3 contract, ±`PAIRING_PAD_DAYS`) and the drill-down endpoint use the same helper.
- Unit tests drive a mocked client that returns 1 000-row pages and assert totals over 2 500 rows;
  the harness inserts 1 500 rows for one user and a preflight query confirms production counts.

---

## 8. Production data: reclassification, preflight, rollout, rollback

### 8.1 Preflight (read-only, `supabase/preflight/2026xxxx_phase_b_preflight.sql`)

1. Ledger head = `20260927120000` (continuity, applied); Phase B version not recorded; Phase B objects absent (function,
   column, index).
2. `count(*) where auto_role is null` — rows Phase A never classified. **At the 2026-09-26 historical
   audit: 219 of the 221 rows in the last 12 months** (re-measure at release time). Expected 0 **after** the backfill in §8.2; any other value
   means run/repeat the backfill first.
3. Distribution: `select effective_role, role_source, role_confidence, count(*), sum(amount)` — the
   sizes of what Phase B will exclude. Keep the output.
4. `transfer_like_unconfirmed` rows (count, sum) — the review queue's initial size.
5. Splits on rows whose effective role is not `expense`/`refund`, or that are loan-linked without an
   override — will stop counting toward budgets (§4.6). Expected small; list them.
6. Budget categories whose current-month and 3-month spend is ≥ 80 % `credit_card_payment` /
   `internal_transfer` / `debt_payment` — the ones that will fall to ~0 (§4.3).
7. Recurring outflow streams with `category in ('LOAN_PAYMENTS','TRANSFER_OUT')` and inflow streams
   with `TRANSFER_IN` — what leaves "Bills"/"Recurring income".
8. Users with card-payment outflows and no linked `credit` account (§4.3 unlinked-card note).
9. Manual-loan-linked rows with `user_role_override is not null` — today impossible (no writer);
   expected 0.
10. A **before/after snapshot** of the current and previous month's figures computed both ways
    (sign-based and role-based), as SQL, so the release report can show exactly how the headline
    numbers move for the real account. Never modifies anything.
11. Row counts per reporting-range preset (`this_month` … `last_12_months`) for transactions and
    splits, compared with 1 000 — whether today's totals are already truncated (§7.4).
12. Card-payment legs in the last 3 months and how they pair under §4.3 (tracked / untracked /
    externally funded / ambiguous), so the "untracked" line's initial size is known.
13. Recurring outflow streams and their §4.8 status (bill / internal / merged, with reason and the
    merged item's expected amount) — what changes in Upcoming bills and Safe to Spend.

### 8.2 Reclassification

- No classifier change ⇒ no reclassification of already-classified rows. What is needed is the
  **Phase A backfill for never-classified rows** — 219 of 221 at the 2026-09-26 historical audit, so this is not optional:
  `node dist/scripts/backfillTransactionSemantics.js` (dry run) → review the report → `--apply`. It
  is keyset-paginated, idempotent, interruptible and reuses live sync's classifier and reconciliation
  (§1.3), so this run is also the **first time** transfer pairing and refund matching are applied to
  history; the dry-run report shows every pair and match before anything is written. Add
  `"backfill:transaction-semantics"` to `backend/package.json` so it is runnable the same way the
  token backfill is. Run against production from the same controlled place the token backfill ran
  (Railway `ssh`, never locally with production secrets) — a Trevor-executed, approved step. **Release
  gate:** Phase B does not deploy until §8.1-2 reads 0.
- Rows classified by version 1 stay version 1. Phase B does **not** bump `CURRENT_CLASSIFIER_VERSION`
  (§12 D10). If a Phase C classifier v2 later ships, its own backfill uses `--target-version 2`.
- Pending→posted continuity (if D1 = first) needs no data backfill: it applies to posts after it ships.

### 8.3 Rollout order (each step its own approval, as for LIM)

1. Design approved (this document) → Codex review → implement on
   Phase B branches (continuity, D1, is already released; slice 1 is §14).
2. Backfill dry run on production (read-only) → review → `--apply` (write, approved).
3. Preflight 1–10 on production; keep the before/after snapshot.
4. `supabase db push --dry-run` (exactly one file) → `db push` → postflight (function privileges,
   column, index, RLS unchanged, Phase A constraints untouched).
5. Merge → Railway/Vercel deploy → verify `X-Api-Level: 2`, app-build, the update banner on a stale
   tab, then compare the live Overview/Budget/Income figures with the §8.1-10 snapshot.
6. Smoke tests, non-destructive: override a row to transfer and back (Sandbox item or a real row —
   overrides are reporting-only and reversible), page the feed to the end, open both drill-downs for
   a month with > 200 rows.
7. Advance `PRODUCTION_HEAD`; record the numbers in the README release note.

### 8.4 Rollback

- **Application:** redeploy the previous backend/frontend. Aggregates revert to sign-based; the
  override column is simply ignored (no data loss); the pagination params are ignored; stale-bundle
  handling is unaffected because `MIN_CLIENT_API_LEVEL` stayed 0.
- **Schema:** the three functions and the index can be dropped (§6.2). `user_role_override` values
  written through the new RPC remain valid Phase A data and are harmless to Phase A code.
  **`user_role_override_at` is not dropped on rollback** — it is the user's own history; a later
  re-release finds it in place, and the rolled-back backend simply never reads it.
- **Data:** the backfill is **not** rolled back. It writes exactly what live sync writes for a new
  row, is valid Phase A data, and Phase A code reads it without change; resetting those rows to NULL
  would only recreate the unclassified state. Overrides are the user's; they are not rolled back.

---

## 9. Tests, with the canonical fixture

### 9.1 Fixture "September 2026" (used verbatim in backend unit tests, the DB harness and frontend tests)

Accounts: **C** checking, **S** savings, **X** credit card (`type = credit`), **E** checking with
`exclude_from_cash_flow = true`. Manual loan **M** (SoFi, balance 10 000). Plaid liability: auto loan
with `minimum_payment_amount` 300; card X `minimum_payment_amount` 35. Budget categories: Groceries
400, Dining 150, Shopping 100, Household 100. Plaid signs (`+` out).

| # | Date | Acct | Amount | Plaid category (detailed, conf) | Role after Phase A | Effects |
|---|---|---|---|---|---|---|
| 1 | 09-01 | C | −3 000.00 | INCOME_WAGES | income / sign_default | income 3 000 |
| 2 | 09-02 | X | +120.00 | FOOD_AND_DRINK_GROCERIES | expense | expense 120 (Groceries) |
| 3 | 09-03 | X | +80.00 | FOOD_AND_DRINK_RESTAURANT | expense | expense 80 (Dining) |
| 4a | 09-05 | C | +500.00 | TRANSFER_OUT_SAVINGS (LOW) | internal_transfer / account_pair_match (pairs with 4b) | transfer 500 |
| 4b | 09-05 | S | −500.00 | TRANSFER_IN_SAVINGS (LOW) | internal_transfer / account_pair_match | transfer −500 |
| 5a | 09-10 | C | +900.00 | LOAN_PAYMENTS_CREDIT_CARD_PAYMENT (HIGH) | credit_card_payment / category_detailed | ccp 900 |
| 5b | 09-10 | X | −900.00 | LOAN_PAYMENTS_CREDIT_CARD_PAYMENT (HIGH) | credit_card_payment | ccp −900 |
| 6 | 09-12 | C | +400.00 | LOAN_PAYMENTS_OTHER; linked to M, principal 350 | debt_payment / manual_loan_link | debt 350 + expense 50 |
| 7 | 09-15 | C | +300.00 | LOAN_PAYMENTS_CAR_PAYMENT (MEDIUM) | debt_payment / category_primary_fallback (low) | debt 300 |
| 8a | 09-18 | X | +60.00 | GENERAL_MERCHANDISE_ONLINE (Amazon) | expense | expense 60 (Shopping) |
| 8b | 09-25 | X | −60.00 | GENERAL_MERCHANDISE_ONLINE (Amazon) | refund / refund_match | refund −60 (Shopping) |
| 9 | 09-20 | C | +75.00 | TRANSFER_OUT_OTHER (Venmo, LOW) | expense / transfer_like_unconfirmed | expense 75 (unassigned) |
| 10 | 09-22 | X | +200.00 | FOOD_AND_DRINK_GROCERIES (Costco); splits 150 Groceries / 50 Household | expense | expense 200 via splits |
| 11 | 09-28 | S | −2.10 | INCOME_INTEREST_EARNED | income | income 2.10 |
| 12 | 09-29 | E | +999.00 | anything | expense | **ignored** (exclude_from_cash_flow) |
| 13 | 08-30 | C | +45.00 | FOOD_AND_DRINK_RESTAURANT, `auto_role` NULL | unclassified | R0: expense 45 + unclassified 1 (August) |

**Expected, September, before any override**

| Figure | Sign-based (today) | Phase B |
|---|---|---|
| Income | 3 000 + 500 + 900 + 60 + 2.10 = **4 462.10** | 3 000 + 2.10 = **3 002.10** |
| Spending | 120+80+500+900+400+300+60+75+200 = **2 635.00** | 120+80+50+60−60+75+200 = **525.00** |
| Debt payments | — | 350 (known principal) + 300 (unknown split) = **650.00** |
| Known principal | — | **350.00** |
| Transfers (info) | — | 500 |
| Card payments, tracked (info) | — | 900 (5a pairs with 5b: same cents, opposite sign, X is `credit`, same day) |
| Card payments, untracked | — | 0 |
| Refunds (info) | — | −60 |
| Cash flow | 4 462.10 − 2 635 = **1 827.10** | 3 002.10 − 525 − 650 − 0 = **1 827.10** (cash retained after debt service) |
| Savings rate | 1 827.10 / 4 462.10 = 40.9 % | (1 827.10 + 350) / 3 002.10 = **72.5 %** |

The cash-flow total is identical because every excluded pair is fully linked and nets out; the gross
figures and the rate are what Phase B fixes. The Savings rate card reads "Cash kept after debt
service $1 827.10, plus $350 of SoFi principal paid down. $300 of loan payments with an unknown
principal share counted as outflow." Budget: Groceries 270 (120 + 150 split), Dining 80,
Shopping **0** (60 − 60; the effects drill-down shows both rows and "2 items · $0.00"), Household
50, unassigned 125 (interest 50 as an `interest` effect + Venmo 75 as a `row` effect). Monthly
Breakdown: FOOD_AND_DRINK 400, GENERAL_MERCHANDISE 0 (rendered "−$60 refunded against $60"),
TRANSFER_OUT 75, LOAN_INTEREST 50; footer: transfers 500, card payments (tracked) 900, debt payments
650. Remaining budget = 130 + 70 + 100 + 50 = 350. Net worth: unchanged by 4a/4b/5a/5b by
construction (balances). Upcoming items are worked through under "Upcoming items (Safe to Spend)"
below: one merged card item at the expected $900, one merged auto-loan item at $300, and the savings
transfer stream is internal (not a bill).

**After the user overrides #9 to `internal_transfer`** (single row; Venmo has no partner leg): the
row becomes an **external transfer** −75. Spending 450, transfers_external −75, Cash flow
3 002.10 − 450 − 650 − 0 − 75 = **1 827.10 (unchanged)**, Savings rate **72.5 % (unchanged)**,
unassigned 50, TRANSFER_OUT 0 in the breakdown, review queue −1. The override moved $75 out of
Spending without making it disappear: cash still left. Clearing the override restores the previous
numbers exactly.

**Savings account excluded from cash flow** (variant: S has `exclude_from_cash_flow = true`): 4b and
#11 are not loaded; 4a's partner is outside the tracked set → 4a is an external transfer −500.
Income 3 000, Spending 525, Cash flow 3 000 − 525 − 650 − 500 = **1 325.00**, Savings rate
(1 325 + 350) / 3 000 = 55.8 %; the card says "$500 transferred to Savings, which you excluded from
cash flow". The **legacy** (sign-based, frozen-field) figure for the same variant, over the included
accounts C and X: income 3 000 + 900 (5b) + 60 (8b) = 3 960; spent 2 635; cash flow **1 325** — the
same number, as §6.4 predicts (sign-based net over included accounts *is* the tracked-set cash flow);
what changes is the gross Income/Spending and the rate.

**Card excluded from cash flow** (variant: X has `exclude_from_cash_flow = true`): X's rows are not
loaded; 5a has no partner in the tracked set → **untracked card outflow 900** ("to Chase Sapphire,
which you excluded from cash flow"); Spending 125 (interest 50 + Venmo 75), Cash flow
3 002.10 − 125 − 650 − 900 = **1 327.10**. Legacy over C and S: income 3 000 + 500 + 2.10 = 3 502.10,
spent 500 + 900 + 400 + 300 + 75 = 2 175, cash flow **1 327.10** — again equal. The $900 that left
checking is visible (Trevor's item 2). (For the externally-funded variant the legacy figure is
1 462.10 − 460 = 1 002.10 versus Phase B's 102.10: the $900 difference is exactly the externally
funded card inflow Phase B deliberately keeps out of a *cash* view.)

**Positive refund override** (variant: a +60 row on X dated 09-27 "Amazon" — a re-debit after 8b —
overridden to `refund`): Spending +60 in Shopping (Shopping = 60), refunds line shows −60 and +60,
Cash flow −60 vs the base fixture.

**After the user overrides #6 to `expense`** (after acknowledging `{ manual_loan_id: M, amount: 400,
principal_portion: 350 }`): Spending 875 (the whole 400 as spend), Debt payments 300, Known principal
**0**, Cash flow 1 827.10 (unchanged — it moved lines), Savings rate **60.9 %** (the principal is no
longer added back: this is the consequence the confirmation warns about). `manual_loans.current_balance`,
`principal_portion`, `loan_balance_applied` and the Loans-tab payment history are unchanged (I2).
Without the acknowledgement the request is refused with 409 and nothing changes; with an
acknowledgement of `principal_portion: 300` (stale — someone edited it to 350 meanwhile) it is refused
with `loan_decomposition_changed` and the current values.

**Explicit `debt_payment` on #6** (its effective role is already `debt_payment`): this is **not** a
no-op — the stored override is null. After the write: Debt payments 700 (whole 400 + 300), Known
principal 0, Spending 475 (the $50 interest is no longer a separate effect), Cash flow 1 827.10,
Savings rate 60.9 %. Requesting `debt_payment` again afterwards *is* the no-op.

**Override with dependents (discovered under the lock):** overriding 4a (C +500,
`account_pair_match`) to `expense`: the RPC finds 4b (S −500, other account, same day, its own best
reciprocal match is 4a) and resets it to `income` / `transfer_like_unconfirmed` in the same commit:
Spending 1 025, Income 3 502.10. **Completeness case:** a third row 4c (S −500 on 09-06,
`account_pair_match` to some 4d) is inserted by a concurrent sync *after* the client read 4a's
neighbourhood and *before* the RPC took the lock — the RPC still evaluates 4c under the lock; 4c's
own best reciprocal match is 4d (09-06, closer than 4a), so 4c is correctly **not** reset, and a
variant where 4d does not exist makes 4a the best match and 4c **is** reset. Nothing depends on what
the client saw. **Refunds, Phase A rules:** overriding 8a (Amazon +60 on X, 09-18) to
`internal_transfer` re-ranks 8b (Amazon −60 on X, 09-25, `refund_match`) without 8a: no eligible
original remains → 8b is reset to `income`/`sign_default` in the same RPC. **Partial refund:** add
8e, Amazon −20 on X, 09-26, matched to 8a (medium confidence, `60 ≥ 20`); overriding 8a resets 8e
too. **Alternative original:** with 8c (Amazon +60 on X, 09-20) present, overriding 8a leaves 8b
(exact match to 8c) and 8e (`60 ≥ 20`) as refunds. With 8c at +25 instead: 8b is reset (no candidate
covers 60) while 8e keeps 8c (`25 ≥ 20`); with 8c at +15, both are reset (15 covers neither). **Same
account only:** an Amazon −60 on account C is never a dependent of 8a (Phase A matches within one
account). **Entering `expense`:** a row 8f (Amazon +60 on X, **09-18** — the same day as 8a, so 7
days before 8b like 8a; a 09-11 row would be 14 days away and would simply lose to 8a) currently
`internal_transfer` by override has its override cleared → 8f becomes an eligible original tied with
8a at the best distance → `rankRefundCandidates` says ambiguous → 8b is reset; the response lists 8b
in `dependents_reset`. (A variant with 8f on 09-19, 6 days away, makes 8f the sole winner: 8b keeps
`refund` and nothing is reset.)
**Two-row form:** marking 8a and a −60 row on another account as a transfer pair runs the refund
re-ranking for both and resets 8b/8e when 8c is absent.

**Unlinked card variant:** delete account X from the fixture (rows 2, 3, 5b, 8a, 8b, 10 disappear).
Spending = 50 + 75 = 125; 5a has no card leg → **untracked card outflow 900**; Cash flow =
3 002.10 − 125 − 650 − 900 = **1 327.10**; Savings rate = (1 327.10 + 350) / 3 002.10 = **55.9 %**. The
UI shows "Card payments to a card that isn't linked: $900 — link the card to see that spending". The
"Chase card payment" stream is now a **bill** (nothing covers it). Cash did not vanish.

**Externally funded variant:** delete account C instead (rows 1, 4a, 5a, 6, 7, 9 disappear). 5b has
no payer leg → **externally funded inflow 900**, excluded from Income and Cash flow. 4b has lost its
counterpart too, so it is no longer `account_pair_match`: it falls back to `income` /
`transfer_like_unconfirmed` (500) and lands in the review queue (§4.2) — Income = 500 + 2.10 =
502.10, Spending 400 (120 + 80 + 60 − 60 + 200), Debt payments 0, Cash flow 102.10. Marking 4b as a
transfer gives Income 2.10 and Cash flow **102.10** — 4b becomes an external transfer +500 under the
tracked-set principle (§4.1/§4.2), so cash flow does not change (corrected from a stale "−397.90"; §13 Q1).

**Pairing edge cases:** two identical 900 payments on 09-10 and 09-11 with two card legs → each pairs
to its nearest (reciprocal), both tracked; one payer leg with two candidate card legs of equal
distance → ambiguous → untracked; a payer leg on 09-29 whose card leg posts on 10-02 → tracked in
September only because the fetch pads the range by 5 days (a test removes the pad and shows it
would wrongly become untracked); a card leg on an `exclude_from_cash_flow` account is **not** a
candidate, so the payer leg is an untracked outflow (the excluded-card variant above).

**Upcoming items (Safe to Spend), base fixture:** the "Chase card payment 900 / month" stream
(MATURE) pairs to X, which has a liability with minimum 35 → **one** item "Chase Sapphire payment —
expected $900 (minimum $35)", reserving 900, not 35 and not 935; the "Honda Financial 300 / month"
stream matches the auto-loan liability (`last_payment_amount` 300) → one item at 300; the "Transfer
to Savings 500 / month" stream's latest occurrence is 4a, internal → not a bill. Variant with X's
liability row missing (Liabilities product not enabled for that card): the stream stays a bill at
900. Variant where the stream is `EARLY_DETECTION`: the merged item reserves the minimum 35 and says
"expected amount not yet reliable".

**Integrity (R9):** set #6's `principal_portion` to 450 (> amount) directly in the fixture → the
summary request fails with `semantic_integrity_error` and `transaction_id` = #6; no partial totals are
returned; #13's NULL role in the same fixture is still handled by R0 in a fixture without the bad row.

### 9.2 Backend unit tests (vitest)

- `semanticAggregation.test.ts`: the fixture → every figure above, before/after each override, the
  unlinked-card and externally-funded variants, every pairing edge case, R0 with row 13 (counted
  **and** reported), R9 (the bad-principal row makes the aggregate throw `SemanticIntegrityError`
  naming the row; nothing is clamped), a negative `expense` override, a positive `income` override,
  a refund with no budget category, a manual-loan row with override (single effect) vs without (two
  effects), splits on a transfer parent (ignored), splits on a loan-linked parent (ignored, interest
  unassigned), month boundary (8b refund in September even though 8a is in September too; a variant
  with 8a in August leaves August untouched), and **reconciliation**: for every Budget category and
  every Plaid category in every month, Σ effect rows returned for that bucket = the bucket total.
- `fetchAllPages.test.ts`: a mocked client returning 1 000-row pages; 2 500 transactions and 1 200
  splits are all counted; only an empty page ends the loop (a server cap below the page size still
  returns everything); the page ceiling fails with
  `aggregate_too_large` rather than returning a partial total.
- `recurringStreams` merge rules: each §4.8 outcome (internal within the tracked set; external
  transfer stays a bill; merged with a card liability at the expected amount — MATURE — or at the
  minimum — EARLY_DETECTION; merged with a manual loan; merged with a Plaid liability; kept — the
  no-liability variant and the no-matching-occurrence case), and the Safe to Spend invariant that
  each card/loan is reserved **exactly once** (no item pair shares a `merged_with`).
- Legacy-field freeze: `/summary`, `/monthly-breakdown` and `/budget-categories` return the frozen
  fields byte-identical to `main`'s values for the fixture (income 4 462.10, spent 2 635.00, category
  `spent` values) alongside the new fields — the §9.5 control doubles as this test.
- `plaidController.test.ts`: `/summary` and `/monthly-breakdown` response shapes (additive fields
  present, old fields present), `role` filter and `review=roles`, cursor paging (3 pages of 2 over
  the fixture in `(date desc, id desc)`, `next_cursor` null at the end, malformed cursor → 400),
  `/transactions/effects` for each measure and bucket (rows sum to the total; a page boundary never
  splits one transaction's effects; `total_amount`/`total_count` present on every page and equal to
  the card total), `PATCH /role`: 400 on a bad role, 404 for another user's row, 409 `role_stale` on
  a CAS mismatch of the stored override or the auto role (body carries the current row), 409
  `loan_decomposition_ack_required` for a loan-linked row without the acknowledgement, 409
  `loan_decomposition_changed` when the acknowledged amounts differ from the row, 200 with a
  matching acknowledgement, explicit `debt_payment` on an auto-`debt_payment` linked row is a
  **write** (asserted on the RPC mock) while repeating the stored override is a no-op, the RPC is
  called with **no** dependent list and its `dependents_reset` ids are relayed, the two-row form: 200
  writes both, 409 `counterpart_changed` writes **neither**, 409 `counterpart_ineligible` for
  same-account / unequal / already-overridden, 409 `transaction_superseded` re-targeting (lookup
  passes the signed-in user id), the repair sweep's failure does not change a 200 already determined,
  `semantic_integrity_error` surfaced as 500 with only the owned `transaction_id`, session-ownership
  refusal.
- `budgetCategoryController.test.ts`: `spent`/`recent_avg_spent` byte-identical to `main` (frozen);
  `spending`/`recent_avg_spending` from role-aware rows; a negative category total preserved (not
  clamped) in `spending`.
- Recurring streams: `LOAN_PAYMENTS`/`TRANSFER_OUT` outflow streams excluded from bills and included
  in the "not counted" group; `TRANSFER_IN` excluded from recurring income.
- `syncService.test.ts`: an override survives a `modified` update of the same row (the Phase A write
  path already never touches it — make it an explicit test).

### 9.3 Real-PostgreSQL harness (`supabase/tests/access_control`, full history)

- `a06_set_transaction_role_override`: not executable by `anon`/`authenticated`; another user's id →
  raises and changes nothing; CAS mismatch on the stored override or on `auto_role` → raises; a
  loan-linked row without `p_loan_ack`, or with a stale `principal_portion` in it → raises; set then
  clear round-trips `user_role_override` and `_at`; `effective_role` follows; a loan-linked row's
  `manual_loans.current_balance`, `principal_portion` and `loan_balance_applied` are byte-identical
  before/after (I2); invalid role → check-constraint violation; **dependents, discovered in SQL**: a
  paired partner is reset in the same statement (both rows' `role_source` observed after one commit);
  a partner whose own best reciprocal match is a *different* row is not reset; a tie is reset;
  refunds: exact, partial (`original ≥ refund`), alternative original present/absent, an alternative
  too small for the refund, a cross-account refund never considered, and entering `expense` creating
  a tie — each per §9.1; the two-row form re-ranks refunds for both rows; the SQL ranking's
  winner/ambiguous/none outcome equals the compiled `rankRefundCandidates` for every case; every
  reset row's new fields equal the compiled classifier's `classifyRowLevel` output for that row
  (driven the way `phase_a` drives the classifier); the `jsonb` result has `rows` and
  `dependents_reset` and nothing else.
- `c12_override_vs_concurrent_candidate`: holder inserts a new `account_pair_match` candidate (the
  4c row of §9.1) via the sync RPC while the contender's override of 4a waits on the lock; after both
  commit, the contender's discovery has evaluated 4c under the lock (reset or not per its own best
  match) — the completeness proof, and the reason no pre-lock list exists.
- `a07_set_transaction_role_override_pair` (the two-id form): both rows written or neither — a CAS
  mismatch on the *second* row leaves the first untouched (checked after the RAISE); same-account /
  unequal-amount / same-sign / already-overridden each raise; not executable by client roles; another
  user's row raises.
- `c10_override_vs_sync`: holder runs `apply_synced_transaction_batch_v2` (the sync RPC since continuity) modifying the row; contender
  sets an override — serialised by the per-user advisory lock; the final row has both the new Plaid
  fields and the override.
- `c11_override_vs_link`: override to `expense` racing `link_transaction_to_manual_loan` on the same
  (unlinked, `expense`/`sign_default`) row, serialised by the per-user lock. **Override first:** the
  override commits; the link then commits (the link RPC never touches `user_role_override`); balance
  delta applied exactly once; effect count = 1 (the override suppresses the decomposition); the
  Loans tab still lists the payment. **Link first:** the link commits and sets
  `auto_role = 'debt_payment'`/`manual_loan_link`; the override request — issued against the
  pre-link state (`expected_auto_role = 'expense'`, no loan acknowledgement) — is **refused**:
  `role_stale` on the CAS (and it would also fail `loan_decomposition_ack_required`), nothing
  written, the row stays linked with its decomposition, balance applied exactly once. The client
  re-renders and, if the user still wants the override, sends it with the acknowledgement.
- `a08_replace_transaction_splits` (Phase B's replaced body): everything continuity's test already
  proves (atomic, ownership, balance, clear) plus: a transfer-role row raises `splits_not_applicable`;
  a loan-linked row without an override raises; the same row with an `expense` override accepts; a
  refund row accepts negative splits summing to its negative amount.
- `a09_aggregate_row_counts`: 1 500 transactions for one user across 13 months; the harness calls
  the compiled aggregation over the real database (as `phase_a` drives the compiled classifier) and
  asserts the total equals the SQL `sum(amount)` — proving the internal paging, not just the mock.
- A regression asserting the Phase A constraints and functions are untouched (object/privilege
  fingerprint before and after the Phase B migration).

### 9.4 Frontend tests (vitest + testing-library)

- Feed: role badge text for each role; overridden marker; decomposition text for a loan-linked row;
  Split action hidden for transfer/card/debt/loan-linked rows; role picker save → row updates in
  place; CAS 409 → fresh role + note (`role="alert"` for failures); counterpart proposal appears for
  a transfer override when a ±3-day opposite-amount row exists, not otherwise; the loan-linked
  confirmation dialog states the amounts and what will not change, Cancel writes nothing, Confirm
  sends `acknowledge_loan_decomposition: { manual_loan_id, amount, principal_portion }` with the
  values it displayed, and `loan_decomposition_changed` re-opens the dialog with the current values;
  the two-row correction on `counterpart_changed`
  re-renders both rows and offers "Mark just this one" / Cancel, never leaving a half-applied state
  in the UI; the `semantic_integrity_error` banner names the transaction and links to it.
- Paging: "Load more" appends, no duplicates across pages, filters reset the cursor, review-queue
  count updates after an override.
- Overview/Budget/Income copy and explainers: the excluded totals render from the response; Cash
  Flow Pace shows the Debt payments bar only when > 0; Shopping renders `−$60.00 (refund)` when
  negative; Safe to Spend uses the new remaining budget (fixture: 350).
- Drill-downs call `/transactions/effects` with `start`/`end`, the bucket param and `measure` (mock
  asserts the params); while pages remain the footer reads "Showing 50 of 120 items · $X of
  $total_amount" and never presents the loaded subtotal as the total; after the last page "N items ·
  $total" equals the card's total for every fixture bucket (Shopping: 2 items · $0.00; unassigned:
  the `interest` effect is listed as "SoFi payment — interest $50.00" and the Venmo row as "$75.00");
  no client-side sign filtering remains (a fixture row with a negative amount and `role = expense`
  must be listed).
- New-bundle-before-backend: a `/summary` response without `cash_flow` renders "—" and "Updating…",
  never the frozen `income − spent` (§6.4).
- Accessibility: badge is text; picker is keyboard-operable; alerts announced.

### 9.5 Regression the design must prove against `main`

Run the §9.2 fixture through today's `getSpendingSummary`/`aggregateByMonth`/`aggregateSpendByCategory`
and assert the sign-based numbers in the table (income 4 462.10, spending 2 635.00, savings 40.9 %) —
this is the "fails before, passes after" control for the Phase B PR, mirroring how `a05` was proved
against bc87477.

---

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Headline numbers change on release and look like a bug | §8.1-10 snapshot; explainers with excluded totals; one-time Budget notice; release note with the before/after table |
| Today's range totals are already truncated at 1 000 rows | §7.4 internal paging; §8.1-11 measures the live exposure; D15 offers to ship the fix first |
| Card payment to an unlinked card hides real spending | it is never dropped from cash flow: untracked outflow line (§4.3); override to `expense`; Phase C persisted pairing |
| Card-payment pairing misses (fee-adjusted amount, >5-day lag) | temporary double count is visible in the untracked line and self-corrects; pad + reciprocal rule tested (§9.1) |
| A `LOAN_PAYMENTS` stream is dropped from bills although nothing else shows the payment; or a $900 card payment is reserved as $35 | merge, never drop (§4.8): one item per card/loan at the expected amount; uncovered streams stay bills; every merge carries its reason |
| A payment to an excluded card or a transfer to an excluded/unlinked account vanishes from cash flow | tracked-set principle (§4.1): partners must be included accounts; such legs count as untracked card outflows / external transfers |
| Overriding a linked loan payment misread as unlinking / silently changes the savings rate / acknowledged against stale amounts | acknowledgement carries the shown amounts and is verified under the lock; explicit `debt_payment` is recognised as a change |
| A 200 while a transfer partner or matched refund still counts the old way | dependents are **discovered and** reset in the same RPC under the lock; the sweep is only a safety net |
| A dependent inserted between the client's read and the write is missed | there is no client-side list: discovery runs in SQL after the lock (c12) |
| An ambiguous stream match merges or drops the wrong payment | ambiguity (several occurrences, several liabilities) always keeps the stream as a bill |
| A stale bundle shows a hybrid figure (2 477.10) | frozen legacy fields; the old UI shows exactly today's numbers |
| Two-row transfer correction half-applied | one atomic RPC; on failure neither row changes and the UI offers the single-row action explicitly |
| Split replacement leaves a transaction with no splits on a failed insert | `replace_transaction_splits` RPC is one transaction |
| A row with inconsistent loan data is averaged into a plausible total | R9: the request fails and names the row; the UI pauses the figures instead of showing them |
| Venmo/Zelle mislabelled as transfers by users, hiding spending | overrides are visible (badge + ✎) and reversible; review queue shows what was auto vs user |
| Refund matched to the wrong original (same amount, same merchant) | reduces the right category anyway in most cases; override to `income` when wrong; D6 for a persisted link |
| Override lost on pending→posted | D1 sequence continuity first |
| Backfill never ran; NULL roles silently sign-counted | R0 counts *and reports*; preflight 2 is a release gate |
| Splits on excluded rows confuse users | never deleted, listed, explained, blocked for new ones |
| A stale bundle keeps showing sign-based numbers after release | API level 2 → update banner; those numbers are today's, not wrong; MIN stays 0 |
| Concurrency between override, sync and loan link | per-user advisory lock + CAS in the RPC; harness c10/c11 |

---

## 11. Work breakdown (for estimation, not commitment)

0. (Optional, D15) Aggregate fetch paging fix on its own small PR ahead of everything else.
1. ~~Continuity (D1 = first)~~ — **done**: released in PR #6 / closed out in PR #7
   (`PENDING_POSTED_CONTINUITY_RELEASE.md`).
2. Backend: `fetchAllPages`; `semanticAggregation.ts` (totals + effect rows + card-payment and
   transfer partner detection) with tests; fetch functions select role columns and pad; controllers
   (frozen fields + new fields); stream merging; `PATCH /role` (both forms, ack) + effects endpoint;
   migration with `set_transaction_role_override` (SQL dependent discovery), the replaced
   `replace_transaction_splits`, the index + harness tests; feed pagination; API level 2.
3. Frontend: `TransactionItem` fields; badge/picker/review queue; loan-override confirmation; two-row
   correction flow; paged feed; effects drill-downs with reconciling footers; explainers and copy;
   splits gating; integrity banner; API level 2; tests.
4. Ops: backfill npm script; preflight/postflight file; README section "Financial semantics" (rules
   table from §4.1, runbook for the review queue and for a wrong refund match); release note;
   `PRODUCTION_HEAD`.

---

## 12. Decisions needed from Trevor

Each has a recommendation; "as recommended" is a complete answer.

**Decided 2026-09-26 as recommended:** D1 (continuity first — see `PENDING_POSTED_CONTINUITY_DESIGN.md`),
D2, D3, D4, D6, D7, D10, D12, D13, D14. **D15 = (b)**: full aggregate pagination ships inside Phase B
(221 rows in the last 12 months at the 2026-09-26 historical audit — nothing was truncated then). **Direction agreed:** D5, D8, D11.
**D9:** product behaviour accepted; the dependent-row write is now fully specified (§4.9, §6.2, tests
`a06`/`c12`) and awaits Codex's confirmation. Each is kept below with its resolution.

- **D1 — Sequence.** Ship pending→posted continuity *before* Phase B (roadmap order), or accept that
  a role override / category / splits / loan link on a pending row is lost when it posts?
  **Recommend: continuity first.** The most likely correction is on a fresh (pending) card payment or
  Venmo row; losing it days later would make role correction feel broken.
- **D2 — Definitions.** (a) *Cash flow* = income − spending − debt payments − untracked card
  outflows: **cash retained after debt service**. *Savings rate* = (cash flow + **known** principal)
  ÷ income: principal that the app knows exactly (manual-loan links) is added back because paying
  it raises net worth like saving; a Plaid-categorised loan payment's unknown principal is **not**
  added back (conservative, and stated on the card). Alternatives: (b) *Savings rate* = cash flow ÷
  income — a pure cash-retention rate that never adds principal back (simpler, understates
  wealth-building for users with manual loans: 60.9 % vs 72.5 % in the fixture); (c) treat all debt
  payments as spending (today's look). **Recommend (a).** Whichever you pick, the card copy names it.
- **D3 — Plaid-categorised loan payments (no manual link).** Whole amount as *Debt payment*
  (excluded from Spending, subtracted in cash flow, not added back in the rate — no claim about its
  interest or principal), or whole amount as spending? **Recommend Debt payment**, with the
  manual-loan link as the path to a real principal/interest split.
- **D4 — Unpaired transfer-like rows** (Venmo/Zelle/unlinked destinations). Keep as spending/income
  with a review prompt, or exclude as "external transfer"? **Recommend keep + review prompt.**
- **D5 — Card payments and transfers whose other side is outside the tracked set** (OPEN; resolves
  Trevor's item 2). Adopt the **tracked-set principle** (§4.1): partners are found only among
  accounts included in cash flow; a card payment whose card is unlinked **or excluded from cash
  flow** is an untracked card outflow (subtracted, labelled with the reason); a transfer whose
  partner is unlinked or excluded is an external transfer (signed in cash flow, labelled); an
  externally funded card inflow is informational (no tracked cash moved). Neither is ever Spending or
  Income, and neither is added back in the Savings rate. Alternative: treat external transfers like
  internal ones (excluded from cash flow) — simpler, but a $500/month transfer to an excluded savings
  account would vanish from cash flow exactly as the card payment did in revision 2. **Recommend the
  tracked-set principle for both.** Persisting pairings as a `role_source` is Phase C.
- **D6 — Refund attribution.** Use the refund row's own budget/Plaid category (no schema change), or
  add `refund_of_transaction_id` so a refund inherits the original's *budget* category? **Recommend
  own category for Phase B**; revisit if refunds land unassigned often.
- **D7 — Splits on non-spending rows.** Block new ones, ignore existing ones (never delete), allow
  negative splits on refunds? **Recommend yes to all three.**
- **D8 — Recurring streams** (OPEN; resolves Trevor's item 3). **Merge, never drop**: a reliable
  recurring card or loan payment and its liability/manual-loan item become **one** upcoming item at
  the expected amount (the $900, with the $35 minimum shown), reserved once in Safe to Spend; a
  stream nothing else covers stays a bill at its amount; internal transfers within the tracked set
  are not bills; external transfers are. When the stream is not yet reliable (`EARLY_DETECTION`) the
  merged item reserves the minimum. Alternative: always reserve `max(expected, minimum)` regardless of
  stream maturity — slightly more aggressive. **Recommend as written.** (Per-stream include/exclude
  toggle deferred.)
- **D9 — Override behaviour** (product accepted; atomic design complete in rev 5). (i) Single-row
  override to Transfer allowed without a counterpart, with a counterpart *suggestion*; the two-row
  form is the same RPC with two ids and fails as a whole; (ii) overriding does **not** approve
  (`needs_review` separate); (iii) `user_role_override_at` (created by the continuity migration),
  never dropped by either rollback; (iv) a loan-linked override requires acknowledging the **shown
  amounts**, verified under the lock; (v) "no change" is judged on the stored override, so explicit
  `debt_payment` on a linked row is a real write; (vi) dependent rows (transfer partner, refunds
  including partial ones, under Phase A's same-account eligibility and ranking) are **discovered in
  SQL under the lock and reset in the same RPC**, returned in one `jsonb` with the rows —
  completeness by construction (§4.9), proven by `c12`.
- **D10 — Classifier scope.** Keep `CURRENT_CLASSIFIER_VERSION = 1` (Phase B = adoption + correction
  + pagination only), deferring to Phase C: card-payment leg pairing, `TRANSFER_*_SAVINGS` detailed
  categories as high-confidence transfers when the counterpart account type matches, P2P merchant
  heuristics. **Recommend keep v1** — it bounds the change and keeps reclassification out of the
  release.
- **D11 — API level and legacy fields** (OPEN; resolves Trevor's item 5). Freeze every existing
  field at its sign-based meaning and publish Phase B semantics in new fields (§6.4), so a level-1
  bundle shows exactly today's numbers (1 827.10 for the fixture, never 2 477.10); bump
  `X-Api-Level`/`CLIENT_API_LEVEL` to 2; keep `MIN_CLIENT_API_LEVEL = 0`; retire the frozen fields
  only when MIN is later raised. Alternative: change the existing fields' meaning **and** raise MIN to
  2 so stale bundles are refused outright — cleaner API, but refuses a client that would otherwise
  be harmless and requires the refusal path to be exercised in production for the first time.
  **Recommend freeze + new fields.**
- **D12 — Budget categories emptied by the change** (e.g. a "Credit card" category). One-time notice
  + preflight report, no automatic archive/rename. **Recommend as written.**
- **D13 — Manual-loan interest in Monthly Breakdown.** Synthetic "Loan interest" category vs. leaving
  it under `LOAN_PAYMENTS`. **Recommend synthetic category** (otherwise the bucket named after the
  excluded principal shows a small unexplained number).
- **D14 — Negative category totals.** Show as refunds (signed), never clamp in Budget/Breakdown
  (Safe to Spend already clamps remaining at ≥ 0). **Recommend show signed.**
- **D15 — Ship the 1 000-row truncation fix first?** DECIDED **(b)**: production had 221 transactions
  in the last 12 months at the 2026-09-26 historical audit, so nothing was truncated then; full aggregate pagination ships inside Phase
  B (§7.4).

Hard-stop conditions for implementation, carried over from LIM: any change that would alter
`loan_balance_applied`/restoration math, a non-additive migration, a write path for
`user_role_override` other than the two new RPCs, a fallback that masks `SemanticIntegrityError`, an
aggregate computed from a fetch that could be truncated, or a need to touch production data beyond
the Phase A backfill.

---

## Appendix A — Pending → posted continuity

Superseded in revision 3 by the separate document `PENDING_POSTED_CONTINUITY_DESIGN.md`, which shipped
before Phase B (D1; released — `PENDING_POSTED_CONTINUITY_RELEASE.md`). Phase B relies on its §3 contract (P1–P5): every correction on a pending row —
including `user_role_override` and its timestamp — survives posting in every arrival order (same page,
posted before removal, removal before posting via the `transaction_carryovers` record), the loan
ledger stays exact when the posted amount differs, page replay is idempotent, and a mutation racing a
posting receives `409 transaction_superseded` with the posted row so the client re-targets. Its open
decisions (C1–C5) are listed there.

---

## 13. Questions found during implementation (slice 1)

**Resolved after Codex's review and Trevor's decision (2026-09-29):**

- **Q1 — resolved.** The approved tracked-set principle gives **102.10** for the "checking not linked,
  4b marked as a transfer" variant; the stale "−397.90" in §9.1 is corrected and the test asserts 102.10.
- **Q2 — decided: retain.** A transfer leg pairs only with another `internal_transfer` leg (the
  conservative rule reconciliation uses). If only one side is marked, it is an external transfer and
  the other side stays in Income until it is marked too (the two-row form, §4.9).
- **Q3 — decided (Trevor): refuse.** When a spending-eligible transaction's splits do not sum to it in
  integer cents (or a split amount is not a finite number), the **budget** aggregate is refused with
  `SplitAllocationMismatchError` (`code: split_allocation_mismatch`, the first affected
  `transactionId`, every affected row in `mismatches`) until the splits are corrected. Stored splits are
  never modified and no unassigned adjustment is invented. It is deliberately **not** a
  `SemanticIntegrityError`, so it is never presented as a loan-data problem. Splits the role rules
  exclude (transfers, card payments, debt payments, loan-decomposed rows) are never read and cannot
  block the budget; cash flow and the Monthly Breakdown (which never read splits) stay available.
- **Q4 — resolved by the returned-payment treatment (§4.3).** A negative card-payment leg on a cash-side
  account is cash arriving: tracked return (0) when it pairs with a credit-side +leg, otherwise an
  untracked return **added** in cash flow. New output fields: `creditCardPaymentsReturnedTracked`,
  `creditCardPaymentsReturnedUntracked`, `creditCardPaymentsReversedExternally`; the Monthly Breakdown's
  `excluded` block gains `creditCardPaymentsReturnedUntracked`.
- **Q5 — decided: retain.** `fetchAllPages` stops only on an empty page; §7.4 is reconciled.
- **Q6 — documented.** `unclassifiedAmount` is the **signed net** (Plaid convention, + out / − in) of the
  unclassified rows, always reported alongside `unclassifiedCount` (a $45 purchase and a $20 deposit →
  count 2, amount 25).

**Still open (product choices, no figure depends on them yet):**

- **R1 — How returns are shown.** The module reports untracked returns on their own line. The UI could
  instead show one netted "card payments to untracked cards" line (outflows − returns). Either is
  consistent with the cash-flow total; it is a presentation choice for the frontend slice.
- **R2 — Whether "reversed externally" is shown at all.** It moves no tracked cash; it may be useful only
  as an explanation next to a card's balance. Presentation choice.
- **R3 — A return far from its payment.** A return is matched only to a credit-side leg within ±5 days,
  never to the original payment. If a payment to a *linked* card is returned more than 5 days after the
  card shows the reversal, both legs are unpaired: the return is added as cash (correct) and the card's
  +leg is "reversed externally" (0) — cash flow stays right, only the labels differ. Accepted residual,
  in the spirit of §4.3's existing fee/late-leg residual.

## 14. Implementation status

**Slice 1 (implemented, disconnected from live behaviour):**
- `backend/src/services/semanticAggregation.ts` — the pure module of §3: `aggregateCashFlow`,
  `aggregateCashFlowByMonth`, `aggregateBudgetSpend`, `aggregateMonthlyBreakdown`, `resolveRows`; every
  dollar through `getSemanticEffects()`; reciprocal transfer (±3 d) and per-payment card (±5 d)
  pairing (cash-side ↔ credit-side, returns included) over the fetched context
  `pairingContextRange(period)` (±10 d); R0 and R9; split mismatches refuse the budget
  (`SplitAllocationMismatchError`); effect rows for drill-down reconciliation. Integer-cent arithmetic.
- `backend/src/services/fetchAllPages.ts` — the keyset helper of §7.4 plus `(date, id)` and
  `(transaction_id, id)` PostgREST filter builders.
- `backend/src/testUtils/phaseBFixture.ts` — the §9.1 fixture; `semanticAggregation.test.ts` and
  `fetchAllPages.test.ts`.
- Nothing imports these modules outside their tests: no endpoint, response field, calculation,
  migration or loan bookkeeping changed.

**Planned (not implemented):** routing the aggregate fetches through `fetchAllPages` with role
columns and ±`PAIRING_PAD_DAYS` padding; the new response fields (§5, §6.1) behind API level 2; the
effects endpoint; recurring-stream merging (§4.8); the Phase B migration (`set_transaction_role_override`,
replaced `replace_transaction_splits`, index); `PATCH /role`; feed pagination; frontend; preflight,
the Phase A backfill (release gate) and release.
