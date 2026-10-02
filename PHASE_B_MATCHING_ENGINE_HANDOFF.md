# Phase B — card-payment matching engine: handoff for review

> **Current status (2026-10-01).** This document is a chronological record. Statements in the earlier
> sections such as "nothing is committed", "uncommitted" or "not pushed" describe the checkpoints at
> the time; they are superseded by git history.
> - **Draft PR #8** (head `80c724d`): slice 1 plus the engine and design work — `0647c1e`, `beb032c`,
>   `80c724d` and earlier.
> - **Draft PR #9** (head `afa29ee`): slice 2a — `bb4e2d1`, `afa29ee`. CI passed.
> - **Slice 2b-1**, the decision RPCs, is §9.
>
> Nothing is merged, applied to a hosted database or released. The live app does not consume any of
> this work.

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

**Correction pass 3 (2026-09-30) — Trevor's second set of approvals.** This pass started from the
reviewed checkpoint `0647c1e`, which Trevor had committed. The tree was clean, with no unexpected
work. Five choices were approved and recorded in the design (§3.2, §3.3, §3.6, §4.7, §10, §11 test 17b).

**The only financial behaviour that changed is #2.** The others already matched the approvals; for
those this pass records the approval and adds explicit coverage.

| # | Approved choice | Engine behaviour |
|---|---|---|
| 1 | **Changed user confirmations stay reserved.** An amount change in a confirmed match leaves the entries out of automatic matching and out of candidate lists while the confirmation is inactive. The account owner will review them through a future guided in-app interface — a user workflow, not developer review, and not built | Unchanged (was provisional Q2). New explicit test |
| 2 | **Narrow known-effect exception.** A user-confirmed unlinked destination, a same-direction amount correction, and no included credit account: the corrected effect is published ($100 → $98 gives −$98). The confirmation stays **inactive** and visibly needs review, and the leg stays **reserved** | **Changed.** The leg becomes `untracked` / `no_included_card`, keeping `decisionId` and `detail: 'amount_changed'`; the decision stays inactive. Before, it was unresolved [−98, 0] |
| 3 | **An invalidated removed-card record is re-evaluated** with current bank data under the existing rules. A clear tier 1 match applies; otherwise it stays unresolved unless independent evidence establishes the effect. The invalid record is never proof, never overrides a user confirmation, and never bypasses the conflict guard | Unchanged (was provisional Q5). New explicit tests |
| 4 | **Return suggestions: refund and reversal up to 60 days apart**, and the original may be older. Confirmation is required, manual matching is unrestricted, and no automatic window is widened | Unchanged (was provisional Q4). New boundary tests at 60 and 61 days, 5 and 6 days, and manual matching |
| 5 | **Possible matches on excluded cards are shown** against "unlinked", with the confirmation and effect unchanged. The evidence kind and `contradictsDecision` are kept | Unchanged (was provisional Q11). New explicit test |

**Cosmetic choices** are kept separate from the financial rules: the future "Possible match on an
excluded card" wording, and the guided-review interface. Neither is built.

**Tests first.** 19 tests were added before the engine change. Exactly the two positive #2 tests failed
(payment and return). All the others passed against the unchanged engine, confirming #1 and #3–#5
already held.

## 1. Starting point and working tree

- **Repository:** `C:\Users\Trevor\dev\my-finances-phase-b`, branch `feature/phase-b-aggregation-slice1`.
- **Start:** `460e6a3`, clean working tree. No earlier engine work existed, so nothing was restarted or
  overwritten.
- **Current (correction pass 3):** HEAD is `0647c1e`, Trevor's commit of the work below. This pass's
  changes are **uncommitted**:
  - `backend/src/services/cardPaymentMatching.ts` (modified): the #2 exception, and one doc comment;
  - `backend/src/services/cardPaymentMatching.adversarial.test.ts` (modified): 19 tests, invariant I11,
    a generator branch and a coverage guard;
  - `CARD_PAYMENT_PAIRING_DESIGN.md` (modified): the approvals;
  - `PHASE_B_MATCHING_ENGINE_HANDOFF.md` (modified): this section.

  `cardPaymentMatching.test.ts` is unchanged.
- **History before `0647c1e`:** the tree was at `460e6a3`, with these files untracked:
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
  2. otherwise, a counted leg held by an inactive user decision stays unresolved, except for the
     approved same-direction, unlinked-destination amount correction with no included credit account
     (correction pass 3 above); the confirmation stays inactive and the leg stays reserved;
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
| `npx vitest run` (full backend suite) | **38 files; 1266 passed, 3 expected fail, 10 todo (1279)** — correction pass 3 (pass 2: 1247; pass 1: 1239) |
| `npx vitest run src/services/cardPaymentMatching` | 2 files; 127 passed, 10 todo — correction pass 3 (pass 2: 108; pass 1: 100; overnight: 92) |
| `npm run build` | passed. It emits `dist/services/cardPaymentMatching.js`, like slice 1's `semanticAggregation.js`, but nothing imports it |
| `git diff --check` (tracked files) | passed — no whitespace errors in the four-file correction delta |
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

Correction pass 3 checked the #2 exception by loosening each condition:

| Condition loosened | Failing tests |
|---|---|
| included-card condition ignored | 3 |
| same-direction condition ignored | 1 |
| extended to pair decisions | 1 |
| extended to any invalidation reason | 2 |
| exception drops the needs-review marker | 3 |

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

| 7 | *(approved behaviour change, not a bug)* #2 known-effect exception: a confirmed unlinked payment corrected $100 → $98 with no included card showed an unresolved range [−98, 0] instead of the known −98 | Trevor's approval, 2026-09-30. The failing tests were written first (2 failed) | One branch in the inactive-decision case, gated on all five conditions | `2. confirmed $100 unlinked payment corrected to $98…`, `2. the same exception for a confirmed return…`, and seven negative tests (`2 (negative). …`: included card, direction change, conflicting replacements, conflicting decisions, changed role, pair decision, ownership failure); generated invariant **I11** |

No approved rule was changed to make a test pass. No existing test expectation changed in correction
pass 3.

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
- **Invariants I1–I11 over 300 generated two-user histories** (seeds 1000–1299, `mulberry32`):
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
  - *(correction pass 3)* **I11** — a leg that publishes an effect while carrying an inactive decision
    is exactly the approved exception (destination_unlinked, same direction, amount changed, no
    included card, reserved). The generator has a branch that produces it, and the coverage guard
    requires it;
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
| Q1 | Does a leg held by an **inactive** decision stay unresolved even when a proof applies (`no_included_card`)? | No included card. The user marks pending Pc (+100) "unlinked"; Tc posts at +98 | **Decided in part (approved #2, 2026-09-30):** this exact example now publishes −98, with the decision inactive and the leg reserved. The exception does not extend to changed roles, missing counterparts, conflicting decisions, conflicting or ambiguous lineage, ownership failures or an included card; ordinary rules apply instead. A changed non-card role leaves this evaluator; a foreign-owned decision is rejected, without blocking independent proof for the user's payment. Counted legs held by inactive user decisions otherwise stay unresolved. **Still provisional:** the remaining pair-shape reasons (`not_cash_side`, `sides_not_opposite`, `direction_mismatch`, `difference_not_accepted`) stay unresolved |
| Q2 | Are legs held by a user decision (active **or inactive**) removed from automatic pairing and from others' candidates? | User pair C1–X; X's amount changes to −98 (inactive); C2 +98 is 1 day from X | X stays held: C2 is `no_candidate`, not paired with X. **Approved for amount changes** (#1, 2026-09-30). **Still provisional** for the other inactive reasons (role changed, partner gone, waiting, pair-shape reasons, conflicting decisions); the same reservation is applied to them. Conflicting replacements are governed by the approved lineage-level rule |
| Q3 | Two live (non-superseded) user decisions on one leg — the database should prevent this | `pair(C,X)` and `destination_unlinked(C)` | Both inactive `conflicting_decisions`; the lowest decision id is reported on the leg |
| ~~Q4~~ | **Closed — approved #4, 2026-09-30.** Distance limit for return-of-pair | Pair Sep 1/2, reversal Sep 10, return Nov 20 (71 days) | Up to 60 days between refund and reversal; the original may be older. **Still provisional:** that the original pair must have the same absolute amount, and must be *tracked* (both legs on included accounts) |
| ~~Q5~~ | **Closed — approved #3, 2026-09-30.** An **inactive** (amount-changed) `destination_removed_card` decision | Removed-card decision on C +100; C now +98 | Re-evaluated under the existing rules. It is never proof, never reserves the leg, never overrides a user confirmation, and never bypasses the conflict guard |
| Q6 | A destination decision on a **credit-side** leg | `destination_unlinked` naming a card leg | Inactive `not_cash_side`; for `destination_unlinked` it still holds the leg (Q2) |
| Q7 | `partner_gone` is an inactivity reason in §3.6 but not a leg reason in §3.2 | Pc–Pk pair; Pk's carry-over expires | Leg reason `decision_invalidated`, detail `partner_gone` |
| Q8 | A posted row naming a pending id **on a different account** | — | Not a replacement: the design's lineage key includes the account |
| Q9 | When the "recent" wording switches (§6.1 says "usually 1–3 days") | — | `RECENT_LABEL_DAYS = 10`, label only |
| Q10 | Zero-amount card rows | — | Not card legs, so they get no state (as slice 1) |
| ~~Q11~~ | **Closed — approved #5, 2026-09-30.** Does a candidate on an **excluded** card contradict "a card I haven't linked"? | C +100 marked unlinked; E −100 six days later | Listed, with its evidence kind and `contradictsDecision: true`; the effect is unchanged. The wording "Possible match on an excluded card" is cosmetic and not built |
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

**Not implemented** (as of this section; current coverage is in §8 and §9) — database or application
work. Pure tests here do **not** satisfy any of these. *Since done at the database level by slice 2a
(§8):* the tables and triggers (13), the stale-state half of 14–15, 16a–16d, the SQL evaluator and
its equivalence (10), and grants on the 2a objects (22). The decision RPCs are §9. The rest remain
open.
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

## 6. Recommended next slice (planned 2026-09-30; slice 2a is now implemented — see §8)

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

- **Application code:** no route, service used by the app, script or frontend file was changed. The
  modified tracked files are the isolated engine, its adversarial tests and two documents (§1).
- **Commits:** Claude made no commits. `0647c1e` is Trevor's commit, and correction pass 3 is
  uncommitted.
- No route, service used by the app, script or frontend file imports the engine.
- There were no migrations, schema changes, database access (local or production), dependency or
  environment changes, commits, pushes, pull requests, merges or deployments.
- Database concurrency, persistence and live integration are **not** verified by this work.

## 8. Slice 2a — database schema and SQL evaluator (implemented 2026-09-30; since committed as `bb4e2d1` + `afa29ee`, draft PR #9)

**Branch and state** *(as at implementation; superseded — the branch was committed and pushed, §8.3)*:
- Local branch `feature/phase-b-slice2a-sql-evaluator`, created from the reviewed checkpoint
  `80c724d` (draft PR #8's head). It has not been pushed.
- Nothing is committed. The migration has been applied only inside throwaway test containers, and
  never to a hosted database.
- Historical statements above that say work is "uncommitted" are superseded by the git history
  (`0647c1e`, `beb032c`, `80c724d`).

**Files:**

| File | What |
|---|---|
| `supabase/migrations/20260930120000_card_payment_matching_state.sql` | The disconnected schema: `card_payment_decisions`, `card_payment_eval_versions`, `card_payment_leg_states`, `card_payment_auto_pairs`, `card_payment_decision_states`; the input triggers and `card_payment_bump`; `evaluate_card_payments`, `try_evaluate_card_payments`, `get_card_payment_states`; grants and postconditions |
| `supabase/tests/access_control/sql/a08_card_payment_grants.sql` | Test 22 at runtime: client roles denied on every table, function and sequence; `service_role` allowed |
| `supabase/tests/access_control/sql/a09_card_payment_invalidation.sql` | Tests 13 and 16d: every input change bumps in the writer's transaction; non-inputs and same-value updates don't; rollback leaves no bump; item and account cascades bump; user deletion is tolerated; ownership is refused at write time |
| `supabase/tests/access_control/sql/a10_card_payment_evaluator.sql` | Tests 14, 15, 16a (single session) and 20 at database level |
| `supabase/tests/access_control/concurrency/c12…c15_card_*` | 16a (both halves), 16b and 16c, with real concurrent sessions |
| `supabase/tests/card_payment_evaluator/{run.sh,export.cjs,compare.cjs}` | Oracle equivalence: SQL vs the TypeScript evaluator |
| `backend/src/testUtils/cardPaymentHistories.ts` | The Stage 2 generator, moved **verbatim** out of the adversarial test so the SQL harness can reuse it. It is test-only (excluded from the production build) |
| `backend/src/services/cardPaymentMatching.adversarial.test.ts` | Now imports the moved generator. Results are unchanged: 127 passed, 10 todo |

**Verified (actual results):**

| Check | Result |
|---|---|
| Oracle equivalence (`card_payment_evaluator/run.sh`) | 300 generated histories plus 31 targeted scenarios, 662 user evaluations: **0 differences**, 59 distinct state/candidate shapes. A coverage guard requires every rule path. The scenarios were added after measuring that the generator alone never reaches `matched_leg_not_posted`, `partner_gone` or `return_of_pair` |
| Harness sensitivity (mutations of the SQL evaluator, restored by sha256) | window 5→6: 23 evaluations differ; horizon 60→61: 3 differ; exception ignoring the included-card condition: 9 differ |
| `access_control/run.sh` (full) | **25 passed, 0 failed**: every existing test plus a08–a10 and c12–c15 |
| `phase_a/run.sh` | scaffold: **23 passed**; history: **18 passed, 7 skipped**. The skips are the gate tests that need a pre-migration database, skipped by design in history mode |
| `replay/run.sh`, emulator tier | **R1–R5 passed**: clean replay with no error or warning, idempotent, historical = CLI schema, production state applies only the pending files |
| `card_payment_audit/run.sh` | passed |
| Backend typecheck / suite / build | passed / **1266 passed, 3 expected fail, 10 todo** / passed. The three `it.fails` tests and the 10 todos are unchanged |
| Runtime importers | none: no route, service, script or frontend file references the engine or any `card_payment_*` object |

**Mutation checks of the database tests** (each restored by sha256):
- **c12** fails when the evaluator takes no L2 lock: the published version misses the writer's bump.
  - Removing only `FOR UPDATE` did *not* fail it, because the preceding `INSERT … ON CONFLICT` on the
    version row also waits for an in-progress bump.
  - Correctness does not rest on the lock alone. The version is read before the inputs and published
    as read, so without the lock the user ends stale, not falsely fresh.
- **c14** deadlocks (`deadlock detected`) when a derived table has a foreign key to `transactions`,
  which proves the no-FK design is required. The first version of c14 did not detect this. It was
  rewritten to the RPC shape: L2 is taken through an input write, and the evaluation comes after the
  deleter locks its row.
- **a09** fails when the bump's vanishing-user guard is removed.
- **c13 and c15 were not mutation-checked.** Their assertions are outcome checks: stale-not-fresh, and
  fresh states equal a re-evaluation.

**Not tested or not done:**
- *(Superseded by §8.1: the real-CLI replay tier now passes locally, and 16b runs 50 coordinated
  rounds.)*
- The equivalence run uses one `as_of`.
- Frontend checks were not run, because nothing in the frontend changed.
- **Not implemented** (as scoped):
  - decision-writing RPCs;
  - the sync-batch and LIM-removal integration, including evaluating inside those RPCs and converting
    pairs to `destination_removed_card` (test 18);
  - the aggregation read protocol and `updating` result (tests 16 and 25);
  - aggregation integration, so the `it.fails` tests stay failing;
  - the API and frontend;
  - backfill evaluation of existing users;
  - a preflight/postflight file for any real application.
- **CI:** *(superseded by §8.1: the equivalence harness is now a CI step.)*

**Implementation choices needing review.** These are provisional: engineering choices, not approved
product rules.
1. **Two derived outputs beyond the design's table list:** `card_payment_decision_states` and
   `card_payment_eval_versions.superseded_transaction_ids`. They let the reader return the engine's full
   output (decision statuses, superseded rows).
2. **A write-time ownership trigger** on decisions, `card_payment_decisions_same_user`, implementing
   §3.5's "every row's accounts belong to that user". The evaluator still reports `foreign_account` /
   `foreign_user` if an account later moves to another user (a10).
3. **Superset triggers:** besides the §3.7 list, they fire on `plaid_items.user_id` changes and on
   carry-over `account_id` / `pending_plaid_transaction_id` / `user_id` changes. An extra bump only
   makes a user stale, which is the safe direction.
4. **The bump grant:** `card_payment_bump` is executable by `service_role`, because
   SECURITY INVOKER triggers call it as the writer. It can only make a user stale.
5. **User deletion:** the bump tolerates a user deleted mid-cascade. The pre-existing
   `plaid_items.user_id` foreign key does not cascade, so a user with items still cannot be deleted —
   unchanged behaviour.
6. **Evaluation time:** `evaluate_card_payments(user, p_as_of default now())` takes an explicit time.
   Carry-over expiry passing without an input change can make a stored reason's *wording* out of date
   (`waiting_to_post` vs `partner_gone`) until the next evaluation. Effects and bounds never depend on
   time (the Stage 2 asOf-invariance test).
7. **Temporary tables:** the evaluator uses session temp tables (`on commit drop`), which requires
   `TEMPORARY` privilege for `service_role`. It holds in the Supabase image tested; confirm for the
   hosted project before any real application.
8. **`superseded_by` has no foreign key**, so deleting a superseding decision can never reactivate the
   old one.
9. **Trigger cost** (still unmeasured; the evaluator itself is measured in §8.1): the triggers are
   row-level, one version-row update per changed input row, so a
   large sync batch updates the version row once per row. Measure this in slice 2b.
10. **The exception condition's sign test:** `sign(new cents) = sign(recorded cents)`, matching the
    engine.

**Before any application beyond a test container:**
- Trevor's explicit approval;
- the usual preflight/postflight file;
- a decision on the choices above;
- Codex review of this slice.

The migration is additive, and its rollback is listed in its header.

### 8.1 Follow-up pass (2026-09-30): CI, 16b ×50, bounded waits, evaluator performance

Same local branch `feature/phase-b-slice2a-sql-evaluator` at `80c724d`. Still uncommitted and unpushed.
The approved financial rules are unchanged: the SQL/TypeScript equivalence is identical before and
after this pass.

**1. CI.** `.github/workflows/ci.yml`, job `database-harness`, has a new step, **card-payment evaluator
equivalence**. It runs `bash supabase/tests/card_payment_evaluator/run.sh` with
`PG_IMAGE=${{ env.SUPABASE_TEST_PG_IMAGE }}` (the pinned Docker Hub mirror digest), `if: !cancelled()` and
`timeout-minutes: 20`. Any difference, or any rule path left unreached, exits 1. Verified locally: with
the suggestion horizon mutated 60→61, `run.sh` exited **1** (4 evaluations differ). *(Since run in CI and
passed on `bb4e2d1` with the mirror digest — see §8.3.)*

**2. Acceptance test 16b ×50, with explicit coordination.**
- **New helpers** in `supabase/tests/access_control/helpers.sql`:
  - `th.wait_for_application(name, timeout)` — a session announces a phase in `application_name`, and
    the other polls `pg_stat_activity`, clearing the stats snapshot on every poll;
  - `th.wait_until_blocked_by(pid, blocker, timeout)` — uses `pg_blocking_pids`;
  - `th.session_snapshot()`.

  All have a 30 s default bound and raise **COORDINATION TIMEOUT** with a session snapshot. The
  existing helpers are unchanged.
- **c12, c13 and c15** now establish their overlap with these barriers, not sleeps or sub-second timing:
  - the session holding L2 commits (or proceeds) only after it has *observed* the other session
    blocked by it;
  - the timing assertions were replaced by that observation;
  - the stale-state, published-version and exactly-one-deadlock assertions are unchanged.
- **c14** is now **50 coordinated rounds**: two procedures, one commit per round.
  - In each round the deleter takes its row lock and blocks on L2. The holder observes that, then
    evaluates.
  - From round 2 on, the holder asserts that the previous round's delete left the user stale. The
    verify step checks the last round and that all 50 deletes committed.
  - Sessions poll as `postgres` and switch to `service_role` (`set_config('role', …)`) for the writes
    and evaluations.
- **Mutation re-checks on the rewritten tests** (restored by sha256):
  - derived-table FK → round 1 `deadlock detected` (then a bounded COORDINATION TIMEOUT, not a hang);
  - no L2 at all → c12 fails "the published version includes the writer's bump".

**3. Bounded waits.** `access_control/run.sh`, `card_payment_evaluator/run.sh` and
`card_payment_audit/run.sh`:
- **Startup:** `STARTUP_TIMEOUT` (default 180 s) bounds startup, and each readiness probe has a 10 s
  limit.
- **psql runs:** `PSQL_TIMEOUT` (default 600 s) bounds every psql run (migrations, seeds, tests,
  holder, contender, verify, evaluation). A timeout prints `TIMEOUT: exceeded …` into the log.
- **Failure paths, demonstrated locally:**
  - `STARTUP_TIMEOUT=1` → exit 1, "did not accept connections within 1s", plus the last container log
    lines;
  - container killed during startup → exit 1, "the database container stopped during startup", plus
    logs;
  - container killed just after startup → exit 1 at the first migration;
  - `timeout 3 docker exec … pg_sleep(30)` → exit 124 after 3 s.
- Phase A and replay runners were not changed.

**4. Evaluator performance.** Measured with `supabase/tests/card_payment_evaluator/perf.sql`: one user,
8 accounts, 2 % card legs, pending → posted lineage on a third of all rows, conflicting groups,
carry-overs and 60 decisions. It ran in a throwaway container as `supabase_admin`.
- **The bottleneck** (`auto_explain`, nested statements): at 10 000 rows the correlated
  conflict-group count took 1 596 of 1 919 ms. After fixing it, tier 1's correlated "closest" step
  took 4 221 of 8 787 ms at 50 000 rows, and the per-leg candidate queries each scanned every row.
- **Fixes, no rule changes:**
  - superseded rows and conflict groups are computed once with `DISTINCT` / `GROUP BY … HAVING
    count(*) > 1`, over **every** row (non-card rows are kept for lineage and role-change handling);
  - indexes on the temp table: `(account_id, pending_of)` and `(account_id, plaid)`, plus `ANALYZE`
    after loading;
  - `in_pool` is set only on qualifying legs;
  - the pool is materialised in a small temp table, `cpe_pool`, used by tier 1 and the candidates;
  - tier 1's closest candidate uses window functions, the same reciprocal rule the audit SQL uses.

| Transactions | before | after |
|---|---|---|
| 2 000 | 121.6 ms | 48.8 ms |
| 5 000 | 533.4 ms | 89.6 ms |
| 10 000 | 1 947.3 ms | 144.2 ms |
| 20 000 | (not run; quadratic, ~8 s projected) | 298.8 ms |
| 50 000 | 8 419.1 ms (after the first fix only) | 713.6 ms |

- **Temp-table overhead:** about 25 ms for the first evaluation of a 20-row history in a new session.
  In one transaction, the first evaluation took 13.5 ms and a second 7.2 ms (tables already present;
  truncate path). So recreating the temp tables costs about 6 ms per evaluating transaction. They are
  kept.
- **Equivalence after the rewrite:** 662 evaluations, **0 differences**.

**Tests actually run in this pass** (final tree, local Docker, disposable containers only):

| Command | Result |
|---|---|
| `bash supabase/tests/access_control/run.sh` | **25 passed, 0 failed** (c12–c15 coordinated; c14 = 50 rounds) |
| `bash supabase/tests/card_payment_evaluator/run.sh` | **662 evaluations, 0 differ**, 59 shapes; PASS |
| `bash supabase/tests/card_payment_audit/run.sh` | PASS |
| `bash supabase/tests/phase_a/run.sh` | scaffold **23 passed** |
| `PHASE_A_BASE=history bash supabase/tests/phase_a/run.sh` | **18 passed, 7 skipped** (the designed gate skips) |
| `SUPABASE_CLI=<cached supabase@2.117.0 binary> bash supabase/tests/replay/run.sh` | **11 passed, 0 failed**: R1–R5 and **real CLI C0–C5** (`db push` clean / again / production state, schema equality, `db reset`) |
| backend `npm run typecheck` / `npx vitest run` / `npm run build` | pass / **1266 passed, 3 expected fail, 10 todo** / pass |
| `git diff --check` and a whitespace scan of the untracked files | clean |
| runtime-importer search | none |

**How the real-CLI replay was run.** The pinned CLI 2.117.0 was already in the local npx cache from
earlier sessions, and was invoked directly
(`…/npm-cache/_npx/6f1b058a4d9555af/node_modules/.bin/supabase`). No new software was installed. The
replay's scratch project pins the local database image to `17.6.1.155`, which was already present, and
no image pull appeared in the output. CI uses `supabase/setup-cli` with 2.117.0.

**Awaiting CI** (not run by me): *(superseded — CI ran on `bb4e2d1` and every job passed, including the
equivalence step on the Docker Hub mirror digest; see §8.3.)*

**Remaining limitations:**
- **Waits:** the concurrency barriers poll every 10 ms, up to 30 s. The harness's own fixed `sleep 1`
  between holder and contender remains for the older tests; the new tests don't depend on it.
- **16b vs 16c:** 16b's 50 rounds run as one test. 16c's deadlock is established by the barrier, and
  PostgreSQL's detector (`deadlock_timeout`, 1 s by default) picks which side aborts; the test accepts
  either.
- **Trigger cost** for large sync batches is still unmeasured (choice 9).
- **One `as_of`** in the equivalence run.
- **Scope:** everything listed as not implemented above is unchanged. The applied migration is still
  applied only in throwaway containers.

### 8.2 Review fix (2026-09-30): the migration loop is bounded too

**The finding:** in `supabase/tests/access_control/run.sh` the migration loop called `docker exec` directly,
bypassing `bounded`, so a stalled migration could hang the run.

**The fix:** the one line now reads
`if ! bounded docker exec -i "$CONTAINER" psql -X -q -1 -v ON_ERROR_STOP=1 -U postgres -d postgres < "$f" >>"$LOGS/history.log" 2>&1; then`.
- The flags, the `history.log` logging and the failure branch (`FAILED to apply migration …` plus
  `tail -20`) are unchanged.
- The `TIMEOUT` line goes to stderr, so it lands in `history.log` and is printed by that tail.
- Every `docker exec` in the runner is now bounded: the two psql wrappers and the migration loop
  through `bounded`, and the readiness probe through its own `timeout 10`.

**Verified** (actual results; disposable local containers only):

| Check | Result |
|---|---|
| Stalled migration — a scratch copy of the runner, the repository's migrations plus `29991231000000_deliberate_stall.sql` (`select pg_sleep(600)`), `PSQL_TIMEOUT=20` | **exit 1** after 49 s, `FAILED to apply migration 29991231000000_deliberate_stall.sql:`, `TIMEOUT: exceeded 20s (PSQL_TIMEOUT)`, no leftover container; the repository was untouched |
| `bash -n` on access_control, card_payment_evaluator and card_payment_audit `run.sh` | all OK |
| `bash supabase/tests/access_control/run.sh` | **25 passed, 0 failed** |

No financial logic, migration or evaluator code changed in this fix.

### 8.3 GitHub checks and self-review follow-up (2026-10-01)

**CI on `bb4e2d1`** (draft PR #9, workflow run 36812561998; read through the public GitHub API) — every
check succeeded:
- `build-and-test`: every step, backend and frontend;
- `database-harness`: Phase A scaffold and history, access_control, and the new **card-payment
  evaluator equivalence** step, on the Docker Hub mirror digest;
- `migration-replay`: emulator, CLI `db push` and CLI `db reset`, with `supabase/setup-cli` 2.117.0;
- Vercel Preview Comments.

The only annotation was GitHub's notice that the `ubuntu-latest` label will migrate to Ubuntu 26 on
2026-10-19. The step **logs** need sign-in or admin rights, so the counts inside the CI logs (for
example "662 evaluations") were not read; step outcomes were.

**Self-review of `80c724d..bb4e2d1`** (my own pass, not an independent review). It found two defects,
fixed in this commit:
1. **`try_evaluate_card_payments` could abort its caller.** After a failed evaluation it wrote
   `last_error_code` into `card_payment_eval_versions` outside any exception block. That table has a
   foreign key to `auth.users`, so for a user with no `auth.users` row (or one being deleted) the
   wrapper raised and aborted the caller's transaction — contrary to its documented contract (§3.7,
   §8: a failed evaluation never blocks the write).
   - **Fix:** the bookkeeping now runs in its own subtransaction and is best-effort. If it cannot be
     recorded the user simply stays stale.
   - **Regression test** (written first, and confirmed failing with the foreign-key error before the
     fix): the end of `a10_card_payment_evaluator.sql`. A write followed by `try_evaluate` for an
     unknown user must return false, the write must commit, and no version row may be invented.
   - The evaluation logic and the financial rules are unchanged.
2. **The runners' undeclared dependency on GNU `timeout`** (added by the bounded waits in §8.1). Where
   it is missing (for example macOS without coreutils), every bounded call failed with "command not
   found" instead of a clear message.
   - **Fix:** the `Requires:` headers of the access_control, card_payment_evaluator and
     card_payment_audit `run.sh` now name it, and each runner fails fast with
     `FAILED: GNU timeout (coreutils) is required to bound database waits`.
   - The check line was run with `PATH` lacking `timeout` (exit 1, that message) and with it present
     (continues).
3. **Documentation:** the §8.1 statements "not yet run in CI" and "awaiting CI" are marked superseded.

**Tests run on the final tree** (disposable local containers only):

| Command | Result |
|---|---|
| `bash supabase/tests/access_control/run.sh` | **25 passed, 0 failed** (a10 includes the new regression) |
| `bash supabase/tests/card_payment_evaluator/run.sh` | **662 evaluations, 0 differ**, 59 shapes; PASS |
| `bash supabase/tests/card_payment_audit/run.sh` | PASS |
| `bash supabase/tests/phase_a/run.sh` / `PHASE_A_BASE=history …` | **23 passed** / **18 passed, 7 skipped** (the designed gate skips) |
| `SUPABASE_CLI=<cached supabase@2.117.0> bash supabase/tests/replay/run.sh` | **11 passed, 0 failed** (R1–R5, CLI C0–C5); no image pull |
| `bash -n` on the three runners | OK |
| backend typecheck / `vitest run` / build | pass / **1266 passed, 3 expected fail, 10 todo** / pass (backend unchanged) |

**Remaining gaps:**
- the CI step logs could not be read without sign-in;
- trigger cost on large sync batches is unmeasured;
- the equivalence run uses one `as_of`;
- the provisional implementation choices of §8 still need a decision;
- everything listed as not implemented is unchanged.

**Needs independent (Codex) review before release:**
- the migration as a whole — security properties, the input-trigger coverage, the lock order and
  publication rule (§3.7), and the ten provisional choices of §8;
- the SQL evaluator's equivalence approach and its coverage guard;
- the performance rewrite of §8.1;
- the concurrency tests' coordination design;
- this pass's `try_evaluate` change;
- the preflight/postflight plan that applying the migration to any real database would require.

## 9. Slice 2b-1 — card-payment decision RPCs (2026-10-01; disconnected)

**Branch and base:**
- Worktree `C:\Users\Trevor\dev\my-finances-phase-b-2b`, branch `feature/phase-b-slice2b-decision-rpcs`.
- Incremental base: `afa29ee` (draft PR #9's head). The slice is two commits on top of it:
  - `f77fb4c` — docs-only status reconciliation;
  - the implementation commit that carries this section.
- Its draft PR targets `main` (CI runs only for PRs into `main`), so the PR's full diff also contains
  PR #8 and PR #9.
- Nothing is merged. The migration has been applied only to throwaway test containers.

**What it adds** — migration `20261001120000_card_payment_decision_rpcs.sql`, additive. It leaves
`20260930120000` unchanged and creates no table.

The four RPCs:

| RPC | User action | Writes |
|---|---|---|
| `link_card_payment(user, transaction, counterpart, accepted_difference_cents, expected_version)` | Match · Match return · Match with difference · Choose the matching card transaction | `pair` (a = cash leg, b = card leg) |
| `mark_card_payment_destination(user, transaction, expected_version)` | It went to a card I haven't linked | `destination_unlinked` |
| `dismiss_card_payment_candidate(user, transaction, candidate, expected_version)` | Not this one | `not_this_pair` (a = the leg being resolved, b = the candidate) |
| `undo_card_payment_decision(user, decision, expected_version)` | Undo | `superseded_by` := its own id |

Seven helpers:
- `card_payment_decision_begin` — READ COMMITTED, L1, L2 and the version check;
- `card_payment_decision_target` — ownership plus the evaluator's leg facts;
- `card_payment_decision_check_leg`;
- `card_payment_lineage_row` — the evaluator's §3.6 lineage rule;
- `card_payment_live_decisions`;
- `card_payment_decision_rows`;
- `card_payment_decision_result` — evaluation and the response.

All are SECURITY INVOKER with `search_path` pinned empty, service_role only, with postconditions. The
column comment on `card_payment_decisions.superseded_by` records the undo convention.

**Decisions inherited** (Trevor, 2026-10-01), implemented as specified:
1. **The version check is per user.** The expected version must equal both `input_version` and
   `evaluated_version`. It is checked under L1 then L2. NULL, missing, stale or unevaluated versions are
   refused, and the server's version is never substituted. Inputs are re-read under the locks.
2. **Validation happens at write time.** It covers ownership; eligible current lineages (no choice
   between conflicting replacements, no superseded pending row); opposite sides; direction; and the exact
   explicit difference. Manual matching has no 60-day or $5 limit. A destination can be confirmed only
   on a cash-side leg, and `destination_removed_card` cannot be created. Unknown and foreign targets get
   the identical refusal, before any target-specific detail.
3. **Replacement is scoped:**
   - whole decisions are replaced;
   - a counterpart held by another affirmative decision (active or inactive) is refused;
   - dismissals are edge-specific and coexist; a dismissal supersedes nothing;
   - a confirmation of a dismissed pair supersedes exactly that dismissal;
   - overlap is found by lineage resolution, through pending and posted aliases;
   - existing `superseded_by` pointers are never overwritten.
4. **Undo:**
   - `superseded_by` = its own id;
   - ownership-scoped, with no leg checks;
   - never reactivates an older decision or moves a replacement pointer;
   - an older, replaced id is refused (`card_payment_decision_replaced`);
   - a repeated undo returns `unchanged/already_undone` with the current version, or the standard
     stale refusal with a stale version.
5. **Evaluation:**
   - the whole user is evaluated in `try_evaluate_card_payments`;
   - a caught failure returns `saved` with `matching: 'pending'`, and no legs or figures;
   - a failure or rollback of the outer transaction is not a save.

**Decisions made while implementing** (provisional; for review):
1. **The client names targets by transaction id**, from `get_card_payment_states`. Each id is resolved
   under the locks. The stored lineage key is the row's own Plaid id: the pending id while it is pending,
   the posted id after.
2. **A dismissal also requires opposite sides and opposite directions.** Any other leg can never be a
   candidate.
3. **Dismissing the exact edge of a saved pair is refused** (`card_payment_pair_confirmed`: undo the
   match first), rather than stored next to it.
4. **Undo refuses `destination_removed_card`** (`system_decision`). It is system-written by an
   institution removal, and §6.1 offers no user action for it. *(Product question.)*
5. **A user decision never supersedes a `destination_removed_card` decision.** The user decision ranks
   above it in the evaluator, and the system record stays as dormant history (§4.7).
6. **A user may undo their own decision after one of its accounts moved to another user.** The evaluator
   already rejects such a decision as `foreign_account`. The response names only the user's own rows.
   *(Product question.)*
7. **Identical requests are explicit no-ops with nothing written.** Status is `unchanged`, with
   `already_confirmed` or `already_dismissed`. "Identical" means the same resolved legs, the same recorded
   cents and the same accepted difference. A changed amount is therefore a real replacement.
8. **A destination confirmation is allowed on a cash leg of an excluded account.** It is harmless: such a
   leg never counts.
9. **The RPCs take no `as_of`.** Their evaluation uses `now()`. Tests compare at a fixed time by
   re-evaluating.
10. **Refusals raise prefixed messages**, the house convention for RPC refusals. No-ops return a status.

**Response contract** (migration header):

`{status, reason, decisionId, supersededDecisionIds, matching, inputVersion, evaluatedVersion, legs | lastErrorCode}`

`legs` holds the fresh states of the named transactions and of the legs of the decisions the call
superseded. It is **not** the complete set of changes: a decision can dissolve a tier 1 pair or free a
candidate elsewhere. Callers holding other states must refresh them through `get_card_payment_states`
and compare `evaluatedVersion`.

**Locking** (corrected after self-review): the order is L1 → L2.
- The RPCs take no row lock on `transactions`.
- The decision INSERT's foreign-key checks take KEY SHARE on the referenced `accounts` and `auth.users`
  rows. Superseding updates lock the decision rows they change.
- So a **lock-free** writer that deletes one of those accounts (or the user) during an RPC can close a
  cycle with L2. PostgreSQL detects it and one side rolls back completely: the §3.7 lock-free-writer
  class. c22 establishes this cycle deterministically and verifies it.
- Writers that take L1 (the sync batch, LIM removal) are serialized instead (c17, c18).

**Tests added:**
- `a11_card_payment_decision_rpcs.sql` — single session; each call is its own transaction, and outcomes
  are re-read from new transactions after commit:
  - version gating: before evaluation, NULL, ±1, stale after a direct write, unevaluated latest version;
    and the cases that do *not* refuse: an empty sync batch and a non-input column edit;
  - the response and the durable lineage-keyed row;
  - unknown vs foreign subject, counterpart, destination, dismissal and undo, all identical;
  - every validation refusal, with nothing written;
  - manual matches 111 days apart and $9.00 different;
  - replacement rules A–F, including pending → posted aliases on both the subject and counterpart side;
  - no-ops, and correcting an invalidated confirmation;
  - undo: waiting, role changed, repeated, stale repeat, older replaced id, undo of a replacement,
    a dismissal, a system decision;
  - the injected evaluator failure, then recovery;
  - outer rollback and REPEATABLE READ;
  - a colliding pending id on another user's account;
  - undo after an account moved.
- `a12_card_payment_decision_grants.sql` — the catalog plus runtime denial for `authenticated` and
  `anon`.
- Concurrency — real sessions, with barriers on `pg_blocking_pids`:
  - c16: two confirmations with the same version;
  - c17 and c18: sync then link, and link then sync;
  - c19 and c20: link then lock-free writer, and writer then link;
  - c21: the lock order (the RPC holds no L2 while it waits on L1);
  - c22: the KEY SHARE cycle with a lock-free account delete.
- `card_payment_evaluator/rpc_sequences.sql` + `compare_rpc.cjs` — 8 RPC-driven sequences (Q1–Q8). The
  reference evaluator, run on exactly the decisions the RPCs wrote, must equal the SQL states, plus
  per-sequence expected step outcomes, leg states and live-decision counts. It runs inside the existing
  CI equivalence step.

**Tests run on the final tree** (disposable local containers only; no hosted database):

| Command | Result |
|---|---|
| `bash supabase/tests/access_control/run.sh` | **34 passed, 0 failed** (the 25 earlier tests plus a11, a12 and c16–c22) |
| `bash supabase/tests/card_payment_evaluator/run.sh` | **662 evaluations, 0 differ**, 59 shapes; **RPC sequences: 8 scenarios, 16 user evaluations, 0 failures** |
| `bash supabase/tests/card_payment_audit/run.sh` | PASS |
| `bash supabase/tests/phase_a/run.sh` / `PHASE_A_BASE=history …` | **23 passed** / **18 passed, 7 skipped** (the designed gate skips) |
| `SUPABASE_CLI=<cached supabase@2.117.0> bash supabase/tests/replay/run.sh` | **11 passed, 0 failed** (R1–R5, CLI C0–C5); nothing downloaded |
| backend `tsc --noEmit` / `vitest run` (CI placeholder env) / `npm run build` | pass / **1266 passed, 3 expected fail, 5 todo** / pass |
| `git diff --check` | clean |

**Mutation checks** — each safeguard was removed in turn, the listed tests were run, and the
migration's sha256 was verified afterwards:

| Removed safeguard | Detected by |
|---|---|
| M1 the version check | a11 ("expected … stale_version … but the statement succeeded"), c16, c17, c20. c20 fails through the authoritative re-read: the writer's −98 makes the 0 difference invalid (`difference_not_accepted`) |
| M2 L1 in the RPC preamble | **c21 only**. c16–c18 still pass, because L2 alone serializes those interleavings; L1's role is the lock order, which c21 measures |
| M3 target ownership | a11 ("a foreign counterpart and an unknown one give the same message") |
| M3b undo ownership | a11 ("undoing another user's decision looks exactly like undoing an unknown one") |
| M4 counterpart reservation | a11; equivalence Q5 |
| M5 the conflicting-replacement check | a11 ("… lineage_ambiguous … but the statement succeeded"). The test was strengthened in this pass: it first refused for another reason |
| M6 pending-id aliases in lineage resolution | a11 ("naming the posted row replaces the match saved under the pending id"); equivalence Q2 |
| M7 undo's replaced guard | a11 (the refusal becomes `stale_version`; the update's `superseded_by is null` predicate still protects the pointer) |
| M7b the guard and that predicate | a11 (an older id is undone); equivalence Q1 |
| M8 exact-edge dismissal supersession | a11 ("the other dismissal is preserved"); equivalence Q3 |
| M9 evaluation isolation (`try_evaluate` → `evaluate`) | a11 (the injected failure aborts the call) |
| M10 the refusal to dismiss a saved pair | a11; equivalence Q3 |

**The `superseded_by is null` predicate in link and mark is defense in depth.** Under the locks it is
unreachable, because only live decisions are ever selected, so no test can detect its removal there.
For undo it is exercised by M7b.

**Self-review** (Claude, a fresh-context read-only pass; **not** independent cross-family review). It
found no rule violation. Its findings and their dispositions:
1. **The header said "no data-row lock".** That was wrong, because of the foreign-key KEY SHARE locks.
   Corrected in the header and c19, and c22 added.
2. **Live decisions were resolved up to 6 times per call.** Now once per RPC, plus targeted lookups. The
   review's "no index" premise was wrong: `transactions_pending_transaction_id_idx` (continuity) and the
   unique Plaid id cover the lookups. The cost is still linear in the user's live decisions, and nothing
   purges dismissals yet.
3. **Documentation:** the stale "only migration" and CAS wording were fixed, and this §9 now exists.
4. **Product choices:** flagged as decisions 4 and 6 above. Undo's response is now scoped to the user's
   own rows.
5. **Tests:**
   - removed a seed row that formed an unintended tier 1 pair;
   - `leg()` now fails on missing or stale states instead of reading NULL;
   - `like` checks were added to the equality refusals;
   - added the foreign-subject, colliding-pending-id and moved-account undo cases;
   - fixed comment mismatches.

**Limitations and TODOs:**
- **Disconnected:** no backend function, route or frontend calls these RPCs.
- **The sync batch does not evaluate yet (slice 2b-2).** After any sync a user is stale, and every RPC
  refuses until a standalone evaluation runs.
- **There is no constraint against conflicting affirmative decisions written by arbitrary service_role
  SQL.** The RPCs prevent them on their own path, and the evaluator keeps treating external conflicts
  conservatively.
- **A conflicting replacement cannot be resolved through these RPCs** (it is refused). The persistent
  review path recorded in the design is still unbuilt.
- **Not tested:** concurrency with the role-override, account-inclusion and LIM-removal writers. They are
  not built, or not integrated yet.
- **Still unmeasured:** trigger cost on large syncs (from 2a), and RPC cost for users with many live
  decisions. There is no purge of decision history (design §3.5's 30-day purge).
- **Not run:** frontend checks (nothing in the frontend changed), and CI step logs (they need sign-in).

**Needs independent review** before any release decision:
- the four RPCs against the approved rules;
- the lock analysis, including the KEY SHARE cycle;
- the version check;
- implementation decisions 1–10, especially the product questions 4 and 6;
- test validity, including the mutation evidence;
- the RPC-sequence comparison.

**Recommended next slice — 2b-2: sync and LIM-removal integration** (not started):
- evaluate inside the sync batch (`apply_synced_transaction_batch_v2`, or a v3 for coexistence with an
  old backend) and in `remove_plaid_item_local`;
- convert pairs touching a removed card into `destination_removed_card` **before** the deletes (§4.7,
  acceptance test 18);
- measure trigger and evaluation cost on large batches.

Without it, the RPCs refuse after every sync, so it unblocks real use. The alternative is 2c (the
aggregation read protocol and `updating`), which can proceed in parallel at the TypeScript level.

**Confirmation:** no hosted migration, merge, backfill, production data change, production
configuration change or deployment.
