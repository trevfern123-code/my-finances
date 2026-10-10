# Phase B integration slice I3A: institution removal and card-payment matching

**Status (2026-10-07): implementation candidate, revision 5, after its first independent review and four correction passes. Uncommitted, unpushed, not released.** Nothing here was run against a hosted database, and no production setting changed. The fourth pass corrects two findings of an independent audit of revision 4 (P1, P2) and implements one further decision (§9.1, decision 14). It replaces both candidate migration files in place (§7). **A self-review of that pass found one point that needs a decision: what a hold does after the removed institution is linked again (§9.3, question 7). It is recorded and not corrected.** Its other findings — weak tests, wrong sentences, the rollback guard — are corrected; no function body changed in that.

- Branch `feature/phase-b-i3a-lim-removal-matching`, created from `938517b2ebbcc26d0afa0a3640a74c63443a2505` (draft PR #15's head).
- Two migrations, each with a rollback script:
  - `20261006110000` — three new decision kinds (one user kind, two system kinds), two new columns, the evaluator and three decision RPCs taught to read them. Behaviour-neutral by itself.
  - `20261006120000` — the body of `remove_plaid_item_local`.
- No backend logic, API, frontend, dependency or workflow change. The TypeScript reference evaluator (test-only, not wired into anything) learned the new kinds and, in revision 5, the order of §3.1; two backend comments were updated.
- Authoritative design: `CARD_PAYMENT_PAIRING_DESIGN.md` rev 3 — §3.2, §3.4–§3.7, §4.7 (T9), §4.8, acceptance tests 18, 20, 21, 22 — as amended by Trevor's decisions of 2026-10-06, which that document now records.
- **Since (2026-10-08, I3A-R packet 1 — an implementation candidate awaiting independent review, nothing merged or released; `PHASE_B_I3A_R_P1_REMOVAL_PROVENANCE.md`):** a later migration, `20261008120000`, replaces the removal body again. Where a statement of this document does not hold with that migration applied, it is amended where it stands and marked "amended 2026-10-08, I3A-R packet 1". §11 and §12 report revision 5 as it was measured and run.
- **Policy amendment (2026-10-09, I3A-R; recorded following the independent audit of I3A-R packet 1).** The policy had already been approved before that audit and was supplied in the original audit request. This amendment records that existing approval; it does not create a new one. 2026-10-09 is the date of this amendment, not of the approval. It governs what this document recorded as unresolved about a removed institution that is linked again (§9.3, question 7), and anything in this document that conflicts with it. **P-Y:** permanent release of a historical matching protection requires explicit user authorization, scoped to the relevant source or dependencies. **P-D:** retirement of removed-destination evidence requires separately identifiable authorization. P-Y does not implicitly authorize P-D. A single, clearly explained review workflow may collect both permissions, but their meanings and the recorded authorization stay distinct. Reliable account/event correspondence is evidence, not consent. Similar institution, mask, amount and date—even an exact descriptive match—do not establish reliable correspondence by themselves. Before production activation, a narrowly scoped review safeguard for affected relinked-transaction matching and a reachable user-assisted recovery workflow are required. I3A-R packet 1 implements provenance capture only: no settlement, no user recovery, no review safeguard, no production activation. Current implementation examples include system ambiguity holds for P-Y and `destination_removed_card` records for P-D. These are nonexclusive examples, not definitions limiting policy scope. P-Y requires explicit authorization for permanent release of the named historical matching protections and their source dependencies. P-D requires separately identifiable authorization to retire removed-destination evidence. Neither permission grants the other. User-confirmed decisions and reservations retain their separate precedence and undo/supersession rules. *Historical:* this document recorded the question as unresolved, and question 7 is kept as it was written. *Superseded where it conflicts:* any route by which a historical matching protection is permanently released, or removed-destination evidence retired, without the user's authorization, including the automatic "exact return" route of the I3A-R roadmap. The places this touches are marked "amended 2026-10-09, I3A-R policy".
- **Since (2026-10-09, I3A-R packet 2-A — a local implementation candidate awaiting independent review, nothing committed, merged or released; `PHASE_B_I3A_R_PACKET_2A_REVIEW.md`):** a later migration, `20261009120000`, replaces the evaluator, the removal body and the state reader. It implements the review safeguard and the user-assisted recovery workflow that the policy amendment above requires, on Trevor's approval of 2026-10-09. A surviving payment that had an eligible candidate on the removed institution is an affected payment — read from the evaluator's complete pool before the delete, whether or not the removal wrote a hold or a record about it — and so is the surviving leg of a preserved user confirmation; an automatic pair of an affected leg with a transaction that the removal did not know as a surviving candidate — a new transaction, the re-imported leg of a relinked card — is withheld in both directions, and the leg reads `unresolved / relink_review_required` (a range for an included cash leg where an included card exists) until the user decides that payment. No hold is ended, no record is retired, and P-Y and P-D are not implemented. Where a statement of this document does not hold with that migration applied, it is amended where it stands and marked "amended 2026-10-09, I3A-R packet 2-A". The test tables of §8 and the results of §11 and §12 are revision 5's; the cases whose stated requirement changes are listed in that document, §14, and their test files were updated in the correction pass of the same date (the tables of §8 here still state revision 5's requirements).

**Where the review's findings stand:**

| Review finding | Trevor's decision | State |
|---|---|---|
| I3A-1: both evaluations were strict | The evaluation before the delete is strict. The evaluation after it is best-effort | Implemented and tested (§2, §4) |
| I3A-2: a user confirmation was discarded, or downgraded, and its reservation released | A user-confirmed pair survives as a **user-strength** decision — active or inactive, on either side. Additive schema authorized | Implemented and tested (§3, §8). The contract test written before it existed now passes |
| I3A-3: the version lock is taken earlier | Lock the removed institution's account rows first | Implemented and tested (§4): no new deadlock |
| The §9 boundary: a tie that the removal breaks | A removal must not resolve a pre-existing ambiguity. A **system** ambiguity hold preserves it; new evidence or the user resolves it | Implemented and tested (§3.4, §8) |
| Audit P1: excluded accounts bypassed the ambiguity hold. Revision 4 wrote it only for a leg *published* unresolved, from its displayed candidates | No new decision. The rule of the row above is about the matching evidence, not about what a reader is shown | Implemented and tested (§3.4, §8): the holds are derived from the evaluator's complete pool |
| Audit P2: a surviving amount change masked a frozen invalidity of the removed side and, with no included card, published an effect | No new decision. The approved "no included card" exception is for an amount change only | Implemented and tested (§3.1, §3.2, §8): a frozen disqualifier is read first, in the SQL evaluator and in the TypeScript reference |
| What revision 4 left open (its §9.3, item 1): a payment matched **automatically** to a removed card | "Option B" (2026-10-06): it must not switch automatically to another card that was already there, solely because its destination disappeared. Institution removal is not new financial evidence | Implemented and tested (§3.3, §3.4, §8): the system record, and the existing hold on the pair with the card that was already there |
| Self-review of revision 5: after a relink a hold still judges its pair against the removed leg's stored date, so a payment can keep reading `untracked / removed_card` although both cards are linked | **Open, for Trevor's decision** (§9.3, question 7) (amended 2026-10-09, I3A-R policy: the policy that governs it is recorded in the policy amendment under the status above; nothing of it is implemented) | **Not corrected:** every correction needs a new product or architecture decision. Today's reading is recorded in `a25` (OQ7), apart from the contract, and the sentences that denied it are corrected |

## 1. What I3A does

Removing an institution deletes its accounts and transactions. Whatever was known about the payments between that institution and the user's **other** institutions was in those rows.

| | Before I3A | After I3A |
|---|---|---|
| A payment from a kept checking account, matched **automatically** to a removed card | The match is lost. The payment falls back to "unresolved", or to whatever the remaining rows suggest | Recorded as "went to a card that was removed" before the rows are deleted. It counts as money leaving the tracked accounts. The record ranks below any later automatic match |
| A match the **user** confirmed with an account of the removed institution | The confirmation is deleted with the account. The leg that is left is free again — and pairs automatically with any other card or payment that fits | Kept as the user's own decision on the leg that is left. It keeps holding that leg: nothing else can take it automatically. This holds whether the confirmation was active, waiting to post, or invalidated by a bank change |
| A confirmation the user had already undone, replaced, or re-classified | Deleted | Still not carried forward: the newer action stands |
| A payment matched **automatically** to a removed card, where a card that **stays** also had a fitting leg, less close | Matched automatically to that other card, as soon as the removed card's rows were deleted | Not switched. It keeps its recorded destination and still counts as money leaving the tracked accounts. The removal records a system hold on the pair with the card that was already there. New or changed evidence, a relinked card, or the user decide as always |
| A payment with **no automatic match** because a removed card and a kept card both fitted it — whatever a reader is shown for it: unresolved, not counted (an excluded account), or counted by another rule | Matched automatically to the kept card, as soon as the other card's rows were deleted | Stays unmatched, and reads as before. One exception: if the removal took the user's last included card, an included payment that was unresolved reads `untracked / no_included_card` (§3.3). The removal records the ambiguity (a system hold). New or changed evidence, or the user, resolves it |
| Matching states after a removal | Stale until some later evaluation: every card-dependent figure reads "updating" | Normally fresh when the removal commits |
| Matching cannot be evaluated **before** the delete | Not applicable (it never evaluated) | The removal fails as a whole: nothing is deleted, and it can be retried |
| Matching cannot be evaluated **after** the delete | Not applicable | The removal still commits. Matching is stale ("updating") until a later evaluation succeeds |
| The removal's result and stored record | `{ replayed, loan_adjustments, deleted_counts }` | The same, key for key |

## 2. The removal transaction

`remove_plaid_item_local(user, item)` is still one function call, so one transaction. Everything not marked new is unchanged, statement for statement.

1. **As before:** the per-user advisory lock, the removal row, the replay of a finished operation, the `plaid_removed` and `removing` checks, the lock on the item's loan-linked transactions, and both fail-closed loan checks.
2. **New — lock the item's account rows,** in id order, with the lock their delete takes (§4).
3. **New — evaluate, strictly.** `evaluate_card_payments(user)` runs here. The matching states are computed from the rows as they are now. Stored states are never used as found: they may be stale, or may not exist. If this fails, nothing is removed. Its scratch tables — the complete matching pool and its automatic pairs — stay in the transaction for step 4.
4. **New — preserve, before any delete, in three statements.** If any of them fails, nothing is removed. (amended 2026-10-08, I3A-R packet 1: the block first records the removal itself — a generation row, and a marker for each earlier removal of this user that finished without provenance. The three statements then fill a plan of this transaction, each row with the removed transaction it depends on, and the block writes the planned decisions, one provenance row for each, and checks the counts. If any of that fails, nothing is removed.)
   - **User-confirmed pairs.** Every live `pair` decision with one leg on the removed institution and the other on another institution of the same user becomes a `pair_counterpart_removed` decision on the leg that survives (§3).
   - **Automatic pairs.** Every surviving cash leg that step 3 paired by tier 1 with a leg of the removed institution gets the system record `destination_removed_card`. A leg held by a user decision gets none.
   - **Ambiguity holds.** Read from the evaluator's complete pool as step 3 left it, not from the published states. Every surviving leg of the pool whose automatic match is not with a leg that stays — it has none, or it is matched to a leg of the removed institution — and whose tier 1 candidates are on both sides of the removal gets a system ambiguity hold on its pair with each candidate that survives, dated by each candidate that is removed (§3.4).
5. **As before:** exact manual-loan restoration, the deleted counts, the delete of the item (which cascades to its accounts, transactions and the decisions that reference those accounts — the `pair` rows among them), and the removal row becomes `cleaned`.
6. **New — evaluate again, best-effort,** as the last statement (`try_evaluate_card_payments`, a subtransaction). When it succeeds it publishes the states of the rows that are left. When it fails, only it is rolled back (§4).

A replay of a finished operation returns the stored result, as before. It writes nothing and evaluates nothing.

## 3. What is preserved, and how

### 3.1 The user's confirmation: `pair_counterpart_removed`

A **user** decision: the user's `pair`, after the account of one of its two legs was removed.

| Column | Holds |
|---|---|
| `a_account_id`, `a_plaid_transaction_id`, `a_cents` | The **surviving** leg, exactly as the pair recorded it (the Plaid id and cents at decision time). Pending → posted lineage and "the surviving amount changed" work through the existing rules |
| `b_plaid_transaction_id`, `b_cents` | The **removed** leg's reference, as the pair recorded it. History only. `b_account_id` is null: that account is gone, and no foreign key references it (amended 2026-10-08, I3A-R packet 1: beside the decision, the removal now keeps more of that account and of the removed row — §5) |
| `accepted_difference_cents` | The pair's |
| `counterpart_status` — the one new column | What was true of the removed side when its account was deleted. Frozen: that side can never change again |
| `decided_seq`, `created_at` | The pair's: when the user confirmed |

**Why this and not an existing form.** A `pair` cannot outlive its account (foreign key, on delete cascade). `destination_removed_card` is non-reserving by approved design. `destination_unlinked` means something else and — decisive — is valid whenever the surviving leg has its recorded amount, so a confirmation that was invalid because of the *removed* side would become active. The first proposal used three new columns; reusing leg B's reference columns without an account needs only one.

**`counterpart_status`:**

| Value | Meaning | Effect |
|---|---|---|
| `valid` | The removed leg was a card-payment leg at its recorded amount, and the two legs still related as recorded | Invalidates nothing |
| `waiting_to_post` | The removed leg was waiting for its posted row. It can never post now | Invalidates nothing |
| `amount_changed`, `lineage_ambiguous`, `partner_gone`, `role_changed`, `sides_not_opposite`, `direction_mismatch`, `difference_not_accepted`, `conflicting_decisions` | The reason the confirmation was invalid on that side | Keeps the decision inactive until the user undoes or replaces it |

How it is set: `valid` when the removal's own evaluation found the pair active; `conflicting_decisions` when it found it in conflict; otherwise what `card_payment_reference_status` — the evaluator's lineage rule and amount-then-role check, for one leg — says of the removed leg, and, if that leg is valid, whether sides, direction and accepted difference still hold.

**The order in which the evaluator reads it** (revision 5, audit P2; the SQL evaluator and the TypeScript reference, the same rule). After the surviving reference's own lineage — waiting, gone, ambiguous:
1. A frozen status other than `valid`, `waiting_to_post` and `amount_changed` keeps the decision inactive **with that frozen reason, whatever the surviving leg's amount or role is now.** What was wrong with the side that is gone was never resolved, and a later correction of the leg that survived does not resolve it.
2. Then the surviving leg's amount: if it differs, `amount_changed`.
3. Then its role: if it is no longer a card-payment leg, `role_changed`.
4. Then a frozen `amount_changed`: `amount_changed`.
5. Otherwise the decision is active.

Two live user decisions on one leg still make both `conflicting_decisions`, as before. Revision 4 read the surviving leg's amount first, so a frozen `lineage_ambiguous` with a corrected surviving amount read `amount_changed` — the one inactive reason the "no included card" exception of §3.2 accepts.

### 3.2 What each case becomes

| The user's pair, when the account is removed | Preserved? | The surviving leg afterwards |
|---|---|---|
| **Active** | Yes, `valid` | Cash leg: `untracked / removed_card`, −amount. Held by the user's decision; a competing card's leg is only a suggestion |
| Waiting for the **removed** leg to post | Yes, `waiting_to_post` | The same: the surviving leg is current and valid |
| Waiting for the **surviving** leg to post | Yes, `valid` | Nothing to show until it posts. Then it is held and counts, through its lineage. If it posts at another amount: held, unresolved |
| Amount changed on the **removed** leg | Yes, `amount_changed` | Held, **unresolved**. The old amount is not proof |
| Amount changed on the **surviving** leg | Yes, `valid` | Held, **unresolved** (the existing amount check). Active again only if the bank restores the amount |
| Conflicting replacements of the **removed** leg | Yes, `lineage_ambiguous` | Held, unresolved, no effect |
| Conflicting replacements of the **surviving** leg | Yes, `valid` | Both rows unresolved (the existing guard), the decision named on them. Once one is left, it is held by the decision |
| The classifier re-classified a leg; the bank withdrew the removed leg | Yes, `role_changed` / `partner_gone` | Held, unresolved |
| **The mirror case:** the **cash** account is removed, the card leg survives | Yes, the same way | Card leg: `funded_from_excluded / removed_cash_account`, effect 0 — or, if invalid, unresolved, effect 0. Either way it cannot pair with another cash leg |
| The user had **undone** it, or **replaced** it by another decision | **No** | Whatever the newer state says. Nothing of the old confirmation remains |
| The user had **re-classified** one of its legs away from card payment | **No** | The other leg is free again |
| Both legs on the removed institution | No | Both are deleted |

**Passive invalidation against a newer user action.** A bank or classifier change never erases the user's word or its hold. A newer explicit action by the user does: it supersedes the confirmation, which is then neither carried forward nor allowed to keep reserving. The removal recognises three: undo, replacement (both leave the pair superseded), and a `user_role_override` away from card payment on a leg's current row.

**The "no included card" rule** can establish an effect by itself, in one case only. When a preserved decision is inactive because of an **amount change** — the surviving leg's, the removed leg's, or both — in the same direction, on a cash leg of a user who has no included card at all, the payment reads `untracked / no_included_card`. The decision stays inactive: the absence of any card establishes the effect, not the old confirmation. This is the existing exception for `destination_unlinked`, extended to the new kind as decided. Revision 5 did not change it. By the order of §3.1 a frozen status of any other kind is the decision's reason whatever the surviving leg's amount later does, so it never reaches the exception: the payment stays reserved and unresolved, a restored amount does not make the confirmation valid, and only the user releases it (`a24`).

### 3.3 Automatic pairs and everything else

| Case at the moment of removal | Written | State after the removal |
|---|---|---|
| Tier 1 pair with the removed card (also: an excluded card, a return, a pending leg on either side) | System record `destination_removed_card` | `untracked / removed_card`, −amount. Below tier 1, non-reserving, dormant after a relink, not proof once invalid — unchanged |
| The same, where a leg that **stays** was also a tier 1 candidate of the payment: it fitted, less well | The record, **and** an ambiguity hold on the payment's pair with each such leg (§3.4) | The same: `untracked / removed_card`, −amount. The leg that was already there stays unmatched. The record is not promoted: the hold withholds that one pair, and nothing else |
| A leg with **no** automatic match whose tier 1 candidates were on **both** sides of the removal (a tie, or any other ambiguity of the pool) — whatever it is published as | A system **ambiguity hold** for each surviving candidate (§3.4). No record | What it read before the removal: unresolved; `not_counted` on an excluded account; `untracked` where the "no included card" rule or an earlier removal's record decides it. One exception: if the removal took the user's last included card, an included cash leg that was unresolved reads `untracked / no_included_card`. It is not matched to the candidate that is left |
| Any other leg with no match (only a possible match, a tie between kept cards, candidates only on the removed institution, or no candidate) | **Nothing** | Removal is not evidence. The leg is evaluated, like every leg, from the rows that are left |
| Leg under another user decision (confirmed "unlinked card") | Nothing | The user's decision stands, unchanged |
| Pair with a card that stays | Nothing — also where a leg of the removed institution fitted, less well | Unchanged |
| Surviving card leg whose cash leg was paired **automatically** | No record. A hold on its pair with each kept cash leg that also fitted it (the mirror, §3.4); otherwise nothing | Evaluated from what is left: unresolved where a hold withholds the one pair that is left. A credit-side leg's effect is 0 |

### 3.4 A tie the removal would break, or a match it would switch: the system ambiguity hold

**The rules (Trevor, 2026-10-06).** Institution removal is not new financial evidence.
1. If a leg is unresolved before the removal because of a genuine tie or ambiguity between an account being removed and one or more accounts that remain, the removal must not resolve it. Deleting one candidate is not new evidence that another was the true destination.
2. ("Option B".) A payment that was **automatically matched** to a card of the removed institution must not automatically switch to another card that was already there, solely because the original destination disappeared.

One mechanism serves both: the hold. Rule 2 needed no new kind, column or evaluator rule.

**What a hold is.** A system record on **one possible pair**: the two surviving legs that would otherwise be matched.

| Column | Holds |
|---|---|
| `kind` | `ambiguity_hold_removed_card`: a **card** leg was removed, and it competed for the cash leg. `ambiguity_hold_removed_cash_account`: a **cash** leg was removed, and it competed for the card leg (the mirror) |
| `a_account_id`, `a_plaid_transaction_id`, `a_cents` | The **card-side** leg of the possible pair, as it was at the removal |
| `b_account_id`, `b_plaid_transaction_id`, `b_cents` | Its **cash-side** leg. Both accounts exist: these are the ordinary references, and the record goes when either account goes |
| `counterpart_date` — the second new column | The date of the candidate that was removed. Nothing else of it is kept on the hold; no foreign key references it (amended 2026-10-08, I3A-R packet 1: the hold's provenance row keeps more of that candidate — §5) |

**Why this is the smallest form that works.**
- *A record on the pair, not on the leg.* The hold has to stop the **old** candidate from being proven by the deletion, and has to leave a **new** one alone. A record on the leg alone would also stand in the way of the relinked card's re-imported leg.
- *The date.* Whether a later date change breaks the old tie depends on where the removed candidate was. No existing column can hold a date. Without it, a date change could either never release a hold or always release it; both are wrong half the time.
- *Two kinds, not the order of the legs.* The record must say which of the two legs the removed candidate competed for. The order of the legs cannot say it: the card leg is written first on purpose, so that an evaluator that does not know these kinds — after a rollback (§7) — reads the record as an inactive decision holding both legs, not as a confirmed pair, while the card leg's account is a credit account. §7 says what that reading costs now that a hold can stand on a payment with a known figure.
- *Not an existing kind.* `pair_counterpart_removed` is the user's word; `destination_removed_card` is a known destination; `destination_unlinked` is the user's; `not_this_pair` is the user's dismissal and removes the candidate altogether.

**Which legs get one** (statement (c), as implemented). It is read from the evaluator's scratch tables, as the strict evaluation of step 3 left them in the same transaction: `pg_temp.cpe_pool`, `cpe_txn`, `cpe_tier1` (the automatic pairs, less those an earlier hold withholds) and `cpe_dismissed`.
- **The owner:** a leg of the pool, on an account of another institution of this user, whose automatic match is **not** with a leg that stays. It has no tier 1 partner, or its tier 1 partner is on the removed institution.
- **A removed candidate:** every tier 1 candidate of the owner on the removed institution — also when the owner has a partner, which is then the closest of them.
- **A kept candidate:** every tier 1 candidate of the owner on another institution of this user.
- **A tier 1 candidate** is the evaluator's own edge, and must stay that rule: both legs in the pool, on opposite sides, with exactly opposite cents, at most five days apart, not dismissed by the user.
- For each owner, removed candidate and kept candidate: one hold on the pair of the owner and the kept candidate, card leg first, with the removed candidate's date. The kind is `ambiguity_hold_removed_card` when the owner is the cash leg, `ambiguity_hold_removed_cash_account` when it is the card leg. Each such hold is a row of its own, whatever is already live: two removed candidates with the same date are two holds, and a live hold of the same kind, legs and date that an earlier removal wrote is neither reused nor a reason to write none (amended 2026-10-08, I3A-R packet 1; in revision 5 a live hold of the same kind, legs and date was not written a second time). Identical live holds withhold as one.

**No hold** where all of a leg's candidates are on one side of the removal; where its automatic match stays and a leg of the removed institution merely fitted less well; where the kept leg is outside the five-day window; or for a leg that a user decision holds, which is outside the pool. Unresolved payments are not frozen in general.

**Why the pool, and not the published states (audit P1).** The published states are a presentation. A leg on an account that is excluded from cash flow takes part in tier 1 like any other, but is published `not_counted`, with no candidates. A payment that the "no included card" rule or an earlier removal's record decides is published `untracked`. Each of them can have candidates on both sides of a removal (`a23` C and N2, `a25` O3). Revision 4 read the published states — unresolved, no decision, the displayed candidates — and missed them.
- *The audit's counterexample.* K +100 on a kept, included checking account; R +100 on a checking account of the removed institution; E −100 on a kept **excluded** card; all on the same day; another included card exists. Before the removal E has two equally close candidates, nothing pairs, and K is unresolved. After it, revision 4 paired K with E: `untracked / partner_excluded`, −100. Now the removal writes one hold on the pair of E and K, and K stays unresolved with its range (`a23` B).

**Why every removed candidate, and not only the partner.** The evaluator judges a hold on the dates as they then are, and the owner itself can be re-dated when it posts. On the dates of the removal the partner's hold alone would do. After such a re-dating another removed candidate can be the one that would still have been closer (`a25` G-two).

**Two cases, which stay distinct.** Known removed-destination evidence is not collapsed into an ambiguity, and an ambiguity is not given a destination.

| | Case 1: the leg had no automatic match | Case 2: the leg was matched automatically to the removed institution |
|---|---|---|
| Written | The holds. No record | A cash leg: the system record of statement (b), and the holds. A card leg (the mirror): the holds only |
| Reads afterwards | What it read before the removal: unresolved, with its range and its candidate — or `not_counted` on an excluded account, or `untracked` where the "no included card" rule or an earlier removal's record decides it. One exception: if the removal took the user's last included card, an included cash leg that was unresolved reads `untracked / no_included_card` | A cash leg: its record — `untracked / removed_card`, −amount, the record named on the leg. Tier 1 forms the pair with the kept competitor, the hold withholds it, and the payment falls to its record |
| The kept candidate | Unmatched, as before | Unmatched, as before. It does not take the payment |

**The mirror: the cash institution is removed.** A kept card leg that a removed cash leg and a kept cash leg both fitted is held the same way, with the other kind. If it was matched automatically to the removed cash leg, there is still no destination record — a credit-side leg never moves cash flow — so it reads unresolved, effect 0. In both cases the kept cash leg is not read as a tracked payment it never was (`a22` M, `a23` E, `a25` L).

**How the evaluator reads it.** As in revision 4: neither P1 nor rule 2 needed a change here.
1. It **applies** while both references resolve, by the ordinary lineage rule, to current card-payment legs on opposite sides with the recorded cents. Otherwise it is inactive and does nothing.
2. Tier 1 is computed exactly as before. Then one thing is withheld: the automatic pair of the hold's own two legs, while the removed candidate would still be **at least as close** to the leg it competed for as that leg's partner is, on the dates as they are now.
3. Nothing else changes. Both legs stay in the pool, as each other's candidates and as anyone's. No other pair is formed in the withheld pair's place. A pair with any other leg is evaluated as always.

The hold is pair-specific and of system strength in both cases. New evidence, changed evidence, a relinked card and the user's decision are evaluated as always. One limit is open: the hold keeps judging its own pair against the removed candidate's stored date, after a relink too (§9.3, question 7). (amended 2026-10-09, I3A-R policy: open as behaviour. The policy that governs it is recorded under the status: permanent release requires the user's explicit authorization, P-Y.) (amended 2026-10-09, I3A-R packet 2-A: for a payment the removal wrote a hold or a record about, new evidence and a relinked card are no longer "evaluated as always": an automatic pair with a leg the removal did not know as a surviving candidate is withheld, and the payment reads `unresolved / relink_review_required`. The hold stays.)

| Afterwards | Case 1: a leg that had no automatic match | Case 2: a payment with its record |
|---|---|---|
| Nothing changes | The leg stays unresolved, with its range. Its candidate is still listed. Further evaluations change nothing and write nothing | The payment keeps reading its record. Further evaluations change nothing and write nothing |
| A **new** transaction that fits | Ordinary rule: strictly closer, it pairs; equally close, it is a tie of its own | The same. Strictly closer than the kept competitor, it pairs, and the record is dormant behind it. No closer, it is a tie of its own: nothing pairs, and the payment keeps its record |
| The removed card is **linked again** | The re-imported leg ties with the kept card again, as before the removal. If the kept card's leg later no longer fits, the payment pairs with the re-imported leg. The hold is not in the way of that pair. It still withholds its own pair, by the stored date: a re-imported leg that comes back farther away does not release it (§9.3, question 7) | The re-imported leg, closer than the competitor as the removed one was, pairs again by the ordinary rule; the record is dormant. The hold is on the other pair and is not in the way of that. Where the re-imported leg comes back **farther** than the competitor, or the user dismisses it or confirms it with another payment, the hold still withholds the kept pair and the payment keeps reading its record, although both cards are linked. That is recorded, not decided (§9.3, question 7) |
| The bank changes an **amount** | The hold no longer applies; the ordinary rules decide alone | The same. Both legs corrected alike: neither the hold nor the record applies, and the two pair. The payment alone: the record is not proof of the new amount and the competitor no longer fits to the cent, so it is unresolved |
| A **date** changes | Released if the kept candidate is now strictly closer than the removed one was; otherwise not | The same |
| The leg **posts** with the same amount | The same leg, not new evidence: still held. Posted on another date: judged like any date change | The same: record and hold follow it. Posted on another date: judged like any date change, against the date of every removed candidate (§9.3, question 4) |
| One of several kept candidates **drops out** | The other is not thereby proven: still unresolved | The other is not thereby proven: the payment keeps its record |
| An **excluded** account of a held leg is included later | The leg reads unresolved, with its range. It is not matched to the candidate the removal left | The payment counts as a removed-card payment. It is not tracked to the card that was already there |
| The **user** matches the payment, says "a card I haven't linked", or dismisses the candidate | Works as if no hold existed, and decides the legs it names. If they undo it, the pair is withheld again. A decision about another leg does not release the hold's own pair | The same; record and hold are left in place. If they undo it, the payment reads its record again. A decision about another leg — the re-imported leg of a relinked card, for one — does not release the hold's own pair (§9.3, question 7) |
| The user tries to undo the **hold** | Refused: it is a system record, not theirs | Refused, like the record |

**The hold itself publishes nothing.** No removed-card effect, no tracked pair, no decision on either leg. In case 2 the figure is the record's, and the record is the decision named on the payment. In the mirror case the kept cash leg is not read as a tracked payment.

### 3.5 Afterwards

- **Relinking.** New accounts, new Plaid ids. A system record goes dormant behind a tier 1 pair with the re-imported leg; a hold is on another pair and does not stand in its way. Where no pair with the re-imported leg forms, both keep applying as the removal left them: the hold is judged against the removed leg's stored date, not against the re-imported leg (§9.3, question 7; open). (amended 2026-10-09, I3A-R packet 2-A: after the user undoes a preserved decision, the released leg's pair with a card that was already there is withheld too — the removal knew no surviving edge of a leg the user held — and reads a range until the user decides. And the record no longer goes dormant behind a pair with the re-imported leg. That pair is withheld, the payment reads `unresolved / relink_review_required` — a range — and the record stays stored. It pairs when the user matches it.) A preserved user decision keeps its leg: the re-imported leg is listed as a suggestion and never applied by itself. An invalid preserved decision stays invalid.
- **The user supersedes it** like any of their decisions: a new match (`link_card_payment`) or "a card I haven't linked" (`mark_card_payment_destination`) replaces it; undo releases the leg. A leg it holds cannot be taken as someone else's counterpart until then. A leg released by an undo is evaluated by the ordinary rules; the removal wrote no record and no hold for it (§9.3, question 1).
- **A second removal** of the relinked card preserves the user's new pair anew. The earlier, superseded decision stays superseded. For a payment that is matched automatically to the relinked card again it writes a second record, also where the payment's stored reference (account, Plaid id, cents) is unchanged (`a25` H, O2). Where it writes holds (§3.4), each is a row of its own, also where both legs' references are unchanged and the second removed leg has the date of the first (`a25` H; `a22` G). (amended 2026-10-08, I3A-R packet 1: each removal records what it removed and merges nothing into a row an earlier removal wrote. Revision 5 compared the stored references: it wrote no second record on an unchanged one, and a second hold only for another date.) The rows of both removals stay live. They resolve to the same legs, and the readings are the same as with one: identical holds withhold as one, and of several records that apply the payment's state names the one with the least decision id.

## 4. Failures, freshness and lock order

**Two kinds of failure (Trevor's decision, 2026-10-06).**

| What fails | What happens | What is left |
|---|---|---|
| The removal itself: an existing check, the account locks, the first evaluation, any preservation statement, a loan check or restoration, the delete or a version bump its triggers make, the write of the removal row | The call raises. The whole transaction rolls back | Nothing changed. The operation is still `plaid_removed` and retryable |
| The final evaluation, after all of the above succeeded | Only that evaluation rolls back. The call returns its normal result and commits | The item is removed and everything preserved is written. `input_version` is ahead of `evaluated_version`; `last_error_code` holds the SQLSTATE and nothing else. The readers return no states |

- **"A failure rolls back the whole removal"** (design acceptance test 18) refers to the first row.
- **No stale state is served.** After a failed final evaluation the stored rows are the ones step 3 computed, including states of rows that are now deleted. They carry the older version, so `get_card_payment_states` and `get_financial_read_snapshot` return `fresh = false` and no states.
- **Recovery is not built for this path.** What recovers the user is whatever evaluates next: the sync path's evaluation (only while `CARD_PAYMENT_SYNC_EVALUATION_ENABLED` is on) or a standalone evaluation. A replay of the cleaned removal evaluates nothing, and the decision RPCs refuse a stale user. **This is a release gate.**
- **A cancelled statement or a statement timeout** during the final evaluation is not absorbed by the subtransaction. It ends the whole call, and the removal stays retryable.
- **The removal depends on the evaluator succeeding once,** before anything is deleted, for every user, whatever `CARD_PAYMENT_SYNC_EVALUATION_ENABLED` says. That flag gates only the end-of-sync call. Since revision 5 the hold statement also reads that evaluation's scratch tables (§7): with no evaluation in the same transaction they do not exist, and the removal must fail as a whole rather than preserve from stale states (control `no_first_evaluation_fails_closed`).

**Freshness.** The first evaluation locks the user's version row and holds it to the end of the transaction. Every input change needs that row, so no other writer's change can commit between the preservation, the delete and the final publication. The preservation and the deletes bump the input version through the existing triggers. The final evaluation, when it succeeds, publishes exactly the version it captured, and nothing writes after it.

**Lock order.** The advisory lock (L1) first, as before. Every writer that takes it — the sync batch, the decision RPCs, the loan functions, the standalone evaluator — is serialized with the removal and is unaffected. The rest is about **lock-free** writers: direct statements with no advisory lock, which take a row lock and then ask for the version row (L2) in their trigger.

| | Released removal (20260926120000) | This candidate |
|---|---|---|
| Order of locks | removal row → item row → loan-linked transactions → **account rows** (the cascade's delete) → **L2** (the item's own delete trigger) → transactions, decisions | removal row → item row → loan-linked transactions → **account rows** (locked explicitly, in id order, `FOR UPDATE`) → **L2** (the first evaluation) → transactions, decisions |

- **Account rows come before L2 again.** Taking L2 in the first evaluation, without more, would have put it ahead of the account rows: a lock-free writer holding one of them would close a cycle the released removal did not have. The earlier candidate had exactly that. Now the removal waits for such a writer, as it always did.
  - The backend has one: the account-settings update, when it changes "exclude from cash flow".
- **`FOR UPDATE`, not a weaker mode.** The lock stands in for the delete's, which conflicts with every row lock — including the key-share lock of an insert that references the account. `FOR SHARE` would stop the update and let such an insert through.
- **Transaction rows are as they were.** A lock-free writer holding a transaction of the removed institution meets the same PostgreSQL-detected deadlock (SQLSTATE 40P01) under both bodies: the released removal also held L2 before it deleted any transaction, because a cascade's row triggers are queued behind the parent row's own. One side is rolled back completely; a removal that loses stays `plaid_removed` and succeeds when retried.
- **The preservation's inserts** take the foreign-key lock (`KEY SHARE`) on the *surviving* accounts they name while L2 is held. They always did. Revision 5 writes more of them: a hold for a payment that was matched automatically to the removed card names the kept card's account too. (amended 2026-10-08, I3A-R packet 1: `20261008120000` adds no lock class and no order, and one difference in extent — its generation row is written on every removal, so every removal takes `KEY SHARE` on the user's `auth.users` row; its migration header, LOCKS. Corrected 2026-10-09: that is not a difference from revision 5. The saved probe shows revision 5 already takes that lock in the measured case of a user with no card-payment leg, at the delete; `20261008120000` takes it earlier there, at its generation insert. What `20261008120000` adds is `KEY SHARE` on the ledger rows of earlier cleaned removals that get a marker. `supabase/tests/lim_removal_lock_comparison/results/2026-10-09_packet1.txt`, the EXTENT probe; `PHASE_B_I3A_R_P1_REMOVAL_PROVENANCE.md` §6.)
  - A lock-free **update** of such an account — the account-settings update — holds its row `FOR NO KEY UPDATE`, which does not conflict with `KEY SHARE`. The removal does not wait for that row, so there is no cycle: it runs to completion while the writer still holds it. The writer's version bump comes after the removal's final evaluation and leaves the user stale, never falsely fresh (`c36`).
  - A lock-free **delete** of one of those accounts is the decision RPCs' existing class (`c22`). Nothing in the application deletes an account that way.
- **Not redesigned:** the global lock hierarchy.

Measured on identical fixtures under both bodies (`supabase/tests/lim_removal_lock_comparison`):

| The row the lock-free writer holds | Released removal | This candidate |
|---|---|---|
| A **transaction** of the removed institution (three variants: no decision row; one on its own account; one on an account the cascade reaches first) | deadlock detected | deadlock detected |
| An **account**, which the writer updates | the removal waits | the removal waits |
| An **account**, which the writer's insert only references | the removal waits | the removal waits |

In every deadlock the harness asserts: the only error is 40P01; the side that lost rolled back completely; a removal that lost runs when the same call is repeated, and the manual loan is restored exactly once; the final state is fresh (candidate) or unreadable (released removal, which never evaluated). The two account-row overlaps are also in the access-control suite (`c34`, `c35`), with a probe that the waiting removal holds no lock on the version row. The overlap on a *surviving* account is `c36`; the lock comparison does not cover it.

## 5. Ownership and security

- The evaluator reads only this user's accounts and rows and writes only this user's states.
- All three preservation statements join the accounts to their institutions and require this user: this institution on the removed side, another one on the surviving side. The hold statement reads a pool that the evaluator filled for this user in this transaction, and re-checks the owner of its three accounts all the same. `card_payment_decisions_same_user` checks the surviving accounts again on insert — both of them for a hold (`a23` H, `a25` N).
- Errors from the first evaluation and the preservation are replaced by a fixed message with the step and the SQLSTATE. A failure of the final evaluation raises nothing and stores only its SQLSTATE. No id, amount or name can leak through either.
- Every function is SECURITY INVOKER with an empty `search_path`, executable by `service_role` only. No client role gains a privilege on any table. (amended 2026-10-08, I3A-R packet 1: the two trigger functions of `20261008120000` are executable by no role.)
- The removed leg's reference is two plain values. There is no reference to the deleted account, and no foreign key was weakened: `card_payment_decisions` still references `accounts` twice, both on delete cascade. (amended 2026-10-08, I3A-R packet 1: that is the decision row, and it is unchanged. Beside it a removal now keeps one row in `card_payment_removal_sources` for every decision it writes — a preserved pair, a record, a hold — for as long as that decision row exists: the removed account's Plaid id, type, subtype and mask, and the removed transaction's Plaid id, pending id, pending flag, date, cents and currency. For a preserved pair whose reference had no single current row it keeps, of the transaction, only what was there instead: a carry-over's date and amount, or nothing. It also keeps one row per removal in `card_payment_removal_generations`, with the removed item's institution id. These are plain values too: no foreign key to an account, an item or a transaction, and no account name, balance or token. The account and transaction ids are historical, since a relink issues new ones; the institution id identifies the institution, never an account. No client role has a privilege on either table; the service role may select and insert, nothing else.)

## 6. Compatibility

- **Same contracts.** `remove_plaid_item_local`, `evaluate_card_payments`, `link_card_payment`, `mark_card_payment_destination` and `undo_card_payment_decision` keep their names, arguments, security properties, grants and results. No versioned twin. The review accepted the in-place replacement.
- **Any backend.** A backend that predates I3A calls the same functions. It never sends or reads a decision kind.
- **Readers.** `removed_card` is an existing reason and `funded_from_excluded` an existing credit-side state. One reason value is new, `removed_cash_account`, on a credit-side leg, whose reason no reader interprets. A hold adds no state, reason or detail. Its legs read what the other rules give them: `unresolved / ambiguous`, as legs already do; `untracked / removed_card` for a payment with its record; `not_counted` on an excluded account. The decisions list of the state reader gains rows of the new kinds.
- **The removal's result does not say whether matching is fresh.** A caller learns that from the readers, as for every other write.
- **Deploy order.** `20261006110000`, then `20261006120000`; each refuses to apply out of order. Nothing in the application has to change with them. (amended 2026-10-08, I3A-R packet 1: `20261008120000` comes third. It applies only on top of the exact `20261006120000` body, and needs no application change either.)

## 7. Migrations and rollback

- **`20261006110000_card_payment_pair_counterpart_removed.sql`.** Two columns, three widened checks and two new ones (for the four older kinds they accept exactly what they accepted), the helper `card_payment_reference_status`, the evaluator (the hunks for the preserved pair, and for the hold: its scratch table, when it applies, what it withholds) and one predicate in each of three RPCs. The file keeps its name; it now carries all three kinds. Guards on the exact previous bodies; postconditions on the new ones. Nothing in it writes the new kind. Revision 5 changed one hunk of the evaluator: a preserved pair's frozen disqualifier is read before the surviving leg's amount (§3.1).
- **`20261006120000_lim_removal_card_payment_matching.sql`.** The removal body. Guards on the released body, on the evaluator of `20261006110000`, and on `try_evaluate_card_payments`. Revision 5 changed statement (c), the holds.
- **Revision 5 replaces both candidate files in place.** Nothing was ever released, so revision 5 added no third migration (amended 2026-10-08, I3A-R packet 1: that packet adds one, `20261008120000`, on top of these two files, which it does not change). The checksums in the guards, the rollback scripts and the rehearsal follow the new bodies. A local database built from an earlier candidate must be rebuilt: the guards of this revision refuse it.
- **The removal now reads the evaluator's scratch tables.** Statement (c) reads `pg_temp.cpe_pool`, `cpe_txn`, `cpe_tier1` and `cpe_dismissed` as the strict evaluation leaves them; the evaluator carries a comment at the point after which it writes none of the four. Only apply-time checksum guards tie the two bodies together: that of `20261006120000` and (amended 2026-10-08, I3A-R packet 1) that of `20261008120000`, whose removal body reads the same four tables. **Any later migration that replaces `evaluate_card_payments` must replace, or guard on, `remove_plaid_item_local` in the same file.**
- **Rollback of `20261006120000`.** Restores the released removal body verbatim. It changes no data. Every record, preserved pair and hold stays and stays fully understood, because the evaluator is untouched. Afterwards a removal writes nothing and leaves the user stale, so the three defects I3A fixes are back for later removals: a known destination or a user's confirmation is lost with the account; a tie is resolved by the deletion; an automatically matched payment is switched to a card that was already there. **This is the rollback to prefer.** (amended 2026-10-08, I3A-R packet 1: with `20261008120000` applied this script refuses — "remove_plaid_item_local is not the 20261006120000 definition; refusing to roll back" — until that migration's own rollback has run. That rollback restores the `20261006120000` body verbatim and keeps both provenance tables with every row. A removal made while `20261008120000` is rolled back writes no provenance; when that migration is applied again, the next removal of the same user marks it. The preference, over the rollback of `20261006110000`, is unchanged.)
- **Rollback of `20261006110000`.** Only after the other one (it refuses otherwise). (amended 2026-10-08, I3A-R packet 1: three steps now — the rollback of `20261008120000`, then that of `20261006120000`, then this one. When one of the two older scripts refuses because the `20261008120000` body is installed, its message does not name that migration.) It restores the previous evaluator and RPC bodies verbatim and drops the helper. **It deletes no decision and does not narrow the schema:** the old checks would reject the preserved rows, and deleting those rows would recreate the defect.
  - **It is not transparent while preserved rows exist.** The previous evaluator does not know the kind. It still treats such a row as a user decision on its leg, so the leg stays held. But it knows no effect for it: a payment that read −amount reads unresolved, a range. A card leg that read "funded from outside" reads unresolved. Taken by themselves these rows change only their own legs' readings: the same legs are claimed as before, so no other leg's match changes.
  - The previous RPCs do not supersede it: a new confirmation on such a leg conflicts with it until the user undoes it (undo works).
  - **A hold is misread, and since revision 5 that can change figures.** The previous evaluator reads any record of an unknown kind as a decision on its legs. A hold is written card leg first, so it reads it as an *inactive* decision that claims **both** legs. In revision 4 a hold stood only where its owner was unresolved anyway. Now holds also stand on payments with a known figure, and beside payments that are correctly matched to a hold's other leg. So:
    - A payment that read `untracked / removed_card` through its record and a hold, or `untracked / no_included_card`, reads unresolved: a range instead of a figure.
    - Both held legs leave automatic matching for *every* leg, not only for each other. **Other** payments that had one of them as a candidate or as a partner can gain, lose or switch an automatic match: a figure the evidence does not support is possible.
    - If the account of the hold's card leg later stops being a credit account, the previous evaluator reads the hold as an active confirmed pair. (Not rehearsed.)
    - Neither a date change nor an amount correction releases the pair: an inactive row still claims its current legs, so a pair that formed legitimately after the removal reads unresolved again. A user decision on either leg reads as conflicting with the hold.
    - The previous undo does not refuse a hold, and undoing one is permanent: after both migrations are applied again, that pair is no longer withheld. (amended 2026-10-08, I3A-R packet 1: unless the pair has another live hold. A removal now writes a hold for each removed candidate and merges none, so two removed candidates with the same date, or a second removal, leave several holds on one pair. Under the previous evaluator they read `conflicting_decisions`, the rollback script's case (iii), their legs claimed and unresolved all the same; and the pair stays withheld after the re-apply until each of them has been undone.)
  - **So the script refuses while live holds exist,** unless the operator has acknowledged it in the same session, before the script's own transaction: `set i3a.rollback_with_live_holds = 'acknowledged';`. Whenever it proceeds over live holds or live preserved pairs it raises a warning with both counts.
    - **One acknowledgement serves one run.** The guard clears the setting inside the script's transaction. A run that commits leaves the session without an acknowledgement, and a later run in the same session, over live holds, is refused until it is set again. A run that fails keeps it. The script has to be run over a direct connection, not through a transaction-mode pooler, where the setting and the script can reach different server sessions.
    - **The count is the count that is rolled back.** Before it counts, the guard locks `card_payment_decisions` in `SHARE ROW EXCLUSIVE` mode and holds the lock to the script's commit. It waits for every transaction that has already written to that table — a removal still running the `20261006120000` body among them — and nothing writes a decision until the commit. At `READ COMMITTED`, the default, the counts then include that removal's holds; at a higher isolation level they would not see them. A removal running that body that has not yet written is not waited for: its first preserving statement calls `card_payment_reference_status`, which the script drops, so it fails and removes nothing. Readers are not blocked. None of this concurrent behaviour is rehearsed: the rehearsal runs its sessions one after another, never two at once, so it shows no wait and no concurrent removal. It is read from the script's text and, for the removal that fails, from the removal function's text.
  - Earlier revisions of this document said "no figure becomes wrong" here. That was not true and is withdrawn. The migration's DDL is repeatable, so it can be applied again; every evaluation in between publishes the readings above.
- **Rehearsal** (`supabase/tests/lim_removal_matching_rehearsal`): on a populated database with a user-confirmed pair and a competing card, a tie between each card institution and the kept card, and — for revision 5 — a payment matched automatically to a removed card with a kept card's leg that was already there, and a bystander payment tied between that kept leg and a leg on a second kept card. Upgrade both, remove, roll back both in order, re-apply both.
  - Under the previous removal the tie is resolved by the deletion. Under this one it is held, and the automatically matched payment keeps its figure and is not switched.
  - The rollback of `20261006110000` must be refused with no acknowledgement and with another value, and must proceed, with its warning, once acknowledged. That one acknowledgement serves one run is shown in one session: the acknowledged rollback is applied, `20261006110000` is applied again, and the rollback, run once more with nothing set, must be refused by the hold guard.
  - In the rolled-back state the payment with a known destination must read unresolved, and the bystander — on no held pair — is published as automatically matched: the figure the evidence does not support. After the re-apply both read as before the rollback.
  - No row of twelve tables changes at any upgrade, rollback or re-apply; every guard refuses a repeat or a wrong order.
  - Of the behaviour of the previous functions on a preserved row and on a hold stated above, the rehearsal runs what its fixture has. One preserved pair, on the cash side and frozen `valid`: the leg stays held and reads unresolved; a new match on it is saved and conflicts with the preserved decision; undo works on that decision. Two holds, one on a tie and one on the automatically matched payment, with no leg in more than one: both legs of each read unresolved; the bystander gains a match; the user's own match of a held pair conflicts with the hold; the previous undo does not refuse a hold, and with that undo's one write repeated by hand after the re-apply the pair is no longer withheld. The other statements are read from the previous functions' text and are **not rehearsed**: a preserved pair on a card leg; "a card I haven't linked" on a preserved leg; a held payment that read `untracked / no_included_card`; another payment that loses or switches a match; the change of account type; a date change or an amount correction; a user decision on only one leg of a hold.

## 8. Tests

(amended 2026-10-08, I3A-R packet 1: the tests, controls, scenarios and sequences listed in this section, and their counts, are revision 5's. That packet adds its own and changes some of these. The cases whose stated requirement changed, all after a second removal, are marked below; its document lists the rest.)

**Acceptance:**

| # | Requirement | Where |
|---|---|---|
| 1 | Automatic pair preserved before deletion, as a system record | `a18`; controls `no_preservation`, `preservation_after_delete` |
| 2 | User-confirmed pair preserved as a user decision, not downgraded | `a18`, `a20`; controls `user_pairs_not_preserved`, `user_pairs_downgraded_to_system_record` |
| 3 | Surviving cash leg becomes `removed_card` | `a18` (ten legs) |
| 4 | Matching version changes | `a18`, `a19`; control `version_not_advanced` |
| 5 | Final state fresh after a normal removal | `a18`, `a19` A, `c27`, `c28`, `c31`, `c33`–`c35`; controls `no_final_evaluation`, `stale_marked_fresh` |
| 6a | A failure **before** the delete rolls back everything | `a19` B1, B2; controls `first_evaluation_best_effort`, `no_first_evaluation_fails_closed`, `raw_errors` |
| 6b | A failure of the **final** evaluation commits the removal, stale; a later evaluation recovers | `a19` B3; controls `final_evaluation_strict`, `failed_final_evaluation_marked_fresh` |
| 7 | A leg with no match gets no record | `a18`, `a21`; control `converts_unresolved` |
| 8 | Waiting, amount-changed and ambiguous confirmations survive, reserved; the competitor is never auto-matched | `a20`, `a19` C; controls `waiting_confirmation_released`, `amount_changed_reservation_released`, `ambiguous_confirmation_released`, and the three evaluator controls |
| 9 | The mirror case | `a20` M-active, M-amount; control `mirror_case_not_preserved` |
| 10 | A newer explicit user action supersedes; passive invalidation does not | `a21`; controls `superseded_pairs_preserved`, `reclassified_pairs_preserved` |
| 11 | Relink precedence | `a18`, `a20`, sequences Q10 and Q11 |
| 12 | Same-user ownership | `a18`, `a19` |
| 13 | Pending → posted | `a18`, `a20` W-cash, `c30`, `c31` |
| 14 | Account rows before the version row | `c34`, `c35`, the lock comparison; controls `no_account_locks`, `account_locks_after_first_evaluation`, `account_locks_for_share` |
| 15 | A tie the removal would break stays unresolved: not matched to the candidate that is left, no effect | `a22` A, B, M; `a21` T; controls `ambiguity_hold_omitted`, `eval_hold_does_not_withhold`, `eval_hold_publishes_an_effect` |
| 16 | The hold is system strength and stays inside its scope | `a22` C-new, D, E, N, R, S, T; controls `eval_hold_user_strength`, `eval_hold_blocks_any_pair_of_its_legs`, `eval_hold_overrides_user_decision`, `hold_without_a_removed_candidate`, `hold_removed_candidate_window_widened`, `hold_for_a_dismissed_removed_candidate`, `hold_for_a_dismissed_kept_candidate` |
| 17 | New or changed evidence resolves it by the ordinary rules | `a22` C-new, C-date, C-amount, E, M, P; controls `eval_hold_ignores_date_changes`, `eval_hold_ignores_amount_changes`, `hold_records_the_wrong_date` |
| 18 | An ambiguity in the complete matching pool is held whatever a reader is shown — an excluded account on either side, a payment the "no included card" rule decides — and nothing is written where there is none (audit P1) | `a23`; scenarios S83–S86, sequence Q13; controls `holds_from_published_states`, `excluded_owner_omitted`, `excluded_candidate_ignored`, `excluded_removed_candidate_ignored`, `no_included_card_owner_omitted` |
| 19 | A frozen disqualifier of the removed side stays the decision's reason whatever the surviving leg's amount or role later is; the "no included card" exception applies only where an amount is the only thing wrong (audit P2) | `a24`; scenarios S77–S82, sequence Q14; the reference evaluator's P2 scenarios and invariants I11, I12; controls `eval_frozen_status_after_amount`, `eval_exception_for_any_inactive_preserved_pair`, `eval_frozen_status_only_while_card_leg` |
| 20 | A payment matched automatically to the removed institution keeps its recorded destination and is not switched to a leg that was already there; the protection is pair-specific and of system strength; a tie stays a distinct case (decision 14) | `a25`; `a21` E-undo; `c36`; scenarios S87–S94, sequence Q15; controls `automatic_destination_protection_omitted`, `hold_only_for_the_removed_partner`, `holds_for_legs_whose_automatic_match_stays`, `hold_candidate_window_widened`, `eval_hold_moot_beside_a_record`, `eval_hold_released_by_posting` |

**The contract test, `a20_lim_removal_user_confirmations.sql`.** Written before the behaviour existed, as the statement of the decision. Nine cases, each with a competing qualifying leg — the opposite amount within five days, which pairs automatically with the protected leg the moment it is free:

| Case | The confirmation, when the account is removed | Required, and now observed |
|---|---|---|
| W-card | waiting for its card leg to post | preserved, held; −210 |
| W-cash | waiting for its cash leg to post | preserved; when the leg posts: held, −215 |
| A-card | the **card** leg's amount changed (the review's counterexample) | preserved, held; unresolved |
| A-cash | the **cash** leg's amount changed | preserved, held; unresolved |
| L-card | conflicting replacements of the card leg | preserved, held; unresolved, no effect |
| L-cash | conflicting replacements of the cash leg | preserved; no replacement chosen; held once one is left |
| U-tie | **active**: the user chose this card over an equally close one | preserved, held; −500 |
| M-active | mirror: the cash account is removed; active | preserved on the card leg, held; funded from outside, 0; the competing cash leg unresolved |
| M-amount | mirror: the removed cash leg's amount had changed | preserved on the card leg, held; unresolved, 0 |

It also checks three of them after a relink. 40 requirements. **Fail-before:** against the previous candidate 39 of the 40 are violated (30 of 31 for the first seven cases, as first reviewed); the runs are in the review evidence.

**`a21_lim_removal_user_intent.sql`:** undone, replaced and user-re-classified confirmations are not carried forward and hold nothing; classifier-re-classified and bank-withdrawn ones are preserved and reserved; the "no included card" rule; after the removal, undo, a new match and "unlinked" each supersede a preserved decision; a held leg is refused as a counterpart. Its case T — a tie between the removed card and a kept one — now requires the payment to stay unresolved (it pinned the opposite before the decision).
- **Case E-undo changed in revision 5.** The user confirmed a match with the removed card and undid it *before* the removal, so the payment is an ordinary automatic match to that card again; a kept card's leg fits too, one day farther. The case used to pin `tracked / auto_pair` with the kept card after the removal — exactly what decision 14 forbids. It now requires `untracked / removed_card` with the system record, no user decision on the payment, and one hold on the pair with the kept card's leg.
- **Case V1 is unchanged.** An undo *after* the removal releases the leg to ordinary matching, and it pairs with the kept card's leg (§9.3, question 1).

**The ambiguity hold's own test, `a22_lim_removal_ambiguity_hold.sql`.** Sixteen cases, each with its own amount, through the real removal, the real evaluator and the real RPCs:

| Case | Before the removal | Required, and observed |
|---|---|---|
| A | a payment tied between the removed card and a kept card | one hold; unresolved, range {−700, 0}, each other's candidate; no decision on either leg; the user cannot undo the hold |
| B | three candidates, one removed | a hold for each of the two that are left; unresolved; still unresolved when one of the two later drops out |
| C-new | a tie | later a new, strictly closer transaction: it pairs |
| C-date | a tie, two days each | the kept leg re-dated to two days on the other side: still held. Re-dated to one day: pairs |
| C-amount | a tie | the bank corrects both legs: the hold no longer applies, they pair |
| C-posted | a tie, the payment pending | it posts unchanged: still held |
| D | three ties | the user's match decides, and when undone the pair is withheld again; "unlinked" decides; a dismissal works |
| E | a tie | the card is linked again: the tie is back by itself; the kept leg is withdrawn: the payment pairs with the re-imported leg |
| G | a tie | a second removal with the same ambiguity writes a hold of its own on the same pair, with the same date; the two withhold as one, and the payment is still unresolved (amended 2026-10-08, I3A-R packet 1: revision 5 required no second hold) |
| N | a tie between two **kept** cards | no hold; resolves by the ordinary rule when one drops out |
| P | the kept card strictly closer than the removed one; unresolved for another reason | the hold carries the removed candidate's date; when the other reason goes, the pair forms |
| R | a tie between two **kept** cards; a leg on the removed card fitted too, and the user had dismissed it against the payment | no hold: a dismissed leg is no removed candidate |
| S | a tie between two **kept** cards; a leg on the removed card fits by amount, six days from the payment | no hold: a leg outside the five days is no removed candidate |
| T | a tie between the removed card and a kept card; the user had dismissed a second kept card's leg against the payment | one hold, on the pair with the kept card that was not dismissed; none on the dismissed pair. This is the behaviour as implemented: whether such a leg should be protected against is open (§9.3, question 2) |
| M | the mirror: a card leg, a removed cash leg, a kept cash leg | a hold of the other kind; the kept cash leg is **not** read as tracked; released by a date change measured from the card leg |
| F | another user with the same amounts | untouched by this user's removal; their own removal holds their own tie; no hold across users can be written |

44 requirements (amended 2026-10-08, I3A-R packet 1: in revision 5; case G now states more). Against the previous candidate the file cannot run (the kinds do not exist); `a21`'s case T is the behavioural fail-before.

**The three contract tests of revision 5.** Like `a20` and `a22`, each records every requirement, prints them all and asserts them together, naming the violated cases. They go through the real removal, the real evaluator and the real RPCs; `a24` also writes preserved decisions directly, as said below.

**`a23_lim_removal_excluded_accounts.sql` (audit P1).** The approved rule is about the matching evidence — the complete tier 1 pool, in which legs on excluded accounts take part — not about what a reader is shown.

| Case | Before the removal | Required |
|---|---|---|
| A | an included payment tied between the removed card and a kept **excluded** card | one hold; still unresolved, a range — not `untracked / partner_excluded` with the excluded card |
| B | **the audit's counterexample:** the tie is the excluded card leg's — two payments fit it, one of them removed — and that leg is published with no candidate list | one hold of the removed-cash kind on the two legs that are left; the kept payment unresolved with its range {−100, 0}, as before; the excluded leg matched to nothing |
| C | an **excluded** cash leg tied between the removed card and a kept one | a hold, although the leg is published `not_counted`. When its account is included later: unresolved, a range — not tracked to the card that is left |
| D | both candidates on excluded cards, one of them removed; an included card remains | held; unresolved. Including the kept card later changes neither leg's match |
| E | the mirror: a card leg tied between a removed cash leg and a kept **excluded** cash leg | a hold of the removed-cash kind; the card leg unresolved, 0. When the account is included later: the cash leg unresolved, a range — not tracked |
| F | four shapes with no ambiguity between removed and kept: an automatic match with an excluded card that the removed leg does not fit; an automatic match that stays; two excluded card legs and no payment; a tie between two **removed** cards | nothing is written and no reading changes, except that the last has no candidate left — and no destination |
| G | shape B | the user's match decides and leaves the hold in place; undone, the pair is withheld again; the hold cannot be undone; "unlinked" decides |
| H | another user with the same amounts and dates | untouched by this user's removal; their own removal holds their own ambiguity; no hold across users can be written |
| I | shape B, the payment pending | it posts unchanged: the hold follows it |
| J | — | two further evaluations of unchanged evidence change no reading, write no decision and do not advance the input version |
| N | shape B for a user with **no included card**: the owner of the ambiguity is the excluded card leg. The payment, the hold's other leg, reads `untracked / no_included_card` | the same reading and figure after the removal; the pair is held (the hold H requires). When the card is included later: unresolved, a range — not tracked to the candidate that is left |
| N2 | the same user: the payment itself is the owner. It is published `untracked / no_included_card`, with no candidate list, and is tied in the complete pool between an excluded card leg of the removed institution and an excluded card leg that stays | one hold, of the removed-card kind, on the kept leg and the payment; the same reading and figure, no decision named on the payment, the kept leg matched to nothing. When the kept card is included later: unresolved, a range {−150, 0}, with the kept leg as its one candidate — not tracked to it |
| INV | every surviving included payment of the first user | the removal alone changed the figures (effect, low, high) of none of them |

39 requirements.

**`a24_lim_removal_frozen_invalidity.sql` (audit P2).** Part 1 goes through the real removal: six confirmations of a user who is left with no card at all — where the exception can apply — and one of a user who keeps an included card with a competing leg. After the removal the bank corrects each surviving payment by −2.00, and later restores it. Part 2 writes the decision a removal writes directly, once for each of the ten frozen statuses, because three of the disqualifiers cannot be produced through the application. Its last step, after the amounts were restored, re-classifies each of the ten payments away from card payment, so that the row that survived is no card leg at all.

| Case | Frozen status | Required |
|---|---|---|
| L-amount (the audit's counterexample) | `lineage_ambiguous` | reserved, unresolved, the frozen reason on the leg and on the decision — after the removal, after the correction (no effect is published: still a range) and after the restoration. Once the user undoes it the leg is free and counts by "no included card", attached to no decision |
| G-amount | `partner_gone` | the same three readings |
| R-amount | `role_changed` (by the classifier) | the same |
| V-amount | `valid` | a removed-card payment. Corrected: the exception — the corrected amount counts, the confirmation is inactive. Restored: active again by itself |
| W-amount | `waiting_to_post` | as V-amount |
| A-amount | `amount_changed` | the exception after the removal, after the correction (then both sides' amounts have changed) and after the restoration; the confirmation stays inactive |
| C-amount | `lineage_ambiguous`; a kept included card has a leg at exactly the corrected amount | reserved and unresolved throughout; the competitor is not paired, also when the corrected payment fits it to the cent. Once the user undoes it, the two pair by the ordinary rule |
| M-`<status>` | each of the ten | at the recorded amount, after the correction and after the restoration. The seven disqualifiers: reserved and unresolved with the frozen reason, every time. `valid` and `waiting_to_post`: active, and the exception while corrected. `amount_changed`: the exception every time. Last, re-classified away from card payment: no leg state is left, and the decision is inactive — for the seven disqualifiers still with the frozen reason; for `valid`, `waiting_to_post` and `amount_changed` with `role_changed`, the surviving row's own role |

65 requirements.

**`a25_lim_removal_automatic_destination.sql` (decision 14).** A payment on the kept checking account, a leg on the removed card and, in most cases, a leg on a kept card that was already there. "d" is the distance in days from the payment.

| Case | Before the removal | Required |
|---|---|---|
| A (the approved example) | matched automatically to the removed card (d1); a kept card's leg also fits (d3) | one system record; `untracked / removed_card`, −100, the record named on the payment; one hold on that pair with the removed leg's date; the kept leg unmatched, exactly as before; the user can undo neither system record |
| B | matched automatically; no competitor | the record alone; no hold |
| C (case 1) | a tie between the two cards | unresolved, a range; **no** record; the hold only |
| D | matched (d0); two kept competitors (d2, d3) | a hold for each. When one of them later drops out, the other is not thereby proven |
| E, E2 | matched | a **new** strictly closer leg pairs, and the record is dormant; a new leg no closer than the old competitor is a tie of its own, and the payment keeps its record |
| F-date | matched (d2); competitor (d4) | the competitor re-dated to two days away: nothing changes; to one day: the pair forms |
| F-amt, F-own | matched | both amounts corrected: neither hold nor record applies, and the two pair. The payment alone corrected: the record is not proof; unresolved |
| G | matched; the payment pending | it posts unchanged: record and hold follow it |
| G-card | matched (d1); the **kept** card's leg (d3) pending | the record, and one hold, whose card-side reference is the pending row. That leg posts unchanged: the hold follows it through the card-side reference, and the payment keeps its record |
| G-two | pending; **two** legs on the removed card (d1, the partner; d3); competitor (d4) | a hold for each removed candidate. It posts two days later: the partner would now be farther than the competitor, the other removed leg closer — not switched |
| G-date | pending; matched (d0); competitor (d2) | it posts on the competitor's day: a date change like any other — the competitor is now strictly closer than the removed leg was, and pairs |
| H | matched | relinked: the re-imported leg pairs again, the record dormant. Removed a second time: a second record, and a second hold on the same pair with the same date; the removed destination again, as with one (amended 2026-10-08, I3A-R packet 1: revision 5 required no second record and no second hold) |
| I | matched, then **confirmed by the user** | preserved as the user's decision; no record and no hold; the competitor is only a suggestion |
| J | matched (three payments) | the user's match with the card that was already there decides, record and hold left in place; undone, the payment reads its record again. "Unlinked" decides. A dismissal works |
| K-xe, K-ce, K-e | the removed card excluded; the payment's account excluded; the competitor excluded | not switched in any of them. K-xe counted in full before, and still does. K-ce stays not counted and, once its account is included, is a removed-card payment |
| L (the mirror) | a kept card leg matched automatically to a removed **cash** leg (d1); a kept payment also fits it (d3) | a hold of the other kind; no record; the card leg unresolved, 0; the kept payment unresolved with its range — **not** tracked |
| M | — | two further evaluations of unchanged evidence change nothing |
| N | another user, with the amounts and dates of A | untouched; their own removal protects their own payment; nothing can be written across users |
| O | matched (d0); competitor (d2) | a new leg (d1) outranks the record and pairs; the old competitor is still unmatched |
| O2 | matched (d0); competitor (d3) | relinked (d1) and removed again: a second record; a second hold on the same pair, with the second removed leg's date; not switched (amended 2026-10-08, I3A-R packet 1: revision 5 required still one record) |
| O3 | matched (d0); no competitor | the record alone. Relinked, with a **new** leg on the kept card: the two tie (d2 each), nothing pairs, and the payment still reads `untracked / removed_card` through its record. Removed again: the tie is held although the payment was never published unresolved — one hold on the pair with the kept leg, still one record, not switched |
| P | matched to the card that **stays**; the removed card's leg fitted less well | nothing is written |
| Q | matched; a kept leg seven days away | not a competitor: the record, no hold |

65 requirements (amended 2026-10-08, I3A-R packet 1: in revision 5; cases H, O2 and O3 now state more). `a25` also records, apart from the contract and under an assertion message of its own, what a held payment reads today after a relink when no pair with the re-imported leg forms (labels OQ7 and OQ7-dis). That is open question 7 of §9.3, and not a requirement.

**`a19` B3** (the final evaluation is made to fail): the call returns its usual result; the item is gone and the operation `cleaned`; the loan is restored exactly; what was preserved is there; `input_version` is ahead of `evaluated_version`; the state reader and the read snapshot return no states, and only the SQLSTATE is stored; a replay, a decision RPC and a further evaluation while the fault lasts do not recover; a standalone evaluation afterwards publishes exactly what the removal preserved.

**Concurrency** (`access_control/concurrency`, real sessions, barriers on `pg_blocking_pids`, no sleeps as proof):

| Test | Order | Outcome |
|---|---|---|
| `c26` | removal, then a link on a leg of the removed card | Link refused (`card_payment_stale_version`); nothing written; fresh |
| `c27` | link, then removal | The user pair that committed just before is preserved as the user's decision; fresh |
| `c28`, `c29` | standalone evaluation before / after the removal | Fresh; same result |
| `c30`, `c31` | the posting of a surviving pending leg after / before the removal | The record follows the lineage |
| `c32` | removal, then a lock-free update of a **surviving** leg | No deadlock. The user ends stale, never falsely fresh |
| `c33` | a session holding only the advisory lock | The waiting removal holds no version-row lock (L1 before L2) |
| `c34` | a lock-free **update** of an account of the removed institution, then the removal | The removal waits, holding no version-row lock; both complete |
| `c35` | a lock-free **insert** referencing such an account, then the removal | The same |
| `c36` | a lock-free **update** holds the row of a **kept** card account that a hold of this removal names, then the removal | The removal completes first, without waiting for that row, and writes the record and the hold. The writer's later change leaves the user stale, never falsely fresh; a later evaluation is fresh, and the payment still reads its removed destination |

**Evaluator equivalence** (`supabase/tests/card_payment_evaluator`): the SQL evaluator against the TypeScript reference on 300 generated two-user histories — which now carry preserved pairs on any row, either side, every frozen status, ambiguity holds of both kinds, either leg order, dates on every side of the tie, and (revision 5) a preserved pair with any frozen status on a corrected cash payment of a user with no included card — and 97 hand-built scenarios (S32–S50 the preserved pair, S51–S76 the hold). Sequences Q9–Q15 run the real removal and compare both evaluators on exactly the decisions it wrote; Q11 covers active, waiting, amount-changed and mirror pairs, then a relink and a re-match; Q12 covers the hold: a two-way tie, three candidates, the mirror, then a refused undo, a relink, a corrected amount, a date change and the user's decision. Revision 5:
- **S77–S82 (P2):** the frozen status under a corrected surviving amount — a disqualifier with no included card; `valid` and `amount_changed`, where the exception applies; a surviving row that is re-classified and re-priced; a competitor at the corrected amount; the mirror.
- **S83–S86 (P1):** a hold on a pair with a leg on an excluded account withholds it like any other — an excluded card leg, an excluded cash leg, the same rows without the hold, and a user with no included card, where the lower rule decides.
- **S87–S94 (decision 14):** a payment with its record and a hold on the pair with the kept card's leg — withheld; a new strictly closer leg; the kept leg re-dated strictly closer; both amounts corrected; a second hold that alone would withhold nothing; the user's own pair; the posted row; the mirror. **S95:** a hold recorded under another user is rejected and changes nothing.
- **S96–S97 (P2, added by the self-review):** a preserved pair with a frozen disqualifier whose **surviving** reference has no current row. Its own lineage is read first: `partner_gone` with no carry-over, `waiting_to_post` with a live one. Generated histories reach only `lineage_ambiguous` there.
- **Hand-derived expectations.** Two evaluators that agree could share a bug. Every scenario from S77 on therefore also states the outcome a person derived from the rules, and it is checked against both evaluators.
- **Q13 (P1):** the audit's counterexample through the real removal — exactly one hold, of the removed-cash kind — then the user's confirmation of that pair, and its undo. **Q14 (P2):** two preserved pairs of a user left with no card, one frozen `lineage_ambiguous` and one `valid`, through a correction and a restoration of the surviving amounts. **Q15 (decision 14):** two automatically matched payments, each with a kept competitor; then a new, strictly closer leg for one, and a relink for the other.

**Reference evaluator tests** (`cardPaymentMatching.adversarial.test.ts`): hand-derived scenarios for the new kinds, and the invariants over the generated histories extended to them. For the hold, invariant I13 restates from the input which holds apply and which pairs they withhold, then compares with the same input without its holds: the only thing a hold may do is make such a pair absent. Revision 5, for P2:
- **Directed scenarios** for every frozen disqualifier: a surviving amount corrected in the same direction with no included card is not the exception; the three statuses an amount explains still reach it; no false recovery when the amount is restored; the reservation holds against a competitor at the corrected amount; only the user releases the leg; the mirror; a surviving row that is no longer a card leg; the surviving reference's own lineage still comes first.
- **Invariant I11** now also requires, from the input, that the exception's preserved pair has a frozen status an amount explains.
- **Invariant I12** restates the full status and detail of every live preserved pair from the input, in the order of §3.1.
- **The generator** (`backend/src/testUtils/cardPaymentHistories.ts`) has a fourth stream of its own: it puts a preserved pair with any frozen status on a corrected cash payment of a user with no included card. A vacuity guard requires that case to occur, under a status an amount explains and under a disqualifier, and requires that no disqualifier comes out as a published effect.

**Negative controls** (`supabase/tests/lim_removal_matching_mutations`): 63 deliberately wrong versions of the removal or of the evaluator, each applied to its own database; revision 4 had 44. A control may now name several tests, and is detected only when every one of them fails with the stated assertion.
- **For P1:** `holds_from_published_states` (the revision 4 statement put back), `excluded_owner_omitted`, `excluded_candidate_ignored`, `excluded_removed_candidate_ignored`, and `no_included_card_owner_omitted`: a cash-side owner of a user with no included card gets no hold. Its expected case is `a23` N2 alone.
- **For P2:** `eval_frozen_status_after_amount` (the revision 4 order), `eval_exception_for_any_inactive_preserved_pair`, and `eval_frozen_status_only_while_card_leg`: the frozen disqualifier is read only while the surviving row is a card leg. Its expected cases are six of `a24`'s seven M-disqualifiers; M-`role_changed` cannot show it, because both readings are `role_changed`.
- **For decision 14:** `automatic_destination_protection_omitted`, `hold_only_for_the_removed_partner`, `holds_for_legs_whose_automatic_match_stays`, `hold_candidate_window_widened`, `eval_hold_moot_beside_a_record`, `eval_hold_released_by_posting`.
- **For the edge of a candidate** (statement (c), §3.4), each with one expected case of `a22`: `hold_removed_candidate_window_widened` (a leg of the removed institution up to sixty days away counts as a removed candidate; S), `hold_for_a_dismissed_removed_candidate` (R) and `hold_for_a_dismissed_kept_candidate` (T; like the case, it pins the behaviour as implemented: §9.3, question 2).
- **Also new:** `no_first_evaluation_fails_closed` (§4) and `hold_no_user_filter`.
- **Three controls are defined to survive:** `no_user_filter`, `no_survivor_filter` and the new `hold_no_user_filter`. Each is a redundant safeguard and says so in its definition. §12 has the result.

## 9. Decisions and what remains open

### 9.1 Approved by Trevor on 2026-10-06, all implemented

1. Pre-removal evaluation strict; final evaluation best-effort.
2. A distinct, additive, user-strength preserved form. Not `destination_removed_card`, not `destination_unlinked`.
3. Active user pairs are preserved at user strength too. (This amends the first sentence of design §4.7.)
4. Waiting to post: preserved, reserved; an effect only where a current valid leg supports it.
5. Amount changed: preserved, reserved, not proof; "no included card" may establish an effect independently.
6. Ambiguous lineage: preserved, reserved, unresolved, no replacement chosen.
7. Passive invalidation preserves history and reservation; a newer explicit user action supersedes.
8. Relink: user-level precedence kept; an invalid confirmation not revived.
9. The mirror case, with no cash-flow effect invented on the credit side.
10. A leg that was unresolved gets no destination from the removal: removal is not evidence. (What it does get, where a candidate is deleted, is decision 13.)
11. System records unchanged.
12. Account rows locked before the version row, with the lock their delete takes.
13. A removal does not resolve a pre-existing ambiguity. A system ambiguity hold preserves it: no effect, below every user decision, released by genuinely new or changed evidence or by the user. (This replaces the reading of decision 10 that this document pinned before: a tie between the removed card and a kept one no longer resolves to the kept card.)
14. "Option B", on what revision 4 left open as its §9.3 item 1. A payment that was automatically matched to a card of the removed institution must not automatically switch to another card that was already there, solely because the original destination disappeared. Institution removal is not new financial evidence. The known removed destination and its treatment are kept, and stay distinct from an unresolved tie. The protection is pair-specific and of system strength: new evidence, changed evidence, a relinked card and the user's decision are evaluated as always.

**Confirmed, not changed.** Revision 4 listed "posting alone does not release a hold" as open (its §9.3 item 2). The independent audit confirmed it as the approved contract. The implementation is as it was (§9.2): `a22` C-posted, `a23` I, and `a25` G and G-card require it, and control `eval_hold_released_by_posting` checks that they detect the opposite. What a posting on another *date* does is §9.3, question 4.

### 9.2 Choices made inside those decisions (for the reviewer)

- **One column, not three.** The removed leg's reference reuses leg B's Plaid id and cents with no account.
- **Names:** kind `pair_counterpart_removed`; column `counterpart_status`; reason `removed_cash_account`.
- **The credit-side state** of a valid mirror decision is the existing `funded_from_excluded`: the reader already takes it as "funded from outside the tracked set", effect 0.
- **What counts as an explicit role change:** `user_role_override` set, and not to card payment, on a current row of either leg's lineage. Nothing in the application writes that column yet (the role endpoint is later work); the test sets it directly.
- **Every other inactive reason on the removed side** (`partner_gone`, `role_changed` by the classifier, the three relational ones, `conflicting_decisions`) is treated as passive: preserved, reserved, unresolved.
- **`decided_seq` and `created_at`** are the pair's: when the user confirmed, not when the removal ran. (The removal's time is on the removal operation.)
- **`FOR UPDATE`** on the account rows, for the reason in §4.
- **The hold is on a pair, with the removed candidate's date; two kinds.** The reasons are in §3.4.
- **Which legs are held** is read from the evaluator's complete pool — the scratch tables the removal's own strict evaluation leaves in the transaction — and not from the published states: a pool leg whose automatic match is not with a leg that stays, with tier 1 candidates on both sides (§3.4). A hold is written for every surviving candidate, also one that was already strictly closer than a removed one — it then withholds nothing, unless a later date change makes that removed candidate at least as close.
- **Every removed candidate gets its own hold,** not only the owner's partner: the evaluator judges a hold on the dates as they then are, and the owner can be re-dated when it posts. This adds rows, not a rule.
- **No new kind, column or evaluator rule for decision 14.** Statement (b) still writes the system record, which is not promoted above tier 1. Statement (c) also takes as an owner a leg whose tier 1 partner is on the removed institution, and writes the existing hold. With that one pair withheld, the payment reads its record.
- **The frozen disqualifier is read first** (§3.1). The "no included card" exception itself is unchanged; it can now be reached only where the decision's inactive reason is an amount change.
- **A posted row with the same amount is the same leg**, by the lineage rule every decision uses: posting alone does not release a hold.
- **Undo refuses a hold**, as it refuses the system record. No other RPC reads one; a user decision leaves the hold in place, so undoing that decision returns the payment to what it read before: unresolved, or its record.

### 9.3 Open, for a decision

**Seven questions that revision 5 records and does not decide.** Each is given with its smallest example and with what the code does today. None of them is decided here.

1. **A preserved confirmation undone before the removal, or after it.** K +100 on a kept checking account; X −100 on the removed card, one day later; Y −100 on a kept card, two days later; the user confirmed K with X.
   - *Undone before the removal:* K is an ordinary automatic match to X again. The removal writes the record and the hold, and K reads `untracked / removed_card` (`a21` E-undo).
   - *Undone after the removal:* the preserved decision is released. K has no record and no hold, and pairs with Y's leg: `tracked / auto_pair` (`a21` V1).
   - Should the order of the two actions make this difference?
2. **A competitor that is not a tier 1 candidate at the removal.** A hold is written only against a kept leg that is a tier 1 candidate of the payment in the removal's own evaluation. A kept leg that fits by amount gets none while it is held by a user decision on another payment, dismissed against this payment (`a22` T records that, as implemented), waiting to post, or just outside the five-day window. If it later returns, the ordinary rules apply.
   - *Example:* K +100, pending, matched automatically to the removed card's leg of the same day; a kept card's leg −100 six days later. The removal writes the record and no hold (`a25` Q pins this for seven days). If K then posts dated one day later, the kept leg is five days away, is its only candidate, and pairs by the ordinary rule. No test pins that continuation.
   - Should the protection reach such a leg?
3. **A removed leg that was both re-priced and re-classified is frozen as `amount_changed`.** The removed leg's status is taken by the evaluator's own convention: amount first, then role.
   - *Example:* the user confirmed K +100 with X −100. Before the removal the bank changes X to −99 and the classifier re-classifies it away from card payment. The confirmation is frozen `amount_changed`, not `role_changed`. With no included card left, K reads `untracked / no_included_card` by the exception, although an amount was not the only thing wrong with the removed side.
   - Is "an amount is the only thing wrong" judged by the frozen label, as now, or by everything that was true of the removed row?
4. **A posting that changes the owner's date.** The approved rule judges a posting on another date like any date change, so it can release a hold.
   - *Example (`a25` G-date):* K +210, pending on the 10th, matched automatically to the removed card's leg of the same day; a kept card's leg on the 12th. The removal writes the record, and a hold dated the 10th. K posts with the same amount, dated the 12th. The kept leg is now strictly closer than the removed one would be, the hold no longer withholds, and K pairs with it. Where the removed institution had a second candidate, its date can still withhold (`a25` G-two).
   - Should a date-only posting of the payment itself be able to end the protection of decision 14?
5. **A confirmation that the removal does not carry forward releases its surviving leg at the removal.**
   - *Example (`a21` E-role-card):* the user confirmed K with X on the removed card, then re-classified X away from card payment; a kept card's leg also fits K. The newer explicit action supersedes the confirmation, so it is not preserved (decision 7). Until the removal the inactive pair still holds K: K is outside the pool, and gets no record and no hold. The cascade deletes the pair, and K pairs with the kept card's leg: `tracked / auto_pair`.
   - Is that the intended outcome for the leg that is released?
6. **Rolling back `20261006110000` while live holds exist.** The previous evaluator misreads a hold (§7).
   - *Example:* one payment with its record and one hold. After the rollback it reads unresolved, a range, instead of −amount. Its competitor's leg is claimed too, so another payment that had that leg as its partner or candidate can gain, lose or switch an automatic match.
   - Today the script refuses unless the operator acknowledges it in the session, and warns; one acknowledgement serves one run. Should this rollback be possible at all while live holds exist, and if so by what procedure?
7. **A hold after the removed institution is linked again.** A hold judges its own pair against the removed candidate's **stored** date. Nothing ties it to the institution that was removed, so it keeps doing that after the institution is linked again, whatever the re-imported leg looks like. (amended 2026-10-08, I3A-R packet 1: that packet records, beside each hold and record, which removal and which removed account and transaction it depends on, but neither evaluator reads that and its Plaid account and transaction ids cannot show that an account or a leg has returned (the removed item's institution id, which it also records, identifies the institution and never an account), so a hold behaves as described here and this question is exactly as open as it was; `PHASE_B_I3A_R_P1_REMOVAL_PROVENANCE.md`.) The self-review of this revision found it; it is confirmed in a local database, and `a25` records today's reading under the label OQ7, as undecided.
   - *Example:* K +370 on a kept checking account, on the 10th; X −370 on the removed card, on the 11th; Y −370 on a kept card, on the 12th. K was matched automatically to X. The removal writes the record, and a hold on (Y, K) dated the 11th; K reads `untracked / removed_card`, −370 (decision 14). The institution is linked again and its history is re-imported. The leg comes back dated the **14th** (a leg that was pending and has posted since does this). K's candidates are now Y, two days away, and the re-imported leg, four days away. The hold still withholds (K, Y): the stored date, one day away, is closer. Nothing pairs, and K keeps reading `untracked / removed_card`, −370 — a definite outflow, although both cards are linked. With no removal in the history the same bank rows give `tracked / auto_pair` with Y, effect 0.
   - *The same reading* follows where the re-imported leg comes back on its original date and pairs again (`a25` H), and the user then dismisses that pair or confirms the re-imported leg with another payment. For a hold on a tie (case 1, as in revision 4) the payment stays unresolved, a range, where the same rows with no removal would pair.
   - *The way out today:* the user matches K with Y, or with the re-imported leg, themselves; `link_card_payment` does not read a hold. K's own row lists no candidate while it reads its record. Neither system row is the user's to undo.
   - *Related, and not new in this revision:* the system record alone gives a definite removed-card figure after a relink whenever no automatic pair forms: the re-imported leg ties with a kept leg (`a25` O3), is more than five days away, or does not come back.
   - *Why it is not corrected here.* Two approved texts point in different directions. "A relinked card … evaluated as always" and "do not permanently freeze the system match" say K should be free to pair with Y. The approved hold rule says that a new leg which is no closer than the kept competitor changes nothing — and neither evaluator can tell the re-imported leg from any other new leg: a hold stores a date, and a relink brings new accounts and new ids. Every rule that would release the hold needs one of three things. A proxy for "the same institution is back" (an item linked after the removal, with a leg of the same amount) can be met by an unrelated institution, which produces the very switch decision 14 forbids, and it flips back when that leg goes away. A column that ties the hold to the removed institution is a schema change. A write that ends the holds when the institution's history is re-imported is a new write path.
   - *To decide:* after the removed institution is linked again, do the holds its removal wrote stay; end when a matching leg is re-imported; or end at the relink? Is the end durable? Does the user's decision about the re-imported leg count as its return? Do tie holds follow the same rule? And should the record alone still give a definite removed-card figure after a relink?
   - *Policy (amended 2026-10-09, I3A-R policy; recorded in the policy amendment under the status).* P-Y and P-D govern this question, as that amendment states them: permanent release requires the user's explicit authorization, retirement of removed-destination evidence requires separately identifiable authorization, and neither permission grants the other. So no end without the user's authorization is adopted from those asked about above. A narrowly scoped review safeguard for affected relinked-transaction matching and a reachable user-assisted recovery workflow are required before production activation. Nothing of this is implemented: the behaviour described in this question is today's. (amended 2026-10-09, I3A-R packet 2-A: the review safeguard and a reachable recovery workflow now exist as a local candidate, `PHASE_B_I3A_R_PACKET_2A_REVIEW.md`. In the example K still reads `untracked / removed_card`, −370: the hold already withholds its pair with Y, so the safeguard has nothing left to withhold, and the user can match K from its review. Where the leg comes back on its original date the pair is withheld and K reads a range. No hold is ended and no record retired by either.)

**Still open from earlier revisions:**

8. **A role change made after the removal.** If the user re-classifies a preserved decision's surviving leg away from card payment, the leg stops being a card leg and the decision holds nothing. If they later re-classify it back, the decision applies again: nothing superseded it. Design acceptance test 19 gives that to the role endpoint ("decisions are invalidated in the same RPC"), which is not built.
9. **No recovery path** after a failed final evaluation (§4), and **no evaluation after the backend's follow-ups** (the repair sweep can make the user stale again). Both are later work and release gates.
10. **The warning on the confirmation screen** ("Payments from your other accounts to this card will count as money leaving your tracked accounts") is not shown yet. No API change is needed for it.

## 10. Not in I3A

- Retry-on-read and background recovery.
- An evaluation after the removal's follow-ups, and after other user actions.
- The role-override endpoint and UI, the transfer-correction UI, the review queue and feed pagination. Any UI for a preserved decision (it is undoable through the existing RPC).
- Disconnect-and-keep-history and account archiving.
- The Phase A backfill, hosted preflight, production migration and flag activation.

**Release notes for later gates:**
- A removal made before the role backfill can only preserve pairs between rows that are already classified as card payments.
- The backfill's "one evaluation per user" also proves the evaluator runs for every user, which removal now relies on.
- The hosted statement timeout must allow a removal's two evaluations for the largest user (§11).
- A recovery path must exist for a user left stale by a failed final evaluation (§4).
- Rolling back `20261006110000` after a removal has preserved a user pair degrades those payments to "can't tell". While live holds exist it does more: a payment with a known figure reads unresolved, and other payments can gain, lose or switch an automatic match. The script refuses then, unless the operator acknowledges it in the session (§7). Prefer rolling back `20261006120000` alone (amended 2026-10-08, I3A-R packet 1: "alone" is without the rollback of `20261006110000`. With `20261008120000` applied, its own rollback has to run first: §7).
- Any later migration that replaces `evaluate_card_payments` must replace, or guard on, `remove_plaid_item_local` in the same file: the removal reads the evaluator's scratch tables (§7).
- Revision 5 replaced both candidate migration files in place. A local database built from an earlier candidate must be rebuilt (§7).
- §9.3, question 7, must be decided before release: after a removed institution is linked again, a held payment can keep reading a definite removed-card figure although both cards are linked, until the user matches it. (amended 2026-10-09, I3A-R policy: the governing policy is recorded under the status. What has to exist before production activation is the review safeguard for affected relinked-transaction matching and a reachable user-assisted recovery workflow; neither exists yet.) (amended 2026-10-09, I3A-R packet 2-A: both exist as a local candidate that is not reviewed, committed or released. Its own release gates are in `PHASE_B_I3A_R_PACKET_2A_REVIEW.md` §13.)

## 11. Performance

**These are local measurements on synthetic data, for a report. They are not production latency guarantees.** The review classified the increase as a release and scale gate, not an I3A acceptance threshold.

`supabase/tests/card_payment_benchmark/removal/run.sh`, one throwaway Supabase Postgres 17.6 container, Docker Desktop on Windows, `fsync` and `synchronous_commit` on, default `shared_buffers` (128 MB). Transcript, with every sample, the counts and the plans: `supabase/tests/card_payment_benchmark/removal/results/2026-10-07_revision5.txt`.

**Read this first.** Revision 5 was measured on 2026-10-07, with 8 CPUs. For the **same** code the machine was about twice as slow that day as on 2026-10-06: the unchanged released removal took 46.9 / 409.1 / 2,122.5 ms, against 23.7 / 207.2 / 1,037.8 recorded the day before. The cause was not established. So the revision 4 numbers recorded earlier cannot be compared with these. Instead the revision 4 candidate was **measured again on the same machine and day**, from its archived tree, and that is the baseline below. The function bodies measured are the final ones of revision 5 (`remove_plaid_item_local` `7997a757…`, `evaluate_card_payments` `6cb5e299…`): the self-review changed no function body. (amended 2026-10-08, I3A-R packet 1: `20261008120000` installs another removal body. Nothing in this section measures it.)

**Base fixture** (unchanged). N transactions on the removed institution (a card and a checking account) and N on a kept one. N/100 payments from the kept checking account to the removed card (tier 1 pairs) and as many to a kept card. No user decision, no unresolved payment and no competitor, so no hold is written: the user-pair statement and the hold statement are measured at their fixed cost.

Five measured samples after one warm-up at each size, with no other container running; medians, in milliseconds.

| N (transactions on the removed institution; the user has 2N) | Released removal | Revision 4, measured again | Revision 5 | First evaluation | The three preservation statements | Delete | Final evaluation |
|---|---|---|---|---|---|---|---|
| 1,000 | 46.9 | 137.1 | 134.9 | 42.1 | 16.1 | 41.9 | 25.3 |
| 10,000 | 409.1 | 930.8 | 904.5 | 287.0 | 28.7 | 402.5 | 161.5 |
| 50,000 | 2,122.5 | 4,411.7 | 4,442.4 | 1,439.0 | 85.9 | 2,082.7 | 859.4 |

- **Against revision 4 on the same machine and day,** the whole removal is within 3% at every size (−1.6%, −2.8%, +0.7%). That is inside the spread of the samples.
- **Statement (c)** now reads the evaluator's scratch tables and not the published states. The three preservation statements together cost 2.0 / 3.7 / 8.9 ms more than revision 4's. The statement plans a 15-relation join (6 to 8 ms of planning); its plan uses hash joins, scans only the pool of card-payment legs sequentially, and never the scratch table of all transactions (the plans are in the transcript).
- **The two whole-user evaluations are most of the added cost,** as before: the candidate takes 2.88 / 2.21 / 2.09 times as long as the released removal (revision 4, measured again: 2.98 / 2.30 / 2.15). **The delete is as it was.**

**Hold-heavy fixture** (new: `BENCH_FIXTURE=hold_heavy`). Every payment to the removed card also has a same-amount leg on the kept card, three days later. That is the decision 14 case for every payment: the removal writes N/100 records **and** N/100 holds.

| N | Revision 5, base fixture | Revision 5, hold-heavy | Difference | Statement (c) | First evaluation | Final evaluation |
|---|---|---|---|---|---|---|
| 1,000 | 134.9 | 152.4 | +17.5 (+13%) | 6.9 → 8.6 | 42.1 → 47.9 | 25.3 → 33.4 |
| 10,000 | 904.5 | 1,081.8 | +177.3 (+20%) | 9.1 → 19.2 | 287.0 → 354.9 | 161.5 → 261.5 |
| 50,000 | 4,442.4 | 5,642.7 | +1,200.3 (+27%) | 13.3 → 64.5 | 1,439.0 → 1,764.5 | 859.4 → 1,636.8 |

- **Writing a hold costs about 0.1 ms** (statement (c): +51.2 ms for 500 holds), as an insert with its triggers and foreign keys does.
- **The larger differences are in the two evaluations, and they are mostly not the holds.** This fixture has N/100 unresolved card legs on the kept card before and after the removal, and the evaluator scans the opposite side of the pool once for each unresolved leg. The first evaluation pays that too, with no hold anywhere. A per-statement attribution of the final evaluation at 50,000 is at the end of the transcript: of about 880 ms more there, about 290 ms is that candidate scan, about 170 ms is the evaluator's tier 1 statement choosing a nested loop over its own CTE (an existing plan choice), and about 40 ms is specific to the holds (the decision loop over 500 holds, the statement that withholds their pairs, their decision states). The rest is 500 more legs and per-statement overhead.
- **Not measured: revision 4 on this fixture.** There revision 4 writes no hold and lets the kept card take the payment — the behaviour decision 14 corrects — so its final evaluation has no unresolved leg, and it would be cheaper.

**Not measured at all:** hosted hardware, PostgREST and network overhead, the hosted statement timeout, concurrent load, and histories with many live user decisions.

## 12. Validation run

2026-10-07 (2026-10-08 UTC), on the final candidate, **after** the self-review and its corrections. Disposable local containers only (`public.ecr.aws/supabase/postgres:17.6.1.155`); no hosted database, no provider.

- No file under `supabase/` or `backend/src` changed while the checks ran. The negative controls and the two negative runs against revision 4 ran afterwards on the same files.
- The one file under `supabase/` written after the checks is the controls' results file. This section and §11 were written after them too.
- An earlier full run of revision 5, made before the self-review, is kept in the review evidence. It is not what this table reports.
- The benchmark of §11 was not repeated after the self-review: no function body changed in it.

| Check | Result |
|---|---|
| The removal tests: `a18`–`a25`, `c26`–`c36` | **19 passed, 0 failed** |
| The same tests without `20261006120000` (the released removal body, the new kinds available) | **0 passed, 19 failed** — expected |
| The tests that state revision 5's corrections (`a21`, `a23`, `a24`, `a25`, `c36`) against the revision 4 candidate | **0 passed, 5 failed** — expected, each on the behaviour (below) |
| The reference evaluator's tests (130) against the revision 4 reference evaluator | **19 failed, 111 passed** — expected: the 17 P2 scenarios, the invariants test and the vacuity guard |
| The full access-control suite | **61 passed, 0 failed** |
| The lock comparison (`supabase/tests/lim_removal_lock_comparison`) | **all 11 cases as documented**, unchanged: transaction rows deadlock under both bodies; both account-row overlaps wait under both bodies |
| Evaluator equivalence (`supabase/tests/card_payment_evaluator`) | **794 user evaluations, 0 differ** (300 generated histories, 97 scenarios). 21 scenarios (42 user evaluations) are also checked against hand-derived outcomes: 0 differ. RPC sequences: 15 scenarios, 42 user evaluations, 0 failures |
| Migration replay (emulator tier and the pinned Supabase CLI 2.117.0, local containers, on an LF copy in WSL) | **11 passed, 0 failed** |
| Card-payment audit | PASS |
| Upgrade / rollback / re-apply rehearsal | passed: 24 steps, fifteen snapshots |
| Negative controls | **63 controls, all as expected: 60 detected by the named assertions, 3 survive by design.** Every control, with its expectation and its outcome: `supabase/tests/lim_removal_matching_mutations/results/2026-10-07_revision5.txt` |
| Backend typecheck / full suite / build | pass / **46 files, 1612 passed, 3 todo** / pass |
| `git diff --check` over the whole candidate, untracked files included | clean |

**Against the revision 4 candidate,** each of the five tests fails on the behaviour it states:

| Test | Where it fails on revision 4 |
|---|---|
| `a21` | case E-undo: revision 4 switches the automatically matched payment to the kept card |
| `a23` (P1) | B, C, F, G, H, I, INV, N, N2 — 21 of 39 requirements |
| `a24` (P2) | C-amount, G-amount, L-amount, R-amount and all seven M-disqualifiers — 20 of 65 requirements |
| `a25` (decision 14) | A, D, E, E2, F-amt, F-date, F-own, G, G-card, G-date, G-two, H, J, K-ce, K-e, K-xe, L, N, O, O2, O3 — 39 of 65 requirements |
| `c36` | the removal writes no hold that names the kept card account |

`a22` also changed in the self-review (cases R, S, T). Those state behaviour revision 4 already had, so `a22` is not in this set.

**The sixteen controls that name `a22`** (the hold), each detected by `a22`'s final assertion, which names the violated cases. "Held cases" are A, B, C-amount, C-date, C-new, C-posted, D, E, F, G, M and P.

| Control | What is wrong | Violated cases of `a22` |
|---|---|---|
| `ambiguity_hold_omitted` | the removal writes no hold | the held cases, and T |
| `hold_without_a_removed_candidate` | a hold for every unresolved payment | every case: the held cases, N, R, S and T |
| `hold_records_the_wrong_date` | the kept candidate's date instead of the removed one's | P |
| `hold_kind_swapped` | the wrong leg named as the one the removed candidate competed for | the held cases, and T |
| `hold_not_deduplicated` | a second removal writes the same hold again | G (and `a25` H) |
| `hold_removed_candidate_window_widened` | a removed leg up to sixty days away counts as a removed candidate | S |
| `hold_for_a_dismissed_removed_candidate` | a removed leg the user dismissed counts as a removed candidate | R |
| `hold_for_a_dismissed_kept_candidate` | a kept leg the user dismissed gets a hold (as implemented: §9.3, question 2) | T |
| `eval_hold_does_not_withhold` | the hold is read but the pair is formed anyway | the held cases but P |
| `eval_hold_released_by_posting` | a hold applies only to the very rows it was recorded on | C-posted |
| `eval_hold_publishes_an_effect` | a held payment reads like a known removed-card destination | the held cases |
| `eval_hold_user_strength` | held legs are taken out of automatic matching | the held cases |
| `eval_hold_ignores_date_changes` | never released by a date change | C-date, M, P |
| `eval_hold_ignores_amount_changes` | still applies after an amount correction | C-amount |
| `eval_hold_blocks_any_pair_of_its_legs` | withholds a pair with a new or relinked leg too | C-new |
| `eval_hold_overrides_user_decision` | a user decision on a held leg reads as conflicting | D |

Several of them name `a23` or `a25` as well; the results file has every list. (amended 2026-10-08, I3A-R packet 1: `hold_not_deduplicated` is no longer a wrong version. Under `20261008120000` a second removal does write that hold again, and the wrong version is the one that merges.)

**The three controls that survive** are redundant safeguards, and each says so in its definition:
- `no_user_filter` — the automatic-pair statement does not re-check the owner of either account. The states it reads were written for this user only, and the insert trigger `card_payment_decisions_same_user` refuses a record on another user's account (`a19` asserts that refusal).
- `no_survivor_filter` — cash legs on the removed institution get a system record too. Such a record is deleted with its account by the cascade, in the same transaction.
- `hold_no_user_filter` — the hold statement does not re-check the owner of its three accounts. The pool it reads was filled for this user in this transaction, and the same insert trigger re-checks both accounts.

**Not run:** the frontend suites (no frontend file changed); the Phase A harness and the read-path integration harness (nothing they test changed).

## 13. For commit packaging

The review asked for the new harness scripts to be committed with mode `100755`. This clone has `core.filemode = false`, so Git does not take the executable bit from the working tree: the mode has to be set when the files are staged (`git add --chmod=+x <file>`). Nothing is staged now, and the identities in the evidence are of file contents only. Every harness is run as `bash <path>`, so the mode is not what makes them work; of the ten harness scripts already tracked, only `phase_a/run.sh` is `100755`.

- `supabase/tests/lim_removal_matching_mutations/run.sh`
- `supabase/tests/lim_removal_matching_rehearsal/run.sh`
- `supabase/tests/card_payment_benchmark/removal/run.sh`
- `supabase/tests/lim_removal_lock_comparison/run.sh`
