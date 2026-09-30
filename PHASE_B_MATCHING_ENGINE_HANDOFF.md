# Phase B — card-payment matching engine: handoff for review

Prepared 2026-09-29/30 (overnight, autonomous). Scope: Stage 1 (the pure reference evaluator) and
Stage 2 (adversarial tests) of `CARD_PAYMENT_PAIRING_DESIGN.md` rev 3. **Nothing is committed.**

**Correction pass (2026-09-30, after Codex's review of the overnight work).** Two findings were fixed.
Failing regression tests were written first (6 failed before the fixes), and the backend suite,
typecheck and build were rerun:
1. **Ambiguous lineage** — two posted rows naming the same pending id. The decision was already
   inactive (`lineage_ambiguous`), but one replacement could still auto-pair (tracked, effect 0).
   Now every replacement candidate of an ambiguous lineage named by a user decision is **held** with
   that decision: unresolved, and unavailable for automatic matching (§3.6).
2. **Contradicting evidence** — for a leg with an active user decision, only tier-1-shaped legs were
   listed, so a late exact match or a near-amount card entry disappeared. Now every candidate the
   suggestion rules produce is listed, with its evidence kind and `contradictsDecision: true`. The
   decision's effect is unchanged, and the same limits and dismissals apply (§3.2).

Nothing else changed in scope. The remaining open questions in §5 are **provisional
interpretations**, not approved product rules.

**Correction pass 2 (2026-09-30) — the approved conflicting-replacement rule.** Trevor approved this
rule: when more than one posted transaction on the same user/account claims to replace the same
pending payment, their matching stays unresolved. No replacement is chosen automatically, and no
resolved matching effect is published while the conflict remains.
- **Where it's implemented:** at the **lineage level**, ahead of every precedence step, whatever
  decision exists — user pair, destination confirmation, `destination_removed_card` — or none.
- **Q12 is closed.**
- **Unchanged:** one unambiguous replacement, and ordinary relinking, behave as before (tier 1 still
  matches automatically). Conflicting bank rows are never deleted, merged or chosen between.
- **Preserved:** excluded-account treatment and the per-period bounds.
- **Tests first:** the regression tests were written before the fix, and 10 failed. A corrected
  snapshot with one replacement evaluates normally, without manual action. There is no sync retry,
  database write or repair interface: successive snapshots are simply evaluated.
- **Future requirement (not built):** a *persistent* conflict needs a clear review path that doesn't
  make the user guess which bank transaction is the real one. It is recorded in the design (§3.6,
  §10).

## 1. Starting point and working tree

- **Repository:** `C:\Users\Trevor\dev\my-finances-phase-b`, branch `feature/phase-b-aggregation-slice1`.
- **Start:** `460e6a3`, clean working tree. No earlier engine work existed, so nothing was restarted or
  overwritten.
- **Current:** still at `460e6a3`. The only tracked modification is documentation:
  `CARD_PAYMENT_PAIRING_DESIGN.md`, which records the approved conflicting-replacement rule
  (correction pass 2). There are also four new untracked files:
  - `backend/src/services/cardPaymentMatching.ts` — the engine;
  - `backend/src/services/cardPaymentMatching.test.ts` — Stage 1 unit tests;
  - `backend/src/services/cardPaymentMatching.adversarial.test.ts` — Stage 2 adversarial and
    generated tests;
  - `PHASE_B_MATCHING_ENGINE_HANDOFF.md` — this file.
- **Repository instructions:** there is no `CLAUDE.md` or `AGENTS.md` in the repository. The README's
  testing notes were followed: backend `npm test`, `npm run typecheck`, `npm run build`, with CI's
  placeholder environment.

## 2. What was implemented

`evaluateCardPayments(input)` is a pure evaluator for one user.
- **Input:** `userId`, an explicit `asOf`, accounts (with owner), transactions (integer cents, Plaid id,
  `pending_transaction_id`, effective role), continuity carry-overs, and recorded decisions (lineage
  keys).
- **Output**, per card leg: state, reason, inactive-decision detail, partner, decision, candidates,
  signed effect or effect bounds, and fee excesses. It also returns a status for every decision, and
  the superseded pending rows.
- **It uses** no database, network, filesystem or clock, and every output list is sorted.

**Two helpers:**
- `summarizeCardPaymentPeriod` — a period's card-payment contribution as `[low, high]`. Each leg counts
  in its own date's period, so there is no cross-month cancellation.
- `evaluateCardPaymentsForAllUsers` — evaluates each user of a mixed input independently.

**Rules implemented** (design section in brackets):
- **Sides and pool** [§3.1]:
  - the credit side is `type = 'credit'`; everything else, including NULL, is the cash side;
  - the pool is every card leg (non-zero, `credit_card_payment`, not superseded) on every account of
    the user, excluded accounts included (T5).
- **States and effects** [§3.2]:
  - included cash-side legs are `tracked` (0, or the accepted fee remainder), `untracked` (−amount),
    or `unresolved` with bounds `{0, −amount}`;
  - credit-side legs are `paired`, `funded_from_excluded` or `unresolved`, always 0;
  - legs on excluded accounts are `not_counted`, 0.
- **Precedence** [§3.2, §3.6]:
  1. an active user decision;
  2. otherwise, a leg held by an inactive user decision stays unresolved;
  3. otherwise tier 1;
  4. otherwise a removed-card decision;
  5. otherwise no included card;
  6. otherwise unresolved.

  Evidence that contradicts an active user decision stays visible without overriding it. Every
  candidate the suggestion rules would show — tier-1-shaped, exact 6–60 days, near amount,
  return-of-pair — is listed with its evidence kind and `contradictsDecision: true`, subject to the
  usual limits and dismissals. *(Correction pass. This replaces the earlier `contradicts_decision`
  kind, which listed tier-1-shaped legs only and lost the evidence kind.)*
- **Tier 1** [§3.3]: exact opposite cents, opposite side, ≤ 5 days, reciprocal-closest, tie →
  ambiguous. Dismissed (`not_this_pair`) edges are removed.
- **Tier 2** [§3.3, T2/T3] — suggestions only:
  - exact amount 6–60 days away;
  - near amount (1 cent – $5.00) within 5 days;
  - return-of-pair, a label on an exact match.

  The reason order is `ambiguous` > `possible_match` > `amount_differs` > `no_candidate`.
- **No automatic absence** [§3.4, T4]: time, sync status, missing candidates and rejections never make
  a leg untracked. `asOf` affects only carry-over expiry and the `recent` label.
- **Fee rules** [§4.3, T6]: the whole table — both directions, either side larger, excluded card or cash
  partner. The difference must equal the explicitly accepted `acceptedDifferenceCents`.
- **Lineage** [§3.6, §4.8]:
  - a posted row on the same account supersedes its pending row;
  - decisions resolve through lineage (posted replacement → row → waiting carry-over → gone);
  - decisions become inactive for `waiting_to_post`, `partner_gone`, `lineage_ambiguous`,
    `amount_changed`, `role_changed`, `not_cash_side`, `sides_not_opposite`, `direction_mismatch`,
    `difference_not_accepted` or `conflicting_decisions`;
  - inactive decisions are kept, and reactivate if the data returns;
  - **conflicting replacements — APPROVED rule (Trevor, 2026-09-30).** More than one row on the same
    account names the same pending id. **Every** such row is held, **whether or not any decision
    exists**:
    - state `unresolved`, reason `ambiguous_replacement`, detail `lineage_ambiguous`;
    - no candidates, no automatic match, and never another leg's partner or candidate;
    - bounds {0, −amount} in its own period;
    - rows on excluded accounts stay `not_counted`.

    Any decision naming the lineage — including one naming a conflicting row by its own posted id —
    is inactive `lineage_ambiguous`, and is reported on the rows it actually names. Rows on
    different accounts, or of different users, are not a conflict.
    *(Correction pass 1 held these rows only when a user decision named them. Correction pass 2 makes
    the guard lineage-level, as approved.)*
- **Removal** [§4.7, T9]: `destination_removed_card` → `untracked/removed_card`, ranked below tier 1,
  so a relinked card re-tracks.
- **Same-user boundaries:**
  - another user's accounts and rows are invisible;
  - a decision of this user naming another user's account is `rejected/foreign_account`;
  - another user's decision naming this user's rows is `rejected/foreign_user`.
- **Integrity:** duplicate ids, unknown accounts, non-integer cents, invalid dates, and a pair without
  an accepted difference all throw `CardPaymentMatchingIntegrityError`. Nothing is guessed.

**Live app:** no existing file was modified. `semanticAggregation.ts` and its three `it.fails` tests
are unchanged.

## 3. Commands and actual results

All commands ran in `backend/`, with CI's placeholder environment (`FRONTEND_URL`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `PLAID_CLIENT_ID`, `PLAID_SECRET`). The worktree has no `.env`.

**Checks run, and their actual results:**

| Check | Result |
|---|---|
| `npm run typecheck` | passed |
| `npx vitest run` (full backend suite) | **38 files; 1247 passed, 3 expected fail, 10 todo (1260)** — correction pass 2 (pass 1: 1239 passed) |
| `npx vitest run src/services/cardPaymentMatching` | 2 files; 108 passed, 10 todo — correction pass 2 (pass 1: 100; overnight: 92) |
| `npm run build` | passed. It emits `dist/services/cardPaymentMatching.js`, like slice 1's `semanticAggregation.js`, but nothing imports it |
| `git diff --check` (tracked files) | clean — there are no tracked changes |
| whitespace check of the three new source files (`git diff --no-index --check`) | clean |
| importer search (`backend/src`, `frontend/src`) | no file outside the engine's own two test files references `cardPaymentMatching` |

**Mutation check.** Each of these rule violations was temporarily injected into a copy of the engine,
run against both test files, and then reverted. The restore was verified by sha256.

| Injected violation | Failing tests |
|---|---|
| tier 1 window 5 → 6 days | 5 |
| excluded accounts dropped from the evidence pool | 8 |
| unresolved lower bound guessed as "untracked" | 3 |
| ties broken arbitrarily | 7 |

The correction pass repeated the check for its own fixes, restoring by sha256 each time:

| Injected violation | Failing tests |
|---|---|
| finding 1 reverted (ambiguous replacements not held) | 4 |
| finding 2 reverted (contradictions limited to tier-1-shaped legs) | 3 |
| contradictions ignoring dismissals | 4 |

Correction pass 2 checked the lineage-level guard the same way:

| Guard part removed | Failing tests |
|---|---|
| conflicting rows back in the tier 1 pool | 8 |
| no hold state for conflicting rows | 10 |
| a decision naming a conflicting row by its posted id treated as unambiguous | 2 |
| held rows listing candidates | 3 |

**Expected failures (unchanged, not weakened):** the three `it.fails` tests in
`semanticAggregation.test.ts` still fail as designed:
- R3 late leg;
- R3 far return;
- R7 excluded card closer.

They document that `semanticAggregation.ts` is not yet integrated with stored matching states. Separate
passing coverage shows that the reference evaluator reaches each of those figures:
- the confirmed late leg gives 0;
- the confirmed Codex return gives 0;
- R7 gives −100 with zero unresolved exposure.

**Todo (10):** the `it.todo` list at the end of `cardPaymentMatching.test.ts` names the database and
application requirements this work does not cover (§6 below).

**Not run:**
- Frontend checks — no frontend file changed.
- The card-payment audit harness and every other database harness — local database work was out of
  scope.
- Anything against production.

## 4. Bugs found and regression tests

| # | Bug | How found | Fix | Regression test |
|---|---|---|---|---|
| 1 | When two decisions conflicted on one leg, the leg reported the decision that came first **in input order** — the result depended on array order | Found by the generated reordering test (`reordering every input array…`) | Claims are sorted by decision id before use | `REGRESSION: conflicting decisions report the same decision on a leg whatever their input order` |
| 2 | A pair whose two references resolve to the **same** current row (the pending id and the posted id of one lineage) counted as claiming that row twice, and was reported as `conflicting_decisions` | Spotted while designing the adversarial cases; the test was written first and **failed before the fix** | Each decision claims each row once | `REGRESSION: a pair whose two references resolve to the SAME row is sides_not_opposite, not a conflict` |
| 3 | A decision leg whose row changed to amount 0 was reported as `role_changed` | Same as #2: the failing test came first | The amount comparison runs before the card-leg check | `REGRESSION: a leg whose amount became 0 is reported as amount_changed, not role_changed` |

| 4 | **Codex finding 1:** with an ambiguous lineage (two posted rows naming one pending id), the decision was inactive but a replacement row could still auto-pair — tracked, effect 0 | Codex review. The failing tests were written first | The ambiguous replacement candidates are held with the decision (claimed): unresolved, and outside the tier 1 pool | `single-leg decision: both ambiguous replacements stay unresolved…`, `pair decision: the ambiguous cash replacements AND the named card leg stay unresolved…`, `pair decision with the ambiguity on the CARD side…` — each also run with reordered inputs; generated invariant **I8** |
| 5 | **Codex finding 2:** an active user decision listed only tier-1-shaped contradictions, so a late exact match (6 days) or a near amount (−98) was dropped | Codex review. The failing tests were written first | Every suggestion-rule candidate is listed with `contradictsDecision: true` | `a late exact match (6 days) contradicting "unlinked" is listed…`, `a near-amount suggestion (−98 one day later)…`, `the suggestion limits still apply to contradictions…`, `a dismissed candidate is not listed as a contradiction either`, `an active user pair lists a contradicting late exact match…`; generated invariant **I9** |

| 6 | **Q12 / approved rule:** replacements of an ambiguous lineage were held only when a *user* decision named them. With a `destination_removed_card` decision, or no decision, one replacement could still auto-pair | The rule Trevor approved on 2026-09-30. The failing tests were written first (10 failed) | A lineage-level guard: every row of a conflicting group is `ambiguous_replacement` — outside the tier 1 pool, with no candidates, and never another leg's candidate. A decision naming a conflicting row by its posted id is also ambiguous | `Q12 closed — a removed-card decision…`, `no saved decision: both replacements held…`, `a user decision naming one replacement by its own posted id is held too…`, `the held rows keep the approved period-specific bounds…`, `excluded-account treatment is preserved…`, `isolation: one replacement per ACCOUNT is not a conflict…`, `a corrected snapshot with one replacement evaluates normally…`, `ordinary relinking with a single replacement still matches automatically…` — the first two with reordered inputs; generated invariant **I10** |

No approved rule was changed to make a test pass.

**Test expectation changes in correction pass 2** (flagged for review):
- The two pass-1 user-decision cases now expect reason `ambiguous_replacement` on the conflicting rows
  T1/T2, instead of `decision_invalidated`. They additionally assert the naming `decisionId`. The
  holding assertions — unresolved, no partner, effect null, bounds, no tracked/paired/untracked legs,
  and reorder equality — are unchanged. The pair's other, unambiguous leg (`Pk`) still expects
  `decision_invalidated` / `lineage_ambiguous`.
- The generated tier 1 restatement now excludes conflicting groups from its pool, as the approved rule
  requires. It is computed independently from the input.

**Test updates in the correction pass:**
- Six existing assertions on exact candidate objects now include the new `contradictsDecision`
  field: `false` for ordinary suggestions.
- The two earlier contradiction assertions now read `kind: 'tier1_competitor', contradictsDecision:
  true` instead of the removed `contradicts_decision` kind. They mean the same thing.
- The generator now sometimes creates a second posted row naming the same pending id, and the coverage
  guard requires both a held ambiguous lineage and a contradiction to occur.

**Test structure (Stage 2):**
- **Hand-built scenarios**, with outcomes derived from the rules:
  - chains of duplicate amounts;
  - non-reciprocal bests;
  - same-side opposites;
  - excluded-account competition;
  - month-boundary pairs;
  - all 24 pending → posted arrival orders, checked at every intermediate snapshot;
  - invalidation and reactivation;
  - precedence;
  - dismissals breaking ties;
  - return-of-pair negatives;
  - mixed users.
- **Invariants I1–I10 over 300 generated two-user histories** (seeds 1000–1299, `mulberry32`):
  - exactly the expected legs;
  - only included cash legs move cash flow;
  - exact bounds;
  - untracked only through evidence or the user;
  - tracked only with an included-card partner and the §4.3 remainder;
  - symmetric pairs;
  - period ranges are consistent and additive;
  - *(correction pass)* **I8** — replacements of an ambiguous lineage named by a live user decision are
    never resolved or paired;
  - *(correction pass 2)* **I10** — every row of a conflicting replacement group (computed from the input
    alone) is held: unresolved `ambiguous_replacement` (or `not_counted` on an excluded account), never
    a partner, never a candidate, with no candidates of its own. No other row carries that reason;
  - *(correction pass)* **I9** — `contradictsDecision` is true exactly for candidates of legs with an
    active user decision.
- **Also over the generated histories:**
  - determinism under reordering;
  - cross-user isolation;
  - `asOf` invariance of states, effects and bounds;
  - an independent restatement of tier 1 (decision-free histories);
  - a coverage guard that fails if the generator stops producing any of 12 state/reason combinations, a held ambiguous lineage, or a contradiction.

## 5. Open questions, limitations and unimplemented requirements

**Provisional interpretations — rev 3 does not settle these.** Each is implemented conservatively so
that work could continue. **None is an approved product rule**, and each may change after Trevor or
Codex decides it.

| # | Question | Minimal example | Implemented |
|---|---|---|---|
| Q1 | Does a leg held by an **inactive** decision stay unresolved even when a proof applies (`no_included_card`)? | No included card. The user marks pending Pc (+100) "unlinked"; Tc posts at +98 | Unresolved [−98, 0], following §3.6 ("an inactive decision leaves its legs unresolved") |
| Q2 | Are legs held by a user decision (active **or inactive**) removed from automatic pairing and from others' candidates? | User pair C1–X; X's amount changes to −98 (inactive); C2 +98 is 1 day from X | X stays held: C2 is `no_candidate`, not paired with X. **Still provisional** for the ordinary inactive reasons (amount/role changed, partner gone, waiting). Conflicting replacements are now governed by the approved lineage-level rule instead, which does not depend on a decision |
| Q3 | Two live (non-superseded) user decisions on one leg — the database should prevent this | `pair(C,X)` and `destination_unlinked(C)` | Both inactive `conflicting_decisions`; the lowest decision id is reported on the leg |
| Q4 | Distance limit for return-of-pair | Pair Sep 1/2, reversal Sep 10, return Nov 20 (71 days) | The 60-day suggestion limit applies between the return and the reversal. There is no limit on the time since the original pair, which must have the same absolute amount |
| Q5 | An **inactive** `destination_removed_card` decision | Removed-card decision on C +100; C now +98 | Ignored: it doesn't apply or hold the leg, which is evaluated normally |
| Q6 | A destination decision on a **credit-side** leg | `destination_unlinked` naming a card leg | Inactive `not_cash_side`; for `destination_unlinked` it still holds the leg (Q2) |
| Q7 | `partner_gone` is an inactivity reason in §3.6 but not a leg reason in §3.2 | Pc–Pk pair; Pk's carry-over expires | Leg reason `decision_invalidated`, detail `partner_gone` |
| Q8 | A posted row naming a pending id **on a different account** | — | Not a replacement: the design's lineage key includes the account |
| Q9 | When the "recent" wording switches (§6.1 says "usually 1–3 days") | — | `RECENT_LABEL_DAYS = 10`, label only |
| Q10 | Zero-amount card rows | — | Not card legs, so they get no state (as slice 1) |
| Q11 | Does a candidate on an **excluded** card contradict "a card I haven't linked"? The effect would be the same (untracked), but the destination differs | C +100 marked unlinked; E −100 six days later | Listed as a contradiction, like any other suggestion-rule candidate |
| ~~Q12~~ | **Closed — approved by Trevor, 2026-09-30.** Replacements of an ambiguous lineage are held under a `destination_removed_card` decision too, and also with no decision at all | Removed-card decision on pending Pc; two posted rows name Pc; an included card leg is 1 day from one of them | Both replacements `ambiguous_replacement`; the card leg is not auto-paired. This is no longer provisional |

**Limitations of this module:**
- It computes card-leg states and the card-payment contribution **only**. It does not produce whole
  cash-flow or savings-rate ranges; that is integration with `semanticAggregation.ts`.
- It has no persistence, versions or read protocol, so it can never return `updating`. That is the
  caller's job (§3.7).
- O(n²) per user over card legs — fine for a few per month.

**Future requirement recorded, not built:** a conflicting-replacement hold that **persists** needs a
clear review path that shows the user the conflict without asking them to guess which bank
transaction is real (design §3.6, §10). Today the evaluator only holds the rows; there is no review
workflow, sync retry, repair interface or automatic cleanup.

**Not implemented** — database or application work. Pure tests here do **not** satisfy any of these:
- §3.5 tables and §3.7 input triggers (acceptance test 13).
- The stale-state and read protocol returning `updating` with no figures (14–16).
- **16a–16d:** lock order, publication, deadlock behaviour and trigger scope. These are database
  acceptance requirements; nothing here tests concurrency.
- The §3.8 SQL evaluator and its equivalence with this oracle (10).
- RPCs, same-user refusals, CAS on `computed_at_version`, concurrency and grants (20–22).
- The LIM removal conversion (18).
- Integrating `semanticAggregation.ts` and flipping its three `it.fails` tests (§5).
- API fields and frontend (24–26).
- The Phase A backfill release gate, and running the audit against production.

## 6. Recommended next slice (planning only — nothing started)

**Slice 2a — schema and SQL evaluator, disconnected**, in a throwaway harness only:
1. **One migration file (not applied):**
   - `card_payment_decisions` (lineage-keyed, account FK only);
   - `card_payment_auto_pairs`, `card_payment_leg_states` and `card_payment_eval_versions` (no FKs to
     data rows);
   - input triggers with `card_payment_bump`;
   - `evaluate_card_payments(user)` in plpgsql (§3.7 steps 1–7);
   - `get_card_payment_states`;
   - grants and postconditions.

   It includes no decision RPCs and no change to the sync or LIM RPCs yet.
2. **Verification gates, before any review for applying it:**
   - access-control harness tests for acceptance tests 13–16 and 16a–16d (holder/contender for lock
     order and deadlock cases), plus 22 (grants);
   - an oracle-equivalence test: generated histories (reusing Stage 2's generator, exported as JSON
     fixtures) evaluated in SQL and by this module, required to be identical;
   - the repository migration-replay harness;
   - `git diff --check`;
   - Codex review.
3. **Out of scope for 2a:** backend wiring, RPCs, frontend, and any production access. Applying the
   migration anywhere but a throwaway container needs Trevor's explicit approval and the usual
   preflight/postflight file.

**Later slices:**
- 2b — decision RPCs plus sync and LIM integration;
- 2c — `semanticAggregation.ts` consumes stored states, and the `it.fails` tests flip;
- 2d — API level 2 fields and frontend.

## 7. Live app unchanged

- The only tracked file modified is `CARD_PAYMENT_PAIRING_DESIGN.md` (documentation: the approved
  rule, closing Q12, the future review-path requirement and acceptance test 17a). No application code
  was changed.
- No route, service used by the app, script or frontend file imports the engine.
- There were no migrations, schema changes, database access (local or production), dependency or
  environment changes, commits, pushes, pull requests, merges or deployments.
- Database concurrency, persistence and live integration are **not** verified by this work.
