# Card-Payment Pairing — resolving Phase B §13 R3 (design proposal, rev 3)

Status (updated 2026-10-01): **design rev 3, approved product choices; partly implemented on draft
PRs, nothing merged or released.**
- The reference engine (§3.8 oracle, draft PR #8) and the §3.5 tables, §3.7 triggers, SQL evaluator
  and reader (migration `20260930120000`, draft PR #9) exist. They are disconnected from the app and
  applied only to throwaway test databases.
- The decision RPCs of §8 are slice 2b-1.
- **Not built:** the sync and LIM integration, the §3.7 aggregation read protocol, the §5 module
  change, the API and frontend, and the backfill. The live app's cash flow is unchanged.
- Details and verification: `PHASE_B_MATCHING_ENGINE_HANDOFF.md`.
- **Since (2026-10-03, integration slice I1 — an implementation candidate pending independent
  re-review, nothing merged or released):** the §5 module change and the aggregation's read exist in
  the backend read path. See `PHASE_B_I1_BACKEND_READ_PATH.md`.
  - **The read differs from §3.7's "aggregation's read protocol" (amended by Trevor, 2026-10-03).**
    Instead of reading the states, paging the transactions and reading the version again, the
    application reads the states AND the transactions in one statement
    (`get_financial_read_snapshot`, which calls `get_card_payment_states` on its own snapshot). Fresh
    states then describe exactly the rows beside them, and inputs the matching version does not watch
    (principal, the loan link, categories, splits) are coherent too. The freshness rule itself is
    unchanged. `inputs_changing` is no longer reachable in that implementation.
  - **Credit-side `unresolved` legs** are published as "unresolved card credits"
    (`card_payments_unresolved_credit`), never as externally funded; their effect stays 0 (D5).
  - Retry-on-read, the removal integration, the frontend and the backfill are still not built.
- **Since (2026-10-06, integration slice I3A — an implementation candidate under independent review,
  nothing merged or released):** the removal integration of §4.7 (T9, acceptance test 18) exists in
  migration `20261006120000`, which replaces the body of `remove_plaid_item_local`. See
  `PHASE_B_I3A_LIM_REMOVAL_MATCHING.md`. Trevor's decisions of 2026-10-06 settle what the first
  review left open. All are implemented in the candidate:
  - **Evaluation failures (§3.7).** The evaluation *before* the delete is strict: if it fails, nothing is
    removed. The evaluation *after* the delete is best-effort, like every other RPC's closing
    evaluation: if it fails, the removal still commits and the user is stale.
  - **Explicit user confirmations (§3.2, §3.5, §4.7).** A user-confirmed pair with an account that is
    removed survives as the user's own decision on the leg that is left — a new, additive decision kind,
    `pair_counterpart_removed` (migration `20261006110000`) — and keeps holding that leg, active or
    inactive, on either side. The system record `destination_removed_card` is unchanged and is used
    for automatic pairs only. A confirmation whose removed side was invalid for a reason other than an
    amount stays invalid whatever the surviving leg's amount later does.
  - **Lock order (§3.7).** The removal locks the removed institution's account rows before it takes the
    version row, as the released removal did.
  - **A tie the removal would break (§3.2, §3.5, §4.7).** An unresolved leg does not become resolved
    because one of its candidates was deleted: removal is not evidence. For a leg whose candidates were
    on both sides of the removal, the removal records a **system ambiguity hold** on the pair that is
    left — two additive decision kinds and one date column, also in migration `20261006110000`. A hold
    publishes no effect, is not a user decision and has no user-strength precedence. It ends by itself
    when the evidence changes, or when the user decides. The rule is about the matching evidence, not
    about what a reader is shown: a leg on an account excluded from cash flow is covered like any other.
  - **An automatic match the removal would switch (§3.2, §4.7; "Option B").** A payment that was
    automatically matched to a card of the removed institution keeps its recorded destination. It does
    not switch automatically to another card that was already there, solely because the original
    destination disappeared: the same hold, on that pair, withholds it. No new kind, column or evaluator
    rule was needed.
  - Retry-on-read, background recovery, evaluation after other user actions and the backfill are still
    not built.
- **Since (2026-10-08, I3A-R packet 1 — an implementation candidate awaiting independent review,
  nothing merged or released):** migration `20261008120000` replaces the body of
  `remove_plaid_item_local` again and adds two tables. See `PHASE_B_I3A_R_P1_REMOVAL_PROVENANCE.md`.
  - **One system row for each removed transaction it depends on (§4.7).** A removal no longer merges a
    record or a hold into one that is already live, nor two holds with one date into one.
  - **Provenance (§3.5).** Every decision a removal writes gets one row that names the removal and the
    removed account and transaction it depends on. Nothing reads it.
  - No published reading changes, and nothing is settled: no hold is ended, no record is retired, and
    what §4.7 leaves for a decision is as open as it was.
- **Policy amendment (2026-10-09, I3A-R; recorded following the independent audit of I3A-R packet 1).**
  The policy had already been approved before that audit and was supplied in the original audit
  request. This amendment records that existing approval; it does not create a new one. 2026-10-09 is
  the date of this amendment, not of the approval. It governs what §4.7 leaves for a decision about a
  removed institution that is linked again, and anything in this document that conflicts with it.
  - **P-Y.** Permanent release of a historical matching protection requires explicit user
    authorization, scoped to the relevant source or dependencies.
  - **P-D.** Retirement of removed-destination evidence requires separately identifiable
    authorization. P-Y does not implicitly authorize P-D. A single, clearly explained review workflow
    may collect both permissions, but their meanings and the recorded authorization stay distinct.
  - Reliable account/event correspondence is evidence, not consent. Similar institution, mask, amount and date—even an exact descriptive match—do not establish reliable correspondence by themselves.
  - **Before production activation** a narrowly scoped review safeguard for affected
    relinked-transaction matching, and a reachable user-assisted recovery workflow, are required.
  - **I3A-R packet 1 implements provenance capture only.** No settlement, no user recovery, no review
    safeguard, no production activation.
  - Current implementation examples include system ambiguity holds for P-Y and `destination_removed_card` records for P-D. These are nonexclusive examples, not definitions limiting policy scope. P-Y requires explicit authorization for permanent release of the named historical matching protections and their source dependencies. P-D requires separately identifiable authorization to retire removed-destination evidence. Neither permission grants the other. User-confirmed decisions and reservations retain their separate precedence and undo/supersession rules.
  - *Historical:* the older text recorded the question as unresolved; that text is kept, and marked.
    *Superseded where it conflicts:* any route by which a historical matching protection is permanently
    released, or removed-destination evidence retired, without the user's authorization, including the
    automatic "exact return" route of the I3A-R roadmap. The places this touches are marked
    "amended 2026-10-09, I3A-R policy".
- **Since (2026-10-09, I3A-R packet 2-A — a local implementation candidate awaiting independent
  review, nothing committed, merged or released):** migration `20261009120000` replaces the bodies of
  `evaluate_card_payments`, `remove_plaid_item_local` and `get_card_payment_states` and adds nine
  tables. See `PHASE_B_I3A_R_PACKET_2A_REVIEW.md`. It implements the review safeguard and the
  user-assisted recovery workflow that the policy amendment above requires before activation, on
  Trevor's approval of 2026-10-09.
  - **The review safeguard (§4.7).** A surviving payment that had an eligible candidate on the removed
    institution is an *affected payment* — read from the evaluator's complete pool before the delete,
    whether or not the removal wrote a hold or a record about it (a payment whose candidates were all
    removed gets neither, and is affected all the same) — and so is the surviving leg of a preserved
    user confirmation. After tier 1 and the holds, an automatic pair with an affected leg stays only if every
    review obligation on either leg lists that pair as one that survived the removal. Otherwise it is
    withheld in both directions and nothing is selected in its place. A new transaction and the
    re-imported leg of a relinked card are never listed.
  - **Publication.** A withheld leg is published before the record `destination_removed_card`, which
    stays stored: an included cash leg reads `unresolved / relink_review_required`, a range from
    min(0, −cents) to max(0, −cents), where an included card exists, and `untracked /
    no_included_card` where none does; an included card leg reads `unresolved /
    relink_review_required`, 0; a leg on an excluded account reads `not_counted / excluded_account`.
  - **Nothing is retired.** No hold is ended, no record is retired and no obligation is discharged.
    P-Y and P-D are not implemented. The user decides the current payment with the decisions that
    already existed (§3.5); those RPCs are unchanged.
  - *Superseded where it conflicts:* every statement of this document that a new transaction or a
    re-imported leg pairs "by the ordinary rules" with an affected payment. The places this touches
    are marked "amended 2026-10-09, I3A-R packet 2-A". Acceptance tests whose stated expectation
    this changes are listed in that document, §14; their files were updated in the correction pass
    of the same date.

*Original status line (rev 3, 2026-09-29), kept for history:* proposal for review — nothing
implemented. There is no migration, endpoint or live-calculation change.

The document completes option (a) of `FINANCIAL_SEMANTICS_PHASE_B_DESIGN.md`
§13 R3 while preserving D5. **Trevor approved the first-version product choices on 2026-09-29**
(§10). Two items are deferred and not part of this release: recurring destination rules (T8) and
the payment-and-return shortcut. Acceptance tests are in §11. The read-only audit draft is `supabase/preflight/phase_b_card_payment_matching_audit.sql`
(§9). It has **not** been run against production, and has been validated only against synthetic rows
in a throwaway local container.

**Changes in rev 3** (Trevor's decisions; Codex review of 14e7bc7):

1. **Decisions recorded** (§10): T1–T7 and T9 approved as recommended; T8 deferred. The
   `same_destination` payment-and-return shortcut is **removed** from this release. Users confirm
   individual transactions, and there is no cross-month cancellation.
2. **Inconsistent reads return "Updating", never figures** (§3.7). Suppose, after the retries, the
   transaction rows and the card states still do not come from one version. Then the aggregate
   returns a retryable `updating` result with no totals and no ranges.
3. **The evaluator's lock order and version publication** are specified (§3.7).
   - It locks in a fixed order: the per-user advisory lock, then the user's version row.
   - It publishes exactly the version it read under that lock, which is the version of the inputs it
     evaluated. It never re-reads the version afterwards.
   - It writes only derived tables, which have no foreign keys to data rows, so it cannot deadlock
     with a lock-free writer.
4. **Confirmed differences are reported separately from unresolved exposure** (§9). The audit gains
   `proposed_effect` and `confirmed_difference`. A new regression, R7, is added to both the audit and
   the pure-module tests: checking +100 Sep 1, included card −100 Sep 3, excluded card −100 Sep 2.
   Slice 1 gives 0. The approved matching rule gives −100, with zero unresolved exposure.

**Changes in rev 2** (Codex review of 5a6e831):

1. **No automatic "proof of absence".** Ten days plus a successful sync was a heuristic. A
   counterpart may exist but be misclassified, farther away than 60 days, or differ by more than $5.
   A payment with no confirmed destination stays unresolved until the user confirms it (§3.4).
   Rejecting a candidate never implies "unlinked card". (T4 is now decided — §10.)
2. **Atomic invalidation** (§3.7). Every input change bumps a per-user version in the writer's own
   transaction. Derived states are readable as resolved only when they were computed at exactly
   that version, so a failed or late evaluation can never expose a stale resolved total.
3. **Pending → posted** (§3.6, §4.8). User decisions are keyed by transaction *lineage*, not by
   foreign keys to transaction rows. No cascade can erase a confirmation that a later posted
   replacement needs, and every arrival order resolves identically.
4. **Audit corrected** (§9):
   - a NULL account type is the cash side;
   - surrounding evidence now reaches 60 + 2×5 days;
   - current and projected classification are reported separately;
   - live, slice-1 and exposure effects are separate columns;
   - payments to excluded cards count as confirmed, not exposure.

   Synthetic regression cases cover each point.
5. **Fee differences fully specified** (§4.3): both directions, either side larger, excluded
   partners. Same-user ownership and concurrency tests are added (§11).

---

## 1. The problem, and what must stay true

R3 (Codex's reproduction, pinned by tests in `semanticAggregation.test.ts`):

| Rows (checking C, included card X) | Cash flow today | Correct |
|---|---|---|
| C +100 Sep 1, X −100 Sep 2, X +100 Sep 10, C −100 **Sep 16** | **+100** | 0 |
| C +100 Sep 1, X −100 **Sep 7** | **−100** | 0 |

These must not change:

- **D5 and the tracked-set principle** (Phase B §4.1, §4.3). A card payment moves cash flow only
  when money crosses the boundary of the accounts included in cash flow:
  - a payment to an unlinked or excluded card is an untracked outflow (−);
  - its return is an untracked return (+);
  - a card leg funded from outside is informational (0).
- **The definition of cash flow.** The audit (§9) sizes the exposure. It never changes the
  definition, and neither does how common a case turns out to be.
- **No silent widening of the ±5-day automatic window.** Anything beyond it is a suggestion that
  the user confirms.

## 2. The key observation

Under D5 **a credit-side leg never moves cash flow**, paired or not. Only **cash-side legs** do, so R3
reduces to one question per cash-side leg:

> Did this money go to (or come back from) a card that is included in cash flow?

| Answer | Effect (D5, unchanged) |
|---|---|
| **Yes** — the counterpart is a leg on an included card | tracked: 0 |
| **No** — the destination is established to be outside the included cards | untracked: payment −amount, return +amount |
| **Not established** | **unresolved**: the truth is one of the two values above |

Today's module turns "not established" into "no" whenever no counterpart lies within ±5 days. That
is all of R3.

**Storing today's ±5-day pairs alone does not fix R3.** The Sep 7 and Sep 16 cases would stay
unpaired and still be counted as "no". The fix is to represent "not established" explicitly, to
accept only real evidence or the user's confirmation, and never to publish a single figure that
assumes an answer (§6).

**Transfers are unaffected.** Both unpaired transfer legs count by sign, so a missed pair nets to 0.

## 3. Model

### 3.1 Legs and the evidence pool

- A **card leg** is a transaction whose `effective_role` is `credit_card_payment`.
- Sides and directions:
  - **Credit side:** a leg on an account of `type = 'credit'`.
  - **Cash side:** a leg on any other account, **including one whose type is NULL**. This is exactly
    the rule in `semanticAggregation.ts`.
  - **Direction:** on the cash side + is a payment and − a return. On the credit side − is a payment
    and + a reversal.
- **Evidence pool:** every card leg on every linked account of the same user, **including excluded
  accounts** *(T5)*.
  - The pool decides *where* money went.
  - The tracked-set principle decides the *effect*.
  - A leg on an excluded cash account is never counted in cash flow; it only serves as evidence.
- A pending row superseded by its posted replacement is **not** in the pool (§3.6).

### 3.2 States of a cash-side leg

| State | Reason | Effect | Established by |
|---|---|---|---|
| `tracked` | `auto_pair` | 0 | Tier 1 pair (§3.3) with a leg on an **included** card |
| `tracked` | `user_pair` | 0 (fee remainder §4.3) | User-confirmed pair with a leg on an included card |
| `untracked` | `partner_excluded` | payment −, return + | Tier 1 or user pair with a leg on an **excluded** card |
| `untracked` | `no_included_card` | payment −, return + | The user has no included credit account at all, so no leg can be tracked |
| `untracked` | `user_confirmed_unlinked` | payment −, return + | The user said "this went to a card I haven't linked" — for this transaction |
| `untracked` | `removed_card` | payment −, return + | Its pair's card was removed through LIM; preserved in the removal transaction (§4.7, T9): by the system record for an automatic pair, by the user's own preserved decision (`pair_counterpart_removed`) for a pair the user confirmed |
| `unresolved` | `no_candidate` | one of the two | No candidate within the suggestion limits. The text varies with the leg's age and sync status |
| `unresolved` | `possible_match` | one of the two | An exact-amount candidate the automatic rule cannot use |
| `unresolved` | `amount_differs` | one of the two | A near-amount candidate |
| `unresolved` | `ambiguous` | one of the two | An exact candidate within 5 days, but a tie or not reciprocal — or the one pair that is left is withheld by a system ambiguity hold, because another candidate was removed with its institution (§4.7) |
| `unresolved` | `matched_leg_not_posted` | one of the two | A user decision whose other leg is still waiting to post (§3.6) |
| `unresolved` | `decision_invalidated` | one of the two | A user decision whose leg changed amount or role (§3.6) |
| `unresolved` | `ambiguous_replacement` | one of the two | More than one posted row on the same account names this leg's pending id (§3.6, approved rule of 2026-09-30). Applies ahead of every precedence step below |

Rules that apply throughout:
- **Precedence**, when several apply to one leg:
  1. an active **user** decision (a pair, a confirmed unlinked destination, or a pair preserved after
     its other account was removed — `pair_counterpart_removed`, §4.7);
  2. then a **tier 1** pair — unless a system ambiguity hold withholds exactly that pair (§4.7). A hold
     is not a step of its own: it gives a leg no state and no effect. It only keeps a removal from
     turning an old tie into a match, or from switching an automatically matched payment to a card that
     was already there — that payment then falls to step 3 and reads its record;
  3. then `destination_removed_card` (system-written by a removal, §4.7);
  4. then `no_included_card`;
  5. otherwise unresolved.

  If a tier 1 pair or suggestion contradicts an active user decision, the user decision stands and
  the contradiction is shown as a suggestion ("Sapphire is now linked and shows a matching credit —
  match?"). Automation never overrides the user.
  - *Approved 2026-09-30:* this includes qualifying evidence on an **excluded** card against a
    payment the user marked as going to an unlinked card, even though confirming that destination
    would leave the cash-flow effect unchanged.
  - The confirmation and its effect stay unchanged until the user acts.
  - The candidate keeps its evidence kind and `contradictsDecision`.
  - *(Cosmetic, not a financial rule: future wording may say "Possible match on an excluded card".)*
- **Stale states are never legs' states.** If the states are older than the inputs, no leg state
  is returned at all: the whole card-dependent result is `updating` (§3.7).
- **No state means unresolved.** With fresh states every card leg has one, so a missing state is an
  integrity failure, reported as such. It is never read as untracked.
- **Credit-side legs** are labelled only: `paired`, `funded_from_excluded`, or unresolved with the
  same reasons. Their cash-flow effect is always 0 (D5).

### 3.3 Evidence rules

**Tier 1 — automatic pairing (today's rule).**
- The match: exact opposite cents, opposite side, |days| ≤ 5.
- It must be reciprocal: the closest candidate wins, a tie is ambiguous, and each leg must be the
  other's best match.
- It runs over the user's full history and the §3.1 pool, and its results are stored (§3.5).

**Tier 2 — suggestions (never applied automatically).** For a leg left unpaired by tier 1, a
suggestion is an unpaired opposite-side leg in the pool of one of these shapes:
- exact amount 6 – H days away, with H = 60 *(T2)*;
- near amount within 5 days, differing by 1 cent to $5.00 *(T2)*;
- *return-of-pair*: a cash-side return and a credit-side reversal of equal cents on the same two
  accounts as an earlier tracked pair, dated after it *(T3)*.
  - *Approved 2026-09-30:* the refund and the card reversal may be **up to 60 days apart**. The
    original payment may be older, with no limit.
  - It is a suggestion requiring confirmation. Manual matching is unrestricted by distance.
  - Within 5 days, the existing automatic tier 1 rule still pairs a return. No automatic window is
    widened.

**The manual picker has no limits.** The user may also choose any unpaired opposite-side card leg of
their own, at any distance and any amount. A difference is shown and must be accepted explicitly
(§4.3). The limits only control what is *suggested*.

**Rejecting a suggestion** (`not_this_pair`) removes that one candidate. The leg stays unresolved,
either with the next candidate or as `no_candidate`. It never becomes untracked.

A tier 1 pair can **dissolve** when a later row creates a tie *(T7)*. A user decision is changed only
by the user, or invalidated (not deleted) by an amount or role change (§3.6).

### 3.4 No automatic absence

A leg becomes `untracked` only through evidence or the user:
- **Evidence:** a pair whose partner is outside the included cards, or the fact that the user has no
  included credit account.
- **The user:** an explicit confirmation of the destination for that transaction. A LIM removal
  converts an existing pair (T9).

Nothing else makes a leg untracked. In particular, none of the following does:
- the passage of time;
- the absence of a candidate within the limits;
- a card's successful sync;
- the rejection of a candidate.

Each of those is consistent with a counterpart that exists but was misclassified (e.g. the
`LOAN_PAYMENTS` fallback to `debt_payment`), lies beyond H, or differs by more than $5.

**The consequence is deliberate.** A user who has at least one included card and pays a card that
isn't linked must confirm each such payment once. A return is confirmed on its own, like any other
transaction. Recurring rules (T8) and the payment-and-return shortcut are deferred.

**T4 — decided (Trevor, 2026-09-29):** there is no automatic "unlinked" assumption based on elapsed
time or sync status.

### 3.5 What is stored

All new tables:
- are service-role only (RLS on, no policies, no `anon`/`authenticated` privilege);
- are written under the per-user advisory lock;
- are owned by one user, with every row's accounts belonging to that user (§11 ownership tests).

**`card_payment_decisions`** — what the user decided. It has **no foreign key to `transactions`.**
- Columns:
  - `id`, `user_id`;
  - `kind`: `pair` | `not_this_pair` | `destination_unlinked` | `destination_removed_card` |
    `pair_counterpart_removed` *(added 2026-10-06, §4.7: a USER decision — the user's pair after the
    account of one of its legs was removed; written only by the removal)* |
    `ambiguity_hold_removed_card` | `ambiguity_hold_removed_cash_account` *(added 2026-10-06, §4.7: SYSTEM
    ambiguity holds on one possible pair of two legs that both survive; written only by the removal)*;
  - leg A: `a_account_id`, `a_plaid_transaction_id`, `a_cents`;
  - leg B (null for single-leg kinds): the same three columns. For `pair_counterpart_removed`, leg A is
    the leg that **survived** and leg B keeps only the **removed** leg's Plaid id and cents: `b_account_id`
    is null, because that account no longer exists and nothing may reference it
    *(amended 2026-10-08, I3A-R packet 1: that is the decision row. More of the removed leg and of its
    account is kept beside it, in `card_payment_removal_sources`, below)*. For an ambiguity hold, leg A
    is the card-side leg and leg B the cash-side leg of the possible pair, both on accounts that exist;
  - `counterpart_status` (`pair_counterpart_removed` only): what was true of the removed side when its
    account was deleted, frozen — `valid`, `waiting_to_post`, or the reason the confirmation was invalid
    on that side. A reason other than `amount_changed` is read before the surviving leg's own amount
    and role (§4.7);
  - `counterpart_date` (the two ambiguity holds only): the date of the candidate that was removed. Nothing
    else of that candidate is kept on the hold *(amended 2026-10-08, I3A-R packet 1: the hold's row in
    `card_payment_removal_sources`, below, keeps more of it)*;
  - `difference_cents` (pairs only; `|a_cents| − |b_cents|`, signed by which side is larger);
  - `created_at`, `decided_seq`, and `superseded_by` (for undo history).
- Leg references use the **Plaid id at decision time**. §3.6 maps them onto the current row.
- `*_account_id` references `accounts(id) on delete cascade`. That is safe: relinking an institution
  creates new accounts and new Plaid ids, so no replacement ever comes through a deleted account.
  The LIM removal RPC preserves what the pairs said *before* the delete (§4.7): a pair row itself still
  goes with its account.
- A foreign key to `transactions` would **not** be safe. Posting replaces the pending row on the
  same account, and a cascade would erase the confirmation the replacement needs.
- **Purge:** only when every referenced lineage has been `gone` (§3.6) for more than 30 days — the
  continuity retention, C2 — or by the user's own undo.

**`card_payment_removal_generations`** and **`card_payment_removal_sources`** *(added 2026-10-08,
I3A-R packet 1, migration `20261008120000` — a candidate awaiting review)* — which removed transaction each
decision that a removal wrote depends on. Written only by the removal, in its own transaction and
before its deletes; never backfilled. The service role may select and insert, nothing else.
- **One generation row per removal:** the removal's row in `plaid_item_removals`, the user, the removed
  item's institution id, and the removal's place in the user's order. A removal that finished without
  provenance gets a marker row from the next removal of that user.
- **One source row per decision a removal writes** — a preserved pair, a system record, a hold: the
  decision; the removal; what the removed transaction was to the surviving leg (the counterpart the
  user confirmed, its automatic partner, or a competing candidate); the removed account's Plaid id,
  type, subtype and mask; and the removed transaction's Plaid id, pending id, pending flag, date, cents
  and currency. For a preserved pair whose reference had no single current row, of the transaction
  only what was there instead: a carry-over's date and amount, or nothing.
- A source row is kept for as long as its decision row exists and is deleted with it; a generation row
  goes with the removal's row. No account name, balance or token is kept, and neither table references
  an account, an item or a transaction: the rows outlive the delete they describe.
- The Plaid ids are historical. A relink issues new ones, so these rows can show that two decisions
  share a source, never that a source has returned.
- Neither table is an input of §3.7, and nothing reads them.

**Derived tables** (recomputable at any time from inputs + decisions). They are written only by the
evaluator and carry **no foreign key** to `transactions` or `accounts` (only `user_id`). An FK
would make the evaluator take key-share locks on data rows, and could deadlock it with a lock-free
writer (§3.7). A stale reference is harmless: it is never readable, because the delete that made it
stale also bumped the version.
- **`card_payment_auto_pairs`** — tier 1 results.
- **`card_payment_leg_states`** — one row per card leg: `transaction_id`, `user_id`, `side`,
  `state`, `reason`, `partner_transaction_id`, `decision_id`, `candidate_ids`, `effect_cents`,
  `computed_at_version`.
- **`card_payment_eval_versions`** — one row per user: `input_version`, `evaluated_version`,
  `last_error_code`, `last_attempt_at`.

The continuity carry-over needs **no** new column: lineage resolution uses
`transactions.pending_transaction_id` and the existing carry-over records.

### 3.6 Lineage resolution (decisions across pending → posted)

A decision leg is (`user`, `account`, `plaid_transaction_id` P, `cents`). The evaluator maps it onto
the **current row**:

1. **A posted replacement exists.** If a row on that account of that user has
   `pending_transaction_id = P`, it is the current row, even while the pending row P still exists.
   That can happen when the posted row arrives before the removal. The pending row is then
   *superseded*: it is excluded from the pool and gets no state. If more than one row claims P, the
   decision is inactive (`lineage_ambiguous`), and the rows are held by the conflicting-replacement
   rule below.
2. **Otherwise, the row P itself exists** (pending or posted): that row is current.
3. **Otherwise the lineage has no current row.** It is `waiting_to_post` if an unexpired, unconsumed
   carry-over for P exists, and `gone` if not.

A decision is **active** only when all of these hold:
- every leg has a current row;
- each current row's cents equal the recorded cents;
- for a `pair`, both rows are card legs on opposite sides.

Otherwise it is **inactive**, with a reason, and is kept:
- `matched_leg_not_posted` — a leg is `waiting_to_post`;
- `decision_invalidated` — cents or role changed. The leg's state carries the message, for example
  "Card-payment match cleared: amount changed from 100.00 to 98.00" (the spirit of the continuity C1
  rule). The evaluator writes no transaction row, so it does not set `review_note` (§3.7 lock order);
- `partner_gone` — the other leg is `gone`.

An inactive decision normally leaves its counted card-payment legs unresolved, subject to the narrow
known-effect exception below. A `not_this_pair` decision only suppresses a
suggestion, so it applies whenever both legs have current rows, whatever the amounts.

**Changed user confirmations stay reserved — approved (Trevor, 2026-09-30).** The bank may change an
amount in a previously confirmed match. The affected entries then stay **reserved** while that
confirmation is inactive: they are never reused automatically to match a different payment, and never
offered as another payment's candidate. The account owner will review them through a guided in-app
interface. That is a user workflow, not routine developer review, and it is not built yet.

**Narrow known-effect exception — approved (Trevor, 2026-09-30).** A known cash-flow effect and an
invalidated confirmation are separate facts. The exception applies only when **all** of these hold:
- the confirmation is a user-confirmed unlinked destination (`destination_unlinked`);
- the only reason it is inactive is a **same-direction** amount correction (a payment stays a
  payment, a return stays a return);
- the leg is on an included cash account;
- the user has **no included credit account**.

Then the corrected effect is published, because it is established independently: no included card
could hold the money. The leg becomes `untracked` / `no_included_card` at the corrected amount (for
example $100 → $98 gives −$98). At the same time:
- the old confirmation stays **inactive** and visibly marked as needing review (`amount_changed` on
  the leg and the decision);
- the leg stays reserved against automatic reassignment.

The exception does **not** extend to:
- conflicting replacements or ambiguous lineage;
- changed roles;
- missing counterparts (waiting or gone);
- conflicting decisions;
- ownership failures;
- pair decisions;
- a direction change;
- any user who has an included credit account.

In all of those cases the narrow exception does not apply; the ordinary evaluation rules determine
the result. A row whose role changed away from `credit_card_payment` leaves this evaluator, and a
foreign-owned decision is rejected rather than attached to the user's payment. That payment may still
have a known effect from independent evidence, such as no included credit account. Counted card-payment
legs held by an inactive user decision otherwise remain unresolved; excluded-account legs are not counted.

This makes every arrival order resolve to the same result (§4.8), because the decision never
depended on which row object existed when it was made.

**Conflicting replacements — approved rule (Trevor, 2026-09-30).** Sometimes more than one posted
transaction on the same user/account names the same pending payment as its
`pending_transaction_id`. The matching of every such row then stays **unresolved** while the conflict
remains.
- **Scope:** the guard applies at the **lineage level**, whatever decision exists — a user pair, a
  destination confirmation, a system `destination_removed_card` decision, or none. No decision says
  which replacement is correct, and neither does its absence. A decision naming one of the rows by
  its own posted id is equally inactive (`lineage_ambiguous`).
- **What the rows get:**
  - leg reason `ambiguous_replacement` (detail `lineage_ambiguous`), with the approved per-period
    bounds {0, −amount};
  - no candidates;
  - no automatic match;
  - they are never another leg's partner or candidate.

  Rows on an excluded account keep the excluded-account treatment: not counted, and unmatched.
- **Never automatic:** conflicting bank transactions are never deleted, merged, or chosen between.
- **Recovery:** once a later snapshot has a single replacement, re-evaluation applies the normal rules
  with no manual action. Tier 1 matching, and any decision naming the lineage, apply again.
- **Different accounts:** rows on different accounts, or of different users, naming the same pending
  id are not a conflict (the lineage key includes the account).

**Future requirement (not built):** a conflict that **persists** needs a clear review path. The user
must be shown what the conflict is and how it can be resolved, without being asked to guess which
bank transaction is the real replacement. This design does not define that workflow; it must be
designed before the feature relies on user action here.

### 3.7 Atomic invalidation and read consistency

**Inputs** — everything a resolved state depends on:
- `transactions`: insert and delete; update of `amount`, `date`, `account_id`,
  `plaid_transaction_id`, `pending`, `pending_transaction_id`, `auto_role`, `user_role_override`;
- `accounts`: insert and delete; update of `type`, `exclude_from_cash_flow`, `item_id`;
- `plaid_items`: delete;
- `card_payment_decisions`: any change;
- `transaction_carryovers`: insert, delete, and update of `consumed_at` / `expires_at` (they
  distinguish `waiting_to_post` from `gone`).

Item sync status is **not** an input. It only changes the wording of a reason, and is read at display
time.

**Invalidation happens in the writer's transaction.** AFTER row triggers on each input table call
`card_payment_bump(user_id)`, which does
`input_version = input_version + 1` (upsert) in the same transaction as the change.
- **Coalescing (20261002120000).** A transaction bumps a user's version row once, not once per changed
  row. A bump is skipped only when all three of these hold:
  1. the transaction's own earlier bump still stands. A transaction-local, per-user marker equals the
     current transaction id.
  2. the row exists.
  3. the row is stale.

  Why that is safe, and what follows from it:
  - **Nothing can change meanwhile.** The earlier bump holds L2 until commit, or, if it created the
    row, holds that uncommitted row. So no other transaction can capture, publish or bump this user
    in between.
  - **The evaluator clears the marker.** It does this when it captures `v` (step 3). So a write after
    the capture always bumps, leaves the publication stale, and can never be coalesced into an earlier
    bump. A publication with no later write leaves the row fresh, so the next write bumps again.
  - **`input_version` advances at least once per input-changing transaction**, and again after each
    publication within it. Its exact value is not a contract; equality and the expected-version
    checks are.
  - **Each database connection keeps one setting name per distinct user it has bumped.** The value is
    cleared at every commit and rollback, but the name lasts for the connection's lifetime.
    `P2_C1_IMPLEMENTATION_HANDOFF.md` measures the cost.
- **The user** is found through the row → account → item.
- **Cascaded deletes are covered level by level.** A transaction delete whose account is already
  gone is covered by the account's own delete trigger, and an account whose item is gone by the item's
  trigger. Row-level triggers fire on cascaded deletes, so a LIM removal bumps the version (§11).
- **Coverage:** every writer — the new backend, an old backend during a rollback window, a direct
  PostgREST update, a backfill script — invalidates, because the trigger cannot be bypassed by
  application code.

**Evaluation.** `evaluate_card_payments(user)` recomputes **all** of the user's card legs. That is
card legs only: a few per month, so a full recompute is cheap and removes any dependency-closure bug.

**Lock order.** Every participant takes locks in this order, and the evaluator never waits on L3:
- **L1 — the per-user advisory lock** (`pg_advisory_xact_lock`), taken by every RPC and by the
  evaluator. It is re-entrant within the RPC that already holds it.
- **L2 — the user's `card_payment_eval_versions` row.** The evaluator takes it with `FOR UPDATE`;
  input triggers take it with their `UPDATE`.
- **L3 — data rows** (transactions, accounts, …).

A lock-free writer (a direct update, or an old backend's direct statement) takes L3 and then, in its
AFTER trigger, L2. The evaluator holds L1 and L2 but **takes no L3 lock**. It writes no transaction
or account row, and its derived tables have no FKs to them, so no wait cycle can form.

**Deadlocks outside the evaluator.** A multi-statement RPC holds L2 from its first input write
(the trigger bump) until commit. Suppose it then writes a data row that a **lock-free** writer
holds, while that writer waits on L2 for its own bump. That is a cycle.
- **Detection:** PostgreSQL detects it and aborts one transaction, which rolls back completely,
  bump included. No state can become falsely fresh, and the sync batch or direct write is retried.
- **Exposure:** it is limited to lock-free writers. In this release every new-backend input writer
  takes L1 first, including the account-inclusion change, which becomes an RPC. The only lock-free
  writers are an old backend's direct account update during a rollback window, and manual SQL.
- **Scope of the account trigger:** it fires only when `type`, `exclude_from_cash_flow` or
  `item_id` actually changes, so nickname or colour edits never take L2.

**Steps** — publishing exactly the evaluated version:
1. **Require READ COMMITTED.** If `transaction_isolation` is anything else, raise. The subtransaction
   fails and publishes nothing, so freshness is unchanged (a stale user stays stale), and that is safe.
   Under REPEATABLE READ the snapshot could predate the version it reads.
2. **Take L1.**
3. **Take L2 and read the version:** `select input_version into v … for update`, creating the row
   first if it is missing. Then clear this user's bump-coalescing marker, so any input this transaction
   writes from here on bumps again.
4. **Read the inputs**, in statements that run after step 3. Each takes a fresh snapshot, so it sees:
   - every input change committed before L2 was granted. A change and its bump commit together, so
     every bump counted in `v` has its change visible;
   - the transaction's own earlier writes.

   A change not yet committed has not bumped `v`. Its bump is waiting on L2 and lands after this
   commit, making the user stale.
5. **Compute and replace** the derived rows, stamped `computed_at_version = v`.
6. **Publish:** `evaluated_version := v` — the version read in step 3, **never a re-read**. If this
   same transaction writes another input after step 3, `input_version` is already greater than
   `v`, and the user stays stale. That is the safe direction.
7. **Commit** publishes the states and `evaluated_version` together.

- **Where it runs:** at the end of every new RPC that changes an input — the sync batch, the role
  override, the decision RPCs, the account-inclusion update and the LIM removal. It runs in a
  subtransaction (`begin … exception when others then …`).
  - **Amended for the sync path (Trevor, 2026-10-01; packet 2b-2a).** This changes only the execution
    schedule. The financial rules and the freshness guarantee (states readable only at exactly the
    current input version) are unchanged.
    - **Why:** a sync is not one transaction. The batch RPC, loan auto-linking, role reconciliation, the
      repair sweep and the carry-over sweep each commit separately, and each can change inputs.
    - **What changes:** the sync does not evaluate inside each of those RPCs. It runs **one** standalone,
      best-effort `try_evaluate_card_payments(user)` after all of them, in its own transaction, before
      the unrelated recurring-stream refresh (`syncService.ts`, `cardPaymentEvaluation.ts`).
    - **Gated:** it runs only behind the default-off server flag `CARD_PAYMENT_SYNC_EVALUATION_ENABLED`
      (only "true", case-insensitive and trimmed, enables it).
    - **Cost:** the states are unreadable (`fresh = false`, no states; `updating` once the read
      protocol exists) whenever a matching input has changed since the last publication. That covers:
      - a sync that is between steps;
      - a sync that failed before reaching the evaluation (before or after its cursor advanced);
      - a failed evaluation, which publishes nothing.

      Two qualifications:
      - **A timed-out request has an unknown server outcome.** The timeout stops the client waiting.
        The evaluation may still complete and publish, or fail and roll back. Freshness is whatever the
        stored versions say.
      - **A sync of a user with several items evaluates once per item.** A later item's batch that
        changes a matching input invalidates the earlier evaluation; one that changes none (an empty
        batch, for example) does not.
    - **Recovery:** the next successful sync evaluates again, even one with an empty batch. On the sync path
      that is the only retry for now: the "retries after commit" of the bullet below is not built for it
      (retry-on-read is later work).
    - **Unchanged:** the decision RPCs still evaluate in-RPC.
    - **Still open:** retry-on-read and evaluation after other user actions (later slices). Institution
      removal (formerly "packet 2b-2b") is the I3A candidate described in the next bullet.
  - **The removal path (integration slice I3A; failure contract approved by Trevor, 2026-10-06).**
    `remove_plaid_item_local` evaluates **twice in its own transaction**:
    - **before its deletes, strictly** (`evaluate_card_payments`), because the conversion of §4.7 must
      be computed from the rows as they are now — never from stored states, which may be stale or
      missing. If this evaluation or the conversion fails, the call raises: the whole removal rolls
      back and stays retryable. A removal that cannot learn, or cannot preserve, what is known does not
      happen. This is the one place where an evaluation failure blocks a write;
    - **as its last statement, best-effort** (`try_evaluate_card_payments`), so a removal normally
      commits fresh states for the rows that are left. If this evaluation fails, only it rolls back:
      the removal commits, `evaluated_version` stays behind `input_version`, `last_error_code` records
      the SQLSTATE, and no state is readable until a later evaluation succeeds. That is the "On
      failure" rule below, unchanged.

    **What "a failure rolls back the whole removal" means (acceptance test 18).** It refers to a
    failure of the preservation-and-removal transaction itself: its checks, the first evaluation, the
    conversion, the version bumps, the deletes. A failure of the final derived-state evaluation, after
    the evidence and the removal are safely established, leaves the committed user stale. It does not
    undo the removal.

    **Recovery from that stale state is not built for the removal path.** The next sync's evaluation
    (flag on) or a standalone evaluation recovers the user. A replay of a cleaned removal evaluates
    nothing, and the decision RPCs refuse a stale user.

    The freshness rule is unchanged. The first evaluation's lock on the version row (L2) is held to the
    end of the transaction, so no other writer's input change can commit between the preservation, the
    delete and the final publication.

    **Lock order of the removal (approved 2026-10-06).** L1 first. Then, before the first evaluation
    takes L2, the removal locks the removed institution's **account rows**, in id order, with the lock
    their delete takes (`FOR UPDATE`). The released removal reached those rows — its cascade's delete —
    before its first version bump; taking L2 earlier without this would have turned a wait into a
    deadlock for a lock-free writer that holds one of them (the account-settings update, or an insert
    that references the account). A lock-free writer that holds a **transaction** row of the removed
    institution is unchanged: the same PostgreSQL-detected, retryable deadlock as under the released
    removal, which also held L2 before it deleted any transaction. The global lock hierarchy is not
    redesigned.

    **Surviving accounts.** The preservation's inserts take the foreign-key lock (`KEY SHARE`) on the
    surviving accounts they name, while L2 is held — also on the kept account of a card that a hold
    names. A lock-free account-settings update on such an account holds its row `FOR NO KEY UPDATE`,
    which does not conflict: the removal does not wait for it, and the writer's later version bump
    leaves the user stale, never falsely fresh (concurrency `c36`).

    **The removal reads the evaluator's scratch tables.** The statement that writes the ambiguity holds
    of §4.7 reads the complete matching pool as the strict evaluation leaves it in the same transaction
    (`pg_temp.cpe_pool`, `cpe_txn`, `cpe_tier1`, `cpe_dismissed`). A later change that replaces
    `evaluate_card_payments` must replace, or guard on, `remove_plaid_item_local` with it.
- **On failure** only the evaluation rolls back. The write commits, `evaluated_version` stays behind
  `input_version`, `last_error_code` records a sanitized code, and the backend retries after commit
  and on the next sync. **A failed evaluation never blocks the sync and never leaves a stale state
  readable as resolved.**
- **Standalone** (a retry after commit, or after a trigger-only change from an old or direct writer),
  it runs in its own transaction under the lock.
**Reading.** `get_card_payment_states(user, from, to)` is one statement, so it sees one snapshot. It
returns `input_version`, `evaluated_version` and — only when they are equal — the legs' states.
When they differ it returns `fresh = false` and **no** states.

**The aggregation's read protocol:**
1. **S** ← `get_card_payment_states`.
2. Page the transactions (`fetchAllPages`; each page is its own snapshot).
3. **V2** ← `select input_version`.
4. **Compute** only if S is fresh **and** `S.input_version = V2`. Every input change bumps the
   version, so equality means no input committed between S and the last page. The pages and the
   states then describe exactly version `V2`.
5. **Otherwise retry**, at most twice more, with a short backoff.
6. **If it is still inconsistent**, return a **retryable `updating` result**: `{ status: 'updating',
   retryAfterMs, reason: 'inputs_changing' | 'matching_pending' | 'matching_failed' }`.
   - It has **no totals and no ranges**: no `cashFlow`, `cashFlowRange`, savings rate or breakdown
     figures.
   - It covers the whole aggregate response, because every figure in it came from the same
     inconsistent pages.
   - `matching_failed` means `last_error_code` is set. The backend keeps retrying the evaluation
     and logs the code; the response stays retryable.

**Invariant:** no figure — single number or range — is ever computed from rows and states of
different versions, or from states older than the inputs.

In normal operation the writer's own RPC evaluates before commit, so readers see fresh states.
`updating` appears only while inputs are changing under a read, after a trigger-only write (an old
or direct writer), or while an evaluation is failing.

### 3.8 Implementation language

The evaluator is written in SQL (plpgsql), so it can run inside the writers' transactions. The
pure TypeScript module stays as the **oracle**. A property test on generated histories requires the
SQL and TypeScript results to be identical. This is an engineering choice, open to review, not a
product decision. The alternative — TypeScript after commit only — is correct under §3.7, but every
read between a sync's commit and its evaluation would return `updating`.

## 4. How each case is handled (examples)

C is an included checking account, X an included card, E an excluded card and F an excluded savings
account. "X" in a figure means the month's cash flow excluding these legs.

### 4.1 Late payment
C +100 on Sep 1, with the card leg X −100 posting on Sep 7:
1. **Sep 1–6:** `no_candidate`, with the text "Waiting for Sapphire to show this payment". Range
   [X − 100, X].
2. **Sep 7:** a 6-day exact candidate → `possible_match`, still a range.
3. **The user acts:**
   - **Confirm** → `user_pair` → X.
   - **Reject** → `not_this_pair`. The leg is unresolved again (`no_candidate`), with the actions
     "It went to a card I haven't linked" and "Choose the matching card transaction". It does **not**
     become −100 on its own.

If the leg posts by Sep 6, tier 1 pairs it automatically and the range collapses without action.

### 4.2 Returns
- **Codex's case.** The Sep 1/2 pair is tracked. The reversal X +100 (Sep 10) and the return C −100
  (Sep 16) are a return-of-pair suggestion → range [X, X + 100]. Confirming gives X.
- **Payment and return, destination not linked:** C +100 Sep 1 and C −100 Sep 12, with the user
  having included card X.
  - Each leg is unresolved until the user confirms it: [X − 100, X] for the payment and [X, X + 100]
    for the return, in their own months.
  - The user confirms each transaction individually ("It went to a card I haven't linked" / "It came
    back from a card I haven't linked") → −100 in its month and +100 in its month.
  - When both fall in one month, it nets to X. Across months, each month shows its own confirmed
    figure. There is **no cross-month cancellation**; the payment-and-return shortcut is deferred.
- **Return on an excluded card:** E +100 and C −100 within 5 days pair in tier 1 → `partner_excluded`
  → +100, immediately.

### 4.3 Fee (amount) differences — complete rules
Notation:
- c: the cash-side leg's cents. A payment is c > 0 and a return c < 0.
- k: the credit-side leg's cents, of the opposite sign.
- Only a user pair may differ (tier 1 needs exact cents). It needs `accept_difference` equal to the
  actual difference, and a payment can never pair with a return (the signs must be opposite).
- m = min(|c|, |k|) is the matched part. The **cash excess** is |c| − m and the **card excess**
  is |k| − m. Exactly one of them is non-zero.

| Partner | Case (example) | Effect on cash flow | Card-side label |
|---|---|---|---|
| included card | payment, cash larger (C +100 / X −98) | **−2.00** — the excess left checking and did not reach an included card | 98 paired |
| included card | payment, card larger (C +98 / X −100) | **0** — the card's extra 2 came from outside (D5: externally funded) | 98 paired, 2 externally funded |
| included card | return, cash larger (C −100 / X +98) | **+2.00** — the excess arrived in checking from outside | 98 paired |
| included card | return, card larger (C −98 / X +100) | **0** — the card's extra 2 went outside (D5: reversed externally) | 98 paired, 2 reversed externally |
| excluded card | any direction, any difference (C +100 / E −98) | **the whole cash leg**: payment −100, return +100 — its destination is outside the tracked set | E's leg ignored (tracked set) |
| excluded cash account | F leg with an included card (F +100 / X −98) | **0** — F is outside the tracked set | X leg: funded from an excluded account |

- **General rule for a pair with an included card:** the cash excess counts like an unpaired
  cash-side leg of the same direction (payment −, return +). The card excess counts like an unpaired
  credit-side leg (0). With an excluded card the cash leg counts in full.
- **The pair stores both amounts.** If E is later included, the pair becomes a tracked pair with
  difference, and the effect switches from −100 to −2.00 with the next evaluation.
- **A separate fee row** (the card shows a $2 fee as its own transaction) is ordinary card spending
  and not part of the pair.

### 4.4 Ambiguous matches
- **Two payments, one card credit.** C +400 Sep 1, C +400 Sep 3 and X −400 Sep 2 tie. All three are
  `ambiguous` → per-leg bounds [X − 800, X], deliberately conservative. The user picks one: that pair
  is tracked, and the other payment is unresolved with its own candidates. It is not assumed to be
  unlinked.
- **One payment, two card credits.** C +400, X −400 and Y −400 on the same day: the same treatment.
- **An excluded card leg creating the tie.** C +555 Sep 15, X −555 Sep 16 and E −555 Sep 14 are
  `ambiguous`. The user decides between tracked (X) and untracked (E). Slice 1, which ignores E,
  would have paired C with X silently. The audit's R4 case shows this.

### 4.5 Unlinked card
C +250 to a card Z that was never linked:
- **The user has no included credit account:** `no_included_card` → −250 immediately. That is proof:
  no included card exists. Linking a card later re-evaluates.
- **The user has included card X:** unresolved until they confirm "a card I haven't linked" for that
  transaction, or pick a match. There is no automatic conversion (T4), and recurring rules are
  deferred (T8).

### 4.6 Excluded accounts
- **Payment to an excluded card.** C +500 and E −500 pair in tier 1 → `partner_excluded` → −500
  immediately. Slice 1 already counts −500 here, so this is **correct today** and not exposure (§9).
  Including E later makes it `tracked` (0).
- **An excluded card closer than the included card** (regression R7). C +100 Sep 1, X −100 Sep 3 and
  E −100 Sep 2:
  - Tier 1 over the approved pool (T5) pairs C with E: E is closer, and each is the other's best
    match. So C is `partner_excluded` → **−100**, a confirmed result with no unresolved exposure.
  - X's leg stays unresolved on the credit side (0).
  - Slice 1, which never sees E, pairs C with X → 0.
  - This is a **confirmed difference** between slice 1 and the approved rules, not exposure. The
    audit reports it in `confirmed_difference` (§9). The pure-module tests pin it with a
    characterization test (0) and an `it.fails` test for the approved figure (−100).
- **Excluded cash account funding an included card.** F +300 and X −300 pair. F is ignored, and X is
  labelled "funded from an excluded account" (0).

### 4.7 Removal, relinking, stale institutions
- **LIM removal of the card's institution** *(T9; amended 2026-10-06)*. In the same transaction as the
  removal, and **before** its deletes, the RPC preserves every pair between a removed card leg and a
  surviving cash leg, on the surviving leg: a **tier 1** pair as a `destination_removed_card` decision
  (the system record); a **user-confirmed** pair as the user's own decision, `pair_counterpart_removed`
  (below). The removed leg's pair was the evidence of the destination, and that card is now outside the
  tracked set. *(Before the amendment a user pair became the system record too. That downgraded an
  explicit confirmation to a record that reserves nothing.)*
  - Those cash legs become `untracked / removed_card` → past months change from 0 to −amount.
  - This is correct under D5, because the tracked set shrank.
  - The removal confirmation says so: "Payments from your other accounts to this card will count as
    money leaving your tracked accounts."
  - Legs that were already unresolved **stay unresolved** *(approved 2026-10-06)*. Removal is not
    evidence: such a leg gets no destination. And deleting one of its candidates is not evidence for
    another one: a leg does not become resolved merely because the removal deleted a candidate. Where
    that could happen, the removal records a system ambiguity hold (below). A later evaluation resolves
    such a leg when genuinely new or changed evidence supports it under the ordinary rules, or when the
    user decides.
  - A payment that was **automatically matched** to the removed card **is not switched** to another
    card that was already there *(approved 2026-10-06, below)*. The disappearance of a destination is
    not evidence for another one. The payment keeps reading its record.
- **Relinking** creates new accounts and Plaid ids. A `destination_removed_card` decision ranks below
  a tier 1 pair (§3.2 precedence). When the relinked card's history re-imports the matching legs, the
  cash legs become `tracked` again automatically, and the decision stays as dormant history.
- **An invalidated removed-card record is re-evaluated — approved (Trevor, 2026-09-30).** A
  system-generated `destination_removed_card` record can become invalid because the amount changes.
  The leg is then evaluated with current bank information under the existing rules:
  - a clear qualifying match (tier 1) applies automatically;
  - otherwise it stays unresolved, unless current independent evidence establishes the effect (for
    example, no included card).

  The invalidated record is never used as proof. It never overrides a protected user confirmation,
  and never bypasses the conflicting-replacement guard. Unlike a user confirmation, it does not
  reserve the leg.
- **A card item that is not syncing** changes wording only: "Reconnect Sapphire to finish matching 2
  payments". It is never evidence.

**How the removal rule is implemented (integration slice I3A, 2026-10-06 — a candidate under
independent review; `PHASE_B_I3A_LIM_REMOVAL_MATCHING.md`).** Where the rule's wording leaves a case
open, the candidate does this:
- **Which pairs.** The cash-side legs that an evaluation made inside the removal gives a partner on an
  account of the removed institution: tier 1 pairs and *active* user pairs, with an included **or an
  excluded** card. A pair with an excluded card already counted −amount; it keeps that effect, as
  `removed_card` instead of `partner_excluded`.
- **Which leg.** Only a cash leg on an account of **another** institution survives and is converted. A
  cash leg on the removed institution is deleted with it. A surviving card leg whose cash leg is removed
  gets no destination record: a credit-side leg never moves cash flow (§2). Where a kept cash leg also
  fitted it, it gets a hold (below).
- **A leg on an excluded cash account** is converted too. It stays not counted; if the account is
  included later, the preserved destination applies.
- **The record's key** is the surviving leg's own lineage key at that moment: its account, its own Plaid
  id (the pending id while it is pending) and its cents. A leg that already has a live record with
  exactly that key gets another one all the same *(amended 2026-10-08, I3A-R packet 1: each removal
  writes a record for the removed partner it deletes and reuses none; until then such a leg got no
  second one)*. Several live records on one leg read as one.
- **A pair with a difference** (§4.3) becomes the whole cash leg: −80, not −2. The card is outside the
  tracked set now, as with an excluded card.
- **The warning** ("Payments from your other accounts to this card will count as money leaving your
  tracked accounts") is **not** shown yet. The removal preview already lists the institution's accounts
  with their types, so the confirmation can show it without an API change; that copy change is left for
  the frontend packet.

**Explicit user confirmations through a removal — approved (Trevor, 2026-10-06) and implemented in the
I3A candidate.** A permanent removal must not erase explicit user-confirmed evidence merely because the
confirmation is temporarily inactive. It must not release the surviving leg for automatic reuse because
the other account is being deleted. User-confirmed evidence is distinguished from automatic (tier 1)
evidence:
- **Active.** An active user pair is preserved at user strength too. It is not downgraded to the
  system record. While the surviving leg's amount, direction and lineage stay valid, it gives the
  removed-destination effect, and it stays stronger than later tier 1 evidence until the user undoes or
  replaces it.
- **Waiting to post** (lineage unambiguous; amount and direction not invalidated). The confirmation is
  preserved, stays stronger than automatic matching and keeps its reservation. Once the surviving
  lineage is determinable, the removed destination gives the removed-card effect.
- **Amount changed.** The decision, its history and its reservation are preserved. The old amount is
  not proof: the leg stays unresolved unless current independent evidence already establishes the
  effect under the existing rules. A removal never makes an invalid confirmation valid again.
  - That independent evidence is the "no included card" rule, and it applies only where an **amount**
    is the only thing wrong — the surviving leg's, the removed leg's, or both. A confirmation whose
    removed side was invalid for any other reason stays unresolved whatever the surviving leg's amount
    later does: a correction of the leg that survived resolves nothing about the side that is gone.
- **Conflicting replacement lineage.** Preserved and reserved; unresolved. No replacement is chosen and
  no removed-card effect is published. If later data resolves the ambiguity, the existing rules
  re-evaluate.
- **Automatic (tier 1) evidence** keeps the system record described above: non-reserving, below every
  user decision, dormant after a relink, never proof once invalidated.
- **Relinking.** Preserved user intent keeps its precedence: tier 1 evidence from the relinked card is
  listed as a suggestion and never applied by itself. An invalidated or ambiguous confirmation does not
  become a valid effect because a relink occurs. The "no included card" rule can still establish an
  effect by itself; that is not a reactivation of the old confirmation.
- **The mirror case.** When the **cash** account is the one removed and the card leg survives, the
  confirmation is preserved on the card leg in the same way. The card leg must not become free to pair
  with another cash leg. No cash-flow effect is invented for it: a credit-side leg's effect is 0; the
  leg reads `funded_from_excluded` (reason `removed_cash_account`) — its funding is outside the tracked
  set.
- **Passive invalidation is not a newer user action.** History and reservation are kept across passive
  data or lifecycle changes: waiting to post, an amount change, conflicting lineage, a row the classifier
  re-classified, a row the bank withdrew. But **a newer explicit user action supersedes an older
  confirmation**, which is then neither carried forward nor allowed to keep reserving: an undo, a
  replacement by another decision, or the user re-classifying one of the two legs away from card payment.

**How it is represented (the smallest additive form; migration `20261006110000`).** The existing
decision model could not hold it: the only removed-card kind is the non-reserving system one; the only
reserving single-leg kind means "unlinked" and cannot stay invalid for a reason on the removed side; and
a pair cannot outlive its account. So:
- one new decision kind, `pair_counterpart_removed`, a **user** decision on the surviving leg, keyed
  exactly as the pair recorded that leg;
- the removed leg's Plaid id and cents stay in leg B **without an account** (no dangling reference, no
  foreign key weakened), with the pair's accepted difference;
- one new column, `counterpart_status`, freezes what was true of the removed side: `valid` and
  `waiting_to_post` invalidate nothing; any other value keeps the decision inactive for good.

The evaluator reads it as a user decision: it claims its row, active or not. Active → `untracked /
removed_card` on the cash side, `funded_from_excluded / removed_cash_account` (0) on the credit side.
Inactive → reserved and unresolved. `link_card_payment` and `mark_card_payment_destination` supersede
it like any other user decision; undo releases it.

The order in which the frozen status is read, after the surviving reference's own lineage (the SQL
evaluator and the TypeScript reference, the same rule):
1. a frozen status other than `valid`, `waiting_to_post` and `amount_changed` is the decision's
   inactive reason, whatever the surviving leg's amount or role is now;
2. then the surviving leg's amount (`amount_changed`), then its role (`role_changed`);
3. then a frozen `amount_changed`;
4. otherwise the decision is active.

So the "no included card" exception, which accepts only `amount_changed`, is never reached by another
frozen reason. *(An earlier candidate read the surviving leg's amount first: a frozen
`lineage_ambiguous` with a corrected surviving amount read `amount_changed` and, with no included
card, published an effect.)*

Tests: `a20_lim_removal_user_confirmations.sql` (nine cases, each with a competing leg; it was written
before the behaviour existed and failed against the earlier candidate), `a21_lim_removal_user_intent.sql`
(passive invalidation against newer explicit user actions), `a24_lim_removal_frozen_invalidity.sql`
(a frozen invalidity is never masked by a surviving amount correction: through the real removal, and
for all ten frozen statuses, each also with its surviving payment re-classified afterwards), sequences
Q11 and Q14 and scenarios S32–S50 and S77–S82 of the evaluator-equivalence harness, and the reference
evaluator's own tests and invariants I11 and I12.

**A tie the removal would break: the system ambiguity hold — approved (Trevor, 2026-10-06) and
implemented in the I3A candidate.** If a leg is unresolved before a removal because of a genuine tie or
ambiguity between an account being removed and one or more accounts that remain, the removal must not
resolve it. Deleting one candidate is not new evidence that another was the true destination.
- **What is held.** A surviving leg with no automatic match whose tier 1 candidates include at least
  one leg of the removed institution **and** at least one leg that survives. Either side: a payment that
  a removed card and a kept card both fitted, or a card leg that a removed cash leg and a kept cash leg
  both fitted.
- **Judged on the matching evidence, not on what a reader is shown.** The removal reads this from the
  evaluator's complete pool — the scratch tables its own strict evaluation leaves in the transaction —
  and not from the published states. A leg on an account that is excluded from cash flow takes part in
  tier 1 like any other, but is published `not_counted`, with no candidates. A payment that the "no
  included card" rule or an earlier removal's record decides is published `untracked`. Each of them can
  have candidates on both sides of a removal, and is then held like a leg that reads unresolved. *(An
  earlier candidate read the published states and missed them: a kept payment was paired with the leg
  of a kept excluded card as soon as a removed payment that fitted that leg equally well was deleted.)*
- **What is not held.** A leg whose candidates were all on one side of the removal: there is no
  ambiguity for the removal to resolve, and the ordinary rules go on applying to it. Nor a leg whose
  automatic match stays, or one that a user decision holds. Unresolved payments are not frozen in
  general.
- **No effect.** The hold publishes nothing: no removed-card effect and no tracked pair. The leg reads
  what it read before the removal — unresolved, with its range; not counted, on an excluded account —
  and its candidates, where a reader is shown any, are still listed. One reading changes through the
  removal itself: if it took the user's last included card, an included cash leg that was unresolved
  reads `untracked / no_included_card`. A leg that was matched automatically to the removed
  institution (the second case, below) no longer reads that match: a cash leg reads its system record —
  `untracked / removed_card`, a definite figure — and a card leg reads unresolved; on an excluded
  account either still reads not counted.
- **System strength.** The hold is not a user decision. It claims no leg, is never the decision named
  on a leg, and ranks below every user decision, a preserved one included. It does not say that either
  destination was confirmed.
- **Not permanent.** A later evaluation resolves the leg when genuinely new or changed evidence
  supports it under the ordinary rules:
  - a **new transaction**, or the re-imported leg of a **relinked** card, is not the hold's concern: it
    pairs, or ties, by the ordinary rules. It does not release the hold's own pair, which stays judged
    against the removed candidate's stored date — after a relink too, whatever date the re-imported leg
    has (recorded as open: `PHASE_B_I3A_LIM_REMOVAL_MATCHING.md` §9.3, question 7; *amended 2026-10-09,
    I3A-R policy: the policy that governs it is recorded in the status above; nothing of it is
    implemented*; *amended 2026-10-09, I3A-R packet 2-A: with migration `20261009120000` such a pair is withheld
    for an affected payment (one that had an eligible candidate on the removed institution), unless
    that removal knew the pair; the hold and the record stay as they are*);
  - a **changed amount** on either leg ends the hold;
  - a **date change** releases the pair when it brings the kept candidate strictly closer than the
    removed one was, and not otherwise;
  - a leg that **posts** with the same amount is the same leg, not new evidence; if it posts on another
    date, that is judged like any date change;
  - an **explicit user decision** — a match, "a card I haven't linked", a dismissal — works as if no hold
    existed, and decides the legs it names. If the user later undoes it, the pair is withheld again. A
    decision about another leg does not release the hold's own pair.
- **Precedence.** A newer explicit user action, then a preserved explicit user confirmation, then
  current automatic evidence subject to the hold, then ordinary system history.

**How it is represented (the smallest additive form; migration `20261006110000`).** A hold is a record
on **one possible pair**: the two surviving legs that would otherwise be matched.
- two decision kinds, `ambiguity_hold_removed_card` and `ambiguity_hold_removed_cash_account`, both
  system-written. Leg A is the card-side leg and leg B the cash-side leg, with their accounts — the
  ordinary references, so the record goes with either account;
- one new column, `counterpart_date`: the removed candidate's date;
- the **kind** says which of the two legs the removed candidate competed for: the cash leg when a card
  leg was removed, the card leg when a cash leg was.

Why each part is needed:
- *The pair, not just the leg.* The hold must stop the old candidate from being proven by the deletion,
  and must leave a new one alone. A record on the leg alone would also stand in the way of the relinked
  card's re-imported leg.
- *The date.* Whether a later date change breaks the old tie depends on where the removed candidate
  was, and no existing column holds a date.
- *Two kinds rather than the order of the legs.* The card leg is written first on purpose. An evaluator
  that does not know these kinds (after the migration's rollback) then reads the record as an inactive
  decision that holds both legs — not as a confirmed pair, while the card leg's account is a credit
  account. That reading is not harmless once a hold stands on a payment with a known figure: see the
  rollback notes in `PHASE_B_I3A_LIM_REMOVAL_MATCHING.md` §7.

The evaluator computes tier 1 exactly as before. Then it withholds the automatic pair of a hold's own
two legs while the hold applies — both legs current card legs, on opposite sides, with the recorded
cents — and the removed candidate would still be at least as close to the leg it competed for as that
leg's partner is, on the dates as they are now. Nothing else changes: both legs stay in the pool, no
other pair is formed in the withheld pair's place, and a pair with any other leg is evaluated as always.
The user cannot undo a hold (`undo_card_payment_decision` refuses it, as it refuses the system record);
no other RPC reads one.

Tests: `a22_lim_removal_ambiguity_hold.sql` (the contract's own test: the two-way tie, three candidates,
later evidence of each kind, the user's decision, a relink, a second removal, a candidate the user had
dismissed — removed or kept — and a removed leg outside the five days, the mirror case, ownership),
`a23_lim_removal_excluded_accounts.sql` (the same contract where an excluded account is involved, on
either side; a payment the "no included card" rule decides, as the hold's other leg and as the owner of
the tie; and four shapes with no ambiguity, where nothing is written), `a21` case T, sequences Q12 and
Q13 and scenarios S51–S76 and S83–S86 of the evaluator-equivalence harness, and the reference
evaluator's own tests and invariant I13.

**A payment that was automatically matched to the removed card — approved (Trevor, 2026-10-06,
"Option B") and implemented in the I3A candidate.** A payment that was automatically matched to a card
of the removed institution must not automatically switch to another card that was already there, solely
because the original destination disappeared. Institution removal is not new financial evidence.
*(Before this decision such a payment kept only the system record, which ranks below tier 1: a kept
card's fitting leg within five days then paired automatically, and the record went dormant.)*
- **Two cases stay distinct.** A payment that was *resolved* by automatic matching to the removed card
  keeps its known removed destination and its treatment: the system record, `untracked / removed_card`,
  −amount. A payment that was genuinely *unresolved* — a tie — stays unresolved and gets no
  destination. Known removed-destination evidence is not collapsed into an ambiguity.
- **Pair-specific, system strength.** The protection claims no leg and publishes nothing. It is on the
  pair of the payment and the competitor that was already there, and on nothing else. New evidence (a
  new, strictly closer leg), changed evidence (an amount; a date that brings the competitor strictly
  closer than the removed candidate was), the re-imported leg of a relinked card and the user's decision
  are evaluated as always. One limit after a relink is recorded as open (the slice document's §9.3,
  question 7): the hold keeps judging its pair against the stored date of the leg that was removed.
  *(amended 2026-10-09, I3A-R policy: open as behaviour. The policy that governs it is recorded in the
  status above: permanent release requires the user's explicit authorization, P-Y.)*
  *(amended 2026-10-09, I3A-R packet 2-A: "evaluated as always" no longer holds for a new or
  re-imported leg and an affected payment. Such a pair is withheld until the user decides the
  payment; the status above states the rule.)*
- **Nothing is written where there is nothing to protect against:** no competitor, an automatic match
  that stays, or a kept leg outside the five-day window.
- **The mirror.** When the **cash** institution is removed, a kept card leg that was matched
  automatically to a removed cash leg is held against the kept cash legs that also fitted it. There is no
  destination record for a card leg. It reads unresolved (effect 0), and the kept cash leg is not read
  as a tracked payment.

**How it is implemented (migration `20261006120000`).** No new kind, column or evaluator rule, and
`destination_removed_card` is not promoted above tier 1:
- the removal still writes the system record on the payment;
- the statement that writes the holds also takes as an *owner* a pool leg whose tier 1 partner is on
  the removed institution, and writes the existing ambiguity hold on the pair of that owner and each
  kept tier 1 candidate, dated by each removed tier 1 candidate;
- after the removal tier 1 forms the pair with the kept competitor, the hold withholds it, and the
  payment falls to the next step of §3.2: it reads its record;
- an owner gets a hold for **every** removed tier 1 candidate, not only for its partner. The evaluator
  judges a hold on the dates as they then are, and the owner itself can be re-dated when it posts.

Tests: `a25_lim_removal_automatic_destination.sql` (the approved example; no competitor; a tie; several
competitors; new, changed and unchanged evidence of each kind, an unchanged posting of the payment and
of the kept card's leg included; a relink and a second removal; the user's confirmation and later
decisions; excluded accounts; the mirror; ownership), `a21` case E-undo (which pinned the opposite
before this decision), concurrency `c36`, and sequence Q15 and scenarios S87–S94 of the
evaluator-equivalence harness.

**Left for a decision.** Seven questions that revision 5 of the I3A candidate records and does not
decide are in `PHASE_B_I3A_LIM_REMOVAL_MATCHING.md` §9.3. *(amended 2026-10-09, I3A-R policy: for the one
about a hold after the removed institution is linked again, question 7 there, the governing policy —
P-Y and P-D — is recorded in the status above. It is not implemented. The others are as they were.)* *(amended 2026-10-09, I3A-R packet 2-A: the review safeguard and the user-assisted
recovery of that policy are implemented as a local candidate; P-Y and P-D themselves are not.)*

### 4.8 Pending → posted — every order

Decisions reference lineages (§3.6), and derived states are recomputed from current rows at each
evaluation. Let Pc/Pk be the pending cash and card legs and Tc/Tk their posted replacements, with a
user pair decided on Pc–Pk.

| Order of events (any number of syncs between them) | Result |
|---|---|
| Pc and Pk both removed (same or separate batches) **before either posts** | The decision row is untouched (no FK). Neither leg has a current row, so no state exists. |
| … then Tc posts, Tk still waiting | Tc is current for Pc. Pk is `waiting_to_post` → the decision is inactive (`matched_leg_not_posted`) → Tc unresolved |
| … then Tk posts, cents equal | Both current, the decision is active → Tc `tracked` / `user_pair` |
| Tk posts first, then Tc | Identical final result, by symmetry |
| Tc arrives **before** Pc's removal (reversed arrival) | Tc is current and Pc superseded (not in the pool, no state). Pc's later removal changes nothing |
| Tc's amount ≠ Pc's recorded amount | The decision is inactive (`decision_invalidated`); Tc's state shows the reason; Tc is unresolved. The user may confirm again (a new decision) |
| Pc is cancelled and never posts | Pc stays `waiting_to_post` until its carry-over expires, then `gone`. The decision is inactive; it is purged 30 days after every lineage is gone |
| **A decision with no partner** (`destination_unlinked` on Pc) | The same lineage rule: carried to Tc if the cents are equal, otherwise invalidated (reason shown on the state) |
| `not_this_pair` on Pc–Xk | Applies to Tc–Xk once Tc posts, whatever the amounts (it only suppresses a suggestion) |

- **Tier 1 pairs involving pending rows** are derived. They are recomputed at each evaluation, so
  posting simply re-derives them.
- **A posting that moves the date by more than 5 days** turns a tier 1 pair into `possible_match`,
  visibly.
- **Nothing is lost by cascades:** `card_payment_decisions` has no foreign key to transactions, and
  only the account cascade applies (safe, §3.5).

### 4.9 Role and amount changes
- **The user overrides a leg away from `credit_card_payment`.** Its decisions become inactive
  (`decision_invalidated`, reason role), and the partner re-evaluates. This happens in the same
  override RPC, whose evaluation runs before commit (§3.7).
- **The user overrides a row *to* `credit_card_payment`.** It joins the pool in the same RPC.
- **Plaid modifies an amount.** Tier 1 recomputes, and a user decision is invalidated if its cents no
  longer match.

## 5. What the aggregation module becomes (pure, no I/O)

- **Inputs:** card legs arrive with their state (from `get_card_payment_states`), `effect_cents` and
  labels. The module no longer pairs card legs, so the ±5-day card window and the card half of
  `PAIRING_PAD_DAYS` leave it. Transfers are unchanged.
- **Outputs:** `status: 'ok' | 'updating'`. `updating` carries no figures (§3.7). With `ok`:
  - `cashFlowRange { low, high }` and `savingsRateRange`;
  - `cashFlow` (a single number only when nothing is unresolved);
  - `cardPaymentsUnresolved { count, paymentsAmount, returnsAmount, byReason }`.
- **Invariants:**
  - low ≤ high;
  - high − low = Σ|cash-side unresolved amount|;
  - when nothing is unresolved, low = high = the D5 figure.
- **Tests:** the two `it.fails` tests in `semanticAggregation.test.ts` become passing tests through
  stored user decisions.

## 6. What users see while a payment is unresolved

### 6.1 Per payment

| Reason | Text | Actions |
|---|---|---|
| no_candidate (recent) | "Waiting for Sapphire to show this payment — usually 1–3 days." | Choose the matching card transaction · It went to a card I haven't linked |
| no_candidate (older) | "We can't tell which card this payment went to." | Choose the matching card transaction · It went to a card I haven't linked |
| possible_match | "Is this Sapphire's $100.00 credit on Sep 7 (6 days later)?" | Match · Not this one |
| return-of-pair | "Looks like your Sep 1 payment to Sapphire was returned." | Match return · Not this one |
| amount_differs | "Sapphire shows $98.00 on Sep 2. Match, and count the $2.00 difference as money that left your accounts?" (wording per §4.3 direction) | Match with difference · Not this one |
| ambiguous | "Two payments could match Sapphire's $400.00 credit on Sep 2 — which one?" | Pick one · Neither |
| matched_leg_not_posted | "Matched to Sapphire's pending credit — waiting for it to post." | Undo match |
| decision_invalidated | "Your match was cleared because the amount changed from $100.00 to $98.00." | Match again · Choose another |

The sync status adds a line when relevant: "Sapphire hasn't synced since Sep 3 — reconnect." Other
places:
- **Overview / Cash Flow** get a "Card payments to review (N)" list across periods.
- **Unaffected:** Budget and Spending (card payments are never spending), Net worth and Liquid cash
  (balance-based).

### 6.2 Headline figures — **T1 decided: ranges**
Any period with an unresolved cash-side leg has two possible D5 values. It shows them as a range:
"Cash flow $1,100 – $1,200 · 1 card payment isn't matched yet — Review".
- The savings rate is shown the same way.
- Charts show the conservative bound with a hatched segment to the other bound. No month-over-month
  change is shown unless both months are resolved.
- With nothing unresolved it shows a single number.
- **An `updating` result** (§3.7) shows "Updating…" in place of every card-dependent figure. There is
  no range and no number, and the client retries after `retryAfterMs`. If the reason is
  `matching_failed` and it persists, the text becomes "Card-payment matching couldn't update — we'll
  keep trying."

A provisional single number with a warning is **not** used.

The API: `status`, `cashFlow: number | null`, `cashFlowRange`, `savingsRateRange` and
`cardPaymentsUnresolved`; with `updating`, none of the figures. Legacy fields stay frozen per D11.

## 7. D5 preservation check

| Situation | D5 effect | This design |
|---|---|---|
| Payment to an included card | 0 | `tracked`, 0 — also when far apart, once confirmed |
| Payment to an unlinked card | −amount | −amount once **established**: no included card, or the user confirmed; unresolved before |
| Payment to an excluded card | −amount | `partner_excluded`, −amount (proven by the pair) |
| Its return (untracked) | +amount | the same, +amount, once confirmed for that transaction |
| Card leg funded from outside or an excluded account | 0 | credit side, always 0 |
| Fee remainder | (not covered by D5) | §4.3: D5's boundary rule applied to the excess (T6) |
| Destination not established | — | both D5 values reported; the headline per T1 |

## 8. Implementation outline (written as a sizing outline; items 1–2 partly implemented since — see the status above)

1. **Migration:**
   - the four tables of §3.5;
   - input triggers (§3.7) and `card_payment_bump`;
   - `evaluate_card_payments` and `get_card_payment_states`;
   - decision RPCs: `link_card_payment`, `mark_card_payment_destination`,
     `dismiss_card_payment_candidate`, `undo_card_payment_decision`, each with a CAS on
     `computed_at_version`. *(As implemented in slice 2b-1: a per-user check that the expected version
     equals both `input_version` and `evaluated_version` — equivalent, because the whole-user evaluation
     stamps every leg with the same version.)*
   - the sync batch RPC and LIM removal RPC extended (or a v3, if coexistence with an old backend
     requires it, as continuity did);
   - grants, and postconditions as in the continuity migration.
2. **The SQL evaluator plus the TypeScript oracle and property test.** The pairing backfill (one
   evaluation per user) runs with the Phase A backfill and joins its **release gate**.
3. **Pure module change (§5):** the fixture extended with stored states.
4. **Frontend:** reasons, actions, the review list, and T1's headline.
5. **Rollback:** drop the new objects. Only a disconnected build falls back to slice 1, which is why
   R3 gates live integration.

## 9. The read-only audit (draft rev 3, not run)

- **File:** `supabase/preflight/phase_b_card_payment_matching_audit.sql`, with two single-SELECT
  statements.
- **Validation:** `supabase/tests/card_payment_audit/run.sh` runs it in a read-only session against
  45 synthetic rows in a throwaway container of Supabase's PostgreSQL 17 image, and compares with
  `expected.out`.

**What rev 2 changes:**

| Codex point | Rev 2 | Synthetic regression (seed.sql) |
|---|---|---|
| A NULL account type made `credit_side` NULL | `coalesce(a.type = 'credit', false)`: NULL type is the cash side, as the module | **R1** #29/#30. Rev 1 reported the leg as an unpaired "return" with effect 0; rev 2 reports `cash_side / payment / confirmed_tracked_pair_5d` |
| Not enough surrounding evidence at the 60-day boundary | Rows loaded ± (60 + 2×5) days | **R2** #31–33: the only candidate is itself paired 62 days out → rev 2 `unknown_no_candidate` (rev 1 said possible). **R3** #34–37: the candidate ties 62/54 days out → rev 2 `possible_exact` (rev 1 said unknown) |
| Projected classification mixed with current behaviour | `classification` = current (override or stored role) vs projected (classifier rules for NULL-role rows). `live_effect` = today's live app (sign-based, role-blind), separate from `slice1_effect` | every row |
| "Possible" treated as error, including excluded-card payments | `unresolved_exposure` = the most the slice-1 figure could be wrong by, counted only for cash-side legs whose destination is not established. Excluded-card pairs are `confirmed_untracked_partner_excluded_5d` with exposure 0 | **R6** #14/#15 (exposure 0). **R4** #38–40: an excluded leg ties with the included one — `slice1_effect` 0 but exposure 555. **R5** #41/#42: funded from an excluded account |

**What rev 3 changes** (Codex review of 14e7bc7) — confirmed differences are reported separately
from exposure. Per bucket, one row reports:

| Column | For CONFIRMED buckets | For POSSIBLE / UNKNOWN buckets |
|---|---|---|
| `slice1_effect` | what slice 1 adds | what slice 1 adds |
| `proposed_effect` | what the approved rules add: 0 tracked, −amount/+amount untracked, 0 credit side | NULL — not established |
| `confirmed_difference` | `proposed_effect − slice1_effect`: slice 1 is **known** to differ by this | NULL |
| `unresolved_exposure` | 0 | Σ|amount| of cash-side legs: the most slice 1 **could** differ by |

The two are never summed together.

**Regression R7** (#43–#45, stored roles, so it is its own `current` row). C +100, X −100 two days
later, and E −100 one day later. The expected row is `cash_side / payment / current /
confirmed_untracked_partner_excluded_5d`, with:
- `slice1_effect` 0.00;
- `proposed_effect` −100.00;
- `confirmed_difference` −100.00;
- `unresolved_exposure` 0.00.

X's leg is `possible_tie_or_not_reciprocal_5d` on the credit side, with exposure 0.

**Other properties:**
- **Classification:** user overrides are respected first, then stored roles, then the classifier's
  row-level rules (the only source of `credit_card_payment`).
- **Output:** counts, users and amounts only. No ids, names, dates or institution names, and no token
  column is read.
- **Sandbox:** classified by institution id and name, plus an optional test-user list. Everything else
  is `not_identified`, not "real". If production ran on Sandbox throughout, every row is Sandbox data.
- **Use:** the results size the review workload and the confirmed changes. They do not change the
  definition.

## 10. Decisions — approved by Trevor, 2026-09-29 (first version)

| # | Decision |
|---|---|
| T1 | **Ranges** while payments remain unresolved (§6.2). No provisional single number |
| T2 | **60 days / $5.00** suggestion limits; suggestions are never applied automatically |
| T3 | **Unusual returns require confirmation** — return-of-pair is a suggestion |
| T4 | **No automatic "unlinked"** assumption based on elapsed time or sync status |
| T5 | **Excluded accounts may provide matching evidence** (effect still per the tracked set). This changes some slice-1 results — see R7 |
| T6 | **Fee-remainder rules** of §4.3, with explicit confirmation of the difference |
| T7 | **Historical totals may change with new evidence, visibly** |
| T8 | **Deferred:** recurring destination rules are not in this release |
| T9 | **Preserve known destinations** during institution removal (`destination_removed_card`), with the warning |

**Also deferred:** the `same_destination` payment-and-return shortcut. Users confirm individual
transactions, and this release has no cross-month cancellation behaviour. No other convenience
features are in scope.

**Approved 2026-09-30 (Trevor): conflicting replacements stay unresolved** (§3.6). When several posted
rows on the same user/account claim to replace the same pending payment, none is chosen and no
resolved matching effect is published, whatever decision exists or none. This includes
`destination_removed_card`, so the earlier open question Q12 is closed. A persistent conflict needs a
future review path that does not make the user guess; it is not built.

**Approved 2026-09-30 (Trevor), second set:**
1. **Changed user confirmations stay reserved** (§3.6). An inactive, amount-changed confirmation keeps
   its entries out of automatic matching. The account owner reviews them through a future guided
   interface, which is not built.
2. **The narrow known-effect exception** (§3.6). A same-direction amount correction of a
   user-confirmed unlinked destination, with no included credit account, publishes the corrected
   effect. The confirmation stays inactive (needs review) and the entry stays reserved. The exception
   extends to nothing else.
3. **Invalidated removed-card records are re-evaluated** under the existing rules (§4.7).
4. **Return suggestions** allow up to 60 days between refund and reversal; the original payment may be
   older (§3.3). They need confirmation; manual matching is unrestricted, and no automatic window is
   widened.
5. **Possible matches on excluded cards are shown** against an "unlinked" confirmation (§3.2), with
   the confirmation and its effect unchanged until the user acts. The "Possible match on an excluded
   card" wording is a cosmetic choice for the UI, not part of the rule.

## 11. Acceptance tests

**Pure module (vitest), from stored states:**
1. **Late leg:**
   - unconfirmed: range [−100, 0] and `cashFlow = null`;
   - user pair: 0;
   - after `not_this_pair`: **still** [−100, 0];
   - after "unlinked": −100.
2. **Codex return:** range [0, +100]; after the return-pair decision, 0. The `it.fails` test becomes
   `it`.
3. **Payment and return with unconfirmed destination**, each confirmed individually:
   - in one month: bounds [−100, +100] → after both confirmations 0;
   - across months: each month's own bounds, then −100 and +100 in their own months.

   No state links the two legs.
4. **Fee matrix (§4.3), every row:**
   - payment and return;
   - cash larger and card larger;
   - included, excluded card, excluded cash account.

   Expected: −2.00 / 0 / +2.00 / 0 / full cash leg / 0. Including E later switches −100 → −2.00.
5. **Ties:** [−800, 0]. After picking, the other leg stays unresolved (not untracked). Also the
   excluded-leg tie (§4.4).
6. **Excluded card pair:** −500 with no range. **No included card:** −250 with no range.
7. **Generated-history invariants:**
   - low ≤ high;
   - high − low = Σ|unresolved cash-side|;
   - resolved ⇒ low = high = D5;
   - credit-side legs never move a bound;
   - `no_candidate` never contributes to `untracked`.
8. **Stale or inconsistent input:** the module returns `status: 'updating'` with no figure — no
   `cashFlow`, no range and no savings rate — never a figure computed from it. A missing leg state
   with fresh states is an integrity error, never untracked.
9. **Transfers:** unchanged on the §9.1 fixture.
9a. **R7** (excluded card closer than the included card): slice 1 gives 0 (characterization). The
    approved rule gives −100 (`it.fails` until implemented), with zero unresolved exposure.

**Evaluator, triggers and RPCs (real-PostgreSQL harness, throwaway container):**
10. **Oracle:** the SQL evaluator equals the TypeScript oracle on generated histories (clustered
    dates, pending rows, excluded accounts, NULL types).
11. **Tier 1** is deterministic and independent of insertion and batch order.
12. **No automatic absence:**
    - a leg with no candidate stays unresolved regardless of age and sync status;
    - rejecting its only candidate leaves it unresolved;
    - an exact candidate 61 days away or $5.01 different is not suggested, but is offered by the
      manual picker.
13. **Invalidation** — each input change of §3.7 bumps `input_version` in its own transaction. Several
    changes in one transaction may share one increment (coalescing); every affected owner still
    advances and is stale:
    - transaction insert, delete, and every listed column update;
    - account insert, delete, `type`, `exclude_from_cash_flow` and `item_id`;
    - item delete (cascade);
    - decision change;
    - carry-over change.

    Updates of non-input columns (e.g. `budget_category_id`, `review_note`) do not bump.
14. **Stale reads:**
    - after a trigger-only change (simulated old-backend or direct update),
      `get_card_payment_states` returns `fresh = false` and no states, and the aggregate returns
      `updating` (`matching_pending`) with no figures;
    - after a standalone evaluation, fresh states and figures.
15. **Evaluation failure** (fault injected): the sync batch still commits, and `evaluated_version`
    stays behind. The aggregate returns `updating` (`matching_failed`) with no figures, and a retry
    resolves.
16. **Reader bracket:**
    - a sync committing between S and the last page forces a retry;
    - when every attempt sees a change (the harness commits a change during each attempt), the result
      is `updating` (`inputs_changing`) with **no totals and no ranges**;
    - a single interleaved change followed by a quiet retry returns correct figures for the new
      version.
16a. **Evaluator lock order and publication:**
    - the evaluator takes L1 then L2;
    - a lock-free update committed before L2 is granted is both counted in `v` and visible to the
      evaluation;
    - one still uncommitted when L2 is granted is neither, and leaves the user stale after commit;
    - an input written in the same transaction after step 3 leaves `input_version > evaluated_version`;
    - `evaluated_version` always equals the `v` read under L2;
    - evaluation under REPEATABLE READ raises inside the subtransaction and publishes nothing (a stale
      user stays stale).
16b. **The evaluator never deadlocks:** a lock-free transaction delete or update (holding L3,
    waiting on L2) runs concurrently with the evaluator 50 times. The evaluator never waits on L3,
    both complete, and no deadlock is reported. The derived tables have no FK to data rows.
16c. **An RPC vs a lock-free writer on the same row** (the documented cycle). Either both complete,
    or PostgreSQL aborts one with `deadlock_detected` and it rolls back completely. Afterwards,
    `evaluated_version = input_version` holds only if the surviving transaction evaluated after the
    last committed bump; otherwise the user is stale. A falsely fresh state never appears.
16d. **The account trigger's scope:** updating `nickname` / `color` / `sort_order` does not bump.
    Updating `exclude_from_cash_flow` to its current value does not bump either.
17. **Lineage** — every row of the §4.8 table:
    - both pending legs removed before either posts, in one batch and in separate batches;
    - Tc first, and Tk first;
    - posted before the removal of the pending row;
    - amount changed (invalidated, reason on the state, decision kept);
    - cancelled pending (`waiting_to_post` → `gone` → purge after 30 days);
    - single-leg decisions (`destination_unlinked`) and `not_this_pair`.

    Final links are identical across all orders. No decision row is deleted by a transaction delete.
17a. **Conflicting replacements (approved rule, 2026-09-30):** several posted rows on one account naming
    the same pending id stay `ambiguous_replacement`, unmatched, and never another leg's
    partner or candidate. This holds:
    - with a user pair, with a destination confirmation, with `destination_removed_card`, and with
      no decision;
    - with reordered inputs;
    - with the approved per-period bounds;
    - with excluded-account rows not counted.

    Rows on different accounts or of different users are not a conflict. A corrected snapshot with one
    replacement evaluates normally, with no manual action. *(Pure-evaluator coverage exists; the
    database evaluator must pass the same cases.)*
17b. **Second set of approvals (2026-09-30):**
    - a changed confirmation stays reserved: no leg of it is reused or offered as a candidate;
    - the $100 → $98 exception: −98 published, the decision inactive `amount_changed` on the leg and
      the decision, the leg reserved; the same for a return (−100 → −98 gives +98);
    - negative cases: an included card, a direction change, conflicting replacements, conflicting
      decisions, a changed role, a pair decision, an ownership failure. None of them publishes an
      effect through the exception;
    - the removed-card re-evaluation: a tier 1 match applies; no match with an included card stays
      unresolved; no included card gives `no_included_card`; a user confirmation and the conflict
      guard both win;
    - return suggestions at 60 days (yes) and 61 days (no), with an older original; the automatic
      5-day window unchanged; manual matching unrestricted;
    - excluded-card evidence listed against "unlinked", exact late and tier-1-shaped.

    *(Pure-evaluator coverage exists; the database evaluator must pass the same cases.)*
18. **LIM removal (T9):**
    - the pairs are converted before the deletes, in the same transaction;
    - cash legs become `removed_card`;
    - the version is bumped;
    - a failure rolls back the whole removal — a failure of the preservation-and-removal transaction
      itself. A failure of the final, best-effort evaluation commits the removal and leaves the user
      stale; a later evaluation recovers (§3.7; Trevor, 2026-10-06);
    - after relinking, re-imported matching legs re-track via tier 1 (precedence, §3.2);
    - an active user decision is never overridden by a later tier 1 pair; the pair is shown as a
      suggestion instead;
    - an explicit user confirmation that names a removed account survives the removal with its
      reservation, active or inactive, on either side, and its leg never pairs automatically with a
      competitor; a confirmation the user has since superseded is not carried forward (§4.7; Trevor,
      2026-10-06);
    - an unresolved leg whose candidates were on both sides of the removal is not resolved by it: it
      does not pair with the candidate that is left, publishes no effect, and resolves later only on new
      or changed evidence or by the user's decision (§4.7; Trevor, 2026-10-06);
    - the same where an account excluded from cash flow is involved, on either side, and for a payment
      the "no included card" rule decides: the ambiguity is judged on the complete matching pool, not on
      the published states; where there is none, nothing is written (§4.7);
    - a preserved confirmation whose removed side was invalid for a reason other than an amount stays
      reserved and unresolved whatever the surviving leg's amount later does; the "no included card"
      exception applies only where an amount is the only thing wrong (§4.7);
    - a payment that was automatically matched to the removed card keeps its recorded destination and
      is not switched to a card that was already there; a tie stays a distinct, unresolved case; new or
      changed evidence, a relinked card and the user's decision are evaluated as always (§4.7; Trevor,
      2026-10-06);
    - a lock-free writer holding an account row of the removed institution makes the removal wait; it
      does not deadlock (§3.7; Trevor, 2026-10-06). One holding the row of a surviving account that a
      hold names does not make the removal wait, and ends stale, never falsely fresh (§3.7).

    *(I3A candidate: `supabase/tests/access_control/sql/a18_lim_removal_card_payments.sql`,
    `a19_lim_removal_card_payments_atomicity.sql`, `a20_lim_removal_user_confirmations.sql`,
    `a21_lim_removal_user_intent.sql`, `a22_lim_removal_ambiguity_hold.sql`,
    `a23_lim_removal_excluded_accounts.sql`, `a24_lim_removal_frozen_invalidity.sql`,
    `a25_lim_removal_automatic_destination.sql`, concurrency `c26`–`c36`, and sequences Q9–Q15 of
    `supabase/tests/card_payment_evaluator/rpc_sequences.sql`.)*

    *(I3A-R packet 1, 2026-10-08: `a26_lim_removal_provenance.sql`, `a27_lim_removal_provenance_access.sql`,
    concurrency `c37`, and the harnesses that `PHASE_B_I3A_R_P1_REMOVAL_PROVENANCE.md` §10 lists. That packet
    also changes what `a18`, `a22` and `a25` require after a second removal.)*
19. **Role override away / to** card payment: decisions are invalidated, or the row joins the pool,
    in the same RPC. The evaluation runs before commit.
20. **Same-user ownership:**
    - every RPC refuses a leg, decision or account of another user, including a mixed pair (cash leg
      user A, card leg user B), with no information about the other user's rows;
    - the evaluator never pairs across users — two users seeded with mirror-image legs;
    - lineage resolution never maps a decision onto another user's row, even with a colliding
      `pending_transaction_id`;
    - `get_card_payment_states` returns only the caller's legs;
    - decisions whose `*_account_id` belongs to another user are refused.
21. **Concurrency** (holder/contender pattern of the access-control harness):
    - `link_card_payment` vs a sync batch touching either leg: serialized by the per-user lock; the
      link either lands and survives the sync, or is refused because `computed_at_version` changed —
      never lost or applied to changed data;
    - two links on the same leg: exactly one succeeds;
    - link vs role override on the same leg;
    - an account inclusion toggle vs evaluation;
    - a lock-free direct update during evaluation: the user ends stale, never falsely fresh;
    - a LIM removal vs a link on a leg of that card. *(I3A candidate: `concurrency/c26`–`c33` — both
      orders of removal vs link, vs a standalone evaluation and vs the posting of the surviving leg; a
      lock-free writer after the removal's publication; and the removal's L1-before-L2 order.)*
22. **Grants:** no `anon` / `authenticated` privilege on the new tables. RPCs are service-role only,
    SECURITY INVOKER, with an empty `search_path`. The trigger functions are executable by no role.
23. **Audit:** `supabase/tests/card_payment_audit/run.sh` passes (R1–R7 included).
    `confirmed_difference` and `unresolved_exposure` are never both non-NULL and non-zero on one
    bucket row.

**Frontend (vitest + testing-library):**
24. Every reason of §6.1 renders its text and actions. Each action sends the leg's
    `computed_at_version`. A refused stale action reloads the leg and shows its new state.
25. **T1 per the chosen option:**
    - range text, the review link and a hatched chart segment;
    - no month-over-month change when either month is unresolved;
    - "Updating…" and a retry for an `updating` result, with no range or number rendered.
26. **Review list:** counts match `cardPaymentsUnresolved` across periods.
