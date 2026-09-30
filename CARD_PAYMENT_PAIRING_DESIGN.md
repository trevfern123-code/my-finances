# Card-Payment Pairing — resolving Phase B §13 R3 (design proposal, rev 1)

Status: **proposal for review — nothing implemented.** No migration, endpoint or live calculation
changes. Written 2026-09-29 on `feature/phase-b-aggregation-slice1`, after Codex verified `aad4621`.
It completes option (a) of `FINANCIAL_SEMANTICS_PHASE_B_DESIGN.md` §13 R3 while preserving D5. The
decisions needed from Trevor are collected in §10, and acceptance tests are in §11. The read-only
audit draft is `supabase/preflight/phase_b_card_payment_matching_audit.sql` (§9). It has not been run
against production.

---

## 1. The problem, and what must stay true

R3 (Codex's reproduction, pinned by tests in `semanticAggregation.test.ts`):

| Rows (checking C, included card X) | Cash flow today | Correct |
|---|---|---|
| C +100 Sep 1, X −100 Sep 2, X +100 Sep 10, C −100 **Sep 16** | **+100** | 0 |
| C +100 Sep 1, X −100 **Sep 7** | **−100** | 0 |

These must not change:

- **D5 and the tracked-set principle** (§4.1, §4.3). A card payment moves cash flow only when money
  crosses the boundary of the accounts included in cash flow:
  - a payment to an unlinked or excluded card is an untracked outflow (subtracted);
  - its return is an untracked return (added);
  - a card leg funded from outside is informational (0).
- **The definition of cash flow** — income − spending − debt payments ± those boundary crossings. The
  audit (§9) sizes the problem and informs defaults and UI priority. It never changes the definition.
- **No silent widening of the ±5-day automatic window.** Anything beyond today's rule is either a
  suggestion the user confirms or a separately decided rule (§10).

## 2. The key observation

Under D5, **a credit-side leg never moves cash flow**, paired or not: paired it is 0, and unpaired it
is externally funded or reversed externally, also 0. Only **cash-side legs** move cash flow, so R3
reduces to one question per cash-side leg:

> Did this money go to (or come back from) a card that is included in cash flow?

There are three honest answers:

| Answer | Effect (D5, unchanged) |
|---|---|
| **Yes** — its counterpart is a leg on an included card | tracked: 0 |
| **No** — its counterpart is on an excluded card, or provably not on any included card | untracked: payment −amount, return +amount |
| **Not known yet** | **unresolved**: the truth is one of the two values above |

Today's module collapses "not known yet" into "no" whenever the counterpart is not within ±5 days.
That is the whole of R3.

**Why persisting today's ±5-day pairs alone does not fix R3.** It stores the "yes" answers the rule
already finds. The Sep 7 card leg and the Sep 16 return would still be unpaired, and would still be
counted as "no", so the numbers above stay wrong. The fix must:

1. represent "not known yet" explicitly;
2. gather the evidence that turns it into yes or no — automatic where the evidence is proof, the
   user's confirmation where it is only likely;
3. never publish a single figure that silently assumes one answer (§6).

**Transfers are not affected.** Both unpaired legs of a transfer count, by sign: out +100 → −100,
in −100 → +100, so a missed pair nets to 0 and only the labels are wrong. The asymmetry exists only
because D5 makes a card leg's credit side non-cash.

## 3. Model

### 3.1 Legs and the evidence pool

- A **card leg** is a transaction whose `effective_role` (override, else `auto_role`) is
  `credit_card_payment`.
  - **Credit side:** a leg on a `type = 'credit'` account.
  - **Cash side:** a leg on any other account.
  - **Direction:** on the cash side + is a payment and − a return; on the credit side − is a payment
    and + a reversal.
- **Evidence pool:** every card leg on **every linked account of the user, including accounts
  excluded from cash flow**. This changes today's pool, which drops excluded accounts before pairing.
  Pairing across all linked accounts tells us *where* the money went, and the tracked-set principle
  still decides the *effect* (§3.2). A leg on an excluded **cash** account is still ignored for cash
  flow entirely; it only serves as evidence (§4.6). *(Decision T5.)*

### 3.2 States of a cash-side leg

| State | Reason code | Effect on cash flow | How it arises |
|---|---|---|---|
| `tracked` | `auto_pair` / `user_pair` | 0 | Paired with a credit leg on an **included** card: automatically (§3.3 tier 1) or by the user |
| `untracked` | `partner_excluded` | payment −, return + | Paired with a credit leg on an **excluded** card |
| `untracked` | `no_included_card` | payment −, return + | The user has no included credit account at all |
| `untracked` | `absent_after_settle` | payment −, return + | Proof of absence (§3.4) |
| `untracked` | `user_not_linked` | payment −, return + | The user said "this went to a card I haven't linked" |
| `unresolved` | `awaiting_card_leg` | one of the two | No candidate yet; §3.4 not yet satisfied |
| `unresolved` | `card_not_syncing` | one of the two | An included card's item is not active or has not synced since the settle date |
| `unresolved` | `possible_match` | one of the two | An exact-amount candidate the automatic rule cannot use (> 5 days, §3.3 tier 2) |
| `unresolved` | `amount_differs` | one of the two | A near-amount candidate within 5 days (fee shape) |
| `unresolved` | `ambiguous` | one of the two | An exact candidate within 5 days, but a tie or not reciprocal |

Two defaults apply everywhere:
- **No state = unresolved** (`awaiting_card_leg`). A leg that has not been evaluated yet — for example
  between a sync commit and its reconciliation — is never treated as untracked.
- **Credit-side legs** get `paired`, `externally_funded` (the same absence proof, mirrored) or
  `unresolved`, for labels and suggestions only. Their cash-flow effect is always 0.

### 3.3 Evidence rules

**Tier 1 — automatic pairing (today's rule, unchanged).**
- The match: exact opposite cents, opposite side, |days| ≤ 5.
- It must be reciprocal: the closest candidate wins, a tie is ambiguous, and each leg must be the
  other's best match.
- The only changes are where and when it runs:
  - over the user's **full history** at reconciliation time, not a fetch pad;
  - over the evidence pool of §3.1.
- The result is stored (§3.5) and its effect is derived from the partner account's *current* inclusion.

**Tier 2 — candidates (never applied automatically).** For a leg left unpaired by tier 1, a candidate
is an unpaired leg on the opposite side of the evidence pool, of one of these shapes:
- *exact amount* 6 – H days away (`possible_match`), with H = 60 *(T2)*;
- *near amount* within 5 days: |Δ| from 1 cent to $5.00 *(T2)* (`amount_differs`);
- *return-of-pair*: a cash-side return and a credit-side reversal of equal cents on the **same two
  accounts** as an earlier tracked pair, both dated after it and within H. This is the strongest
  shape, shown first. *(T3: suggest, recommended, or apply automatically.)*

A candidate the user has dismissed is never suggested or paired again.

**Tier 1 can dissolve.** A later row can make an automatic pair ambiguous, for example a posted row
whose date moved. The pair then dissolves into `ambiguous`, and the figure becomes a visible range
(§6). A user pair never dissolves by automation; it goes only when a leg is deleted or its amount
changes (§4.8).

### 3.4 Proof of absence (the only automatic "no" without a partner)

A cash-side leg with no tier 1 partner and no tier 2 candidate becomes `untracked`
(`absent_after_settle`) only when both of these hold:
1. it is at least S = 10 days old *(T4)*;
2. **every included credit account's item** is `active` and has synced successfully
   (`plaid_items.last_synced_at`) on or after the leg's date + S. A card leg cannot arrive from an item
   that is not syncing; otherwise the reason is `card_not_syncing`.

If a counterpart arrives later anyway, the leg becomes `possible_match` again. A past month then
changes from a single figure to a range; it is visible and never silent.

The absence proof relies on one assumption: **a card leg does not post more than S days late**. That
is why S is a decision (T4). The alternative is no automatic absence at all: every unmatched payment
would wait for the user whenever they have an included card.

### 3.5 What is stored

All new tables are service-role only (no client privileges, RLS on, no policies), follow the
per-user advisory lock every writer takes, and cascade on transaction delete.

- **`card_payment_links`** — decisions and pairs:
  - columns: `id`, `user_id`, `cash_transaction_id`, `credit_transaction_id` (null for
    `no_tracked_counterpart`), `kind` (`pair` | `no_tracked_counterpart` | `not_this_pair`), `source`
    (`auto` | `user`), `difference_cents` (user pairs only; 0 for exact), `created_at`, `decided_at`;
  - uniqueness: a leg is in at most one `pair`, and `not_this_pair` is unique per
    (cash, credit).
  - Reconciliation rewrites `source = 'auto'` rows and **never** writes, changes or deletes a
    `source = 'user'` row — the same guarantee `user_role_override` has.
- **`card_payment_leg_states`** — the derived state per card leg:
  - columns: `transaction_id` (PK), `user_id`, `side`, `state`, `reason`, `partner_transaction_id`,
    `candidate_ids`, `evidence_through` (the settle/sync date the evaluation relied on), `evaluated_at`,
    `version`;
  - derived and fully recomputable from `card_payment_links` + transactions + accounts + items.
    Storing it means the aggregation needs **no pairing context** for card legs, which removes the
    card half of the fetched-context contract (`PAIRING_PAD_DAYS` stays for transfers only).
- **Continuity carry-over**: `transaction_carryovers` gains `card_payment_decisions jsonb` (§4.8).

### 3.6 Where it runs

- **Reconciliation** (a new pass in `roleReconciliation.ts`'s style) runs after each sync batch
  commits, under the per-user lock. It is bounded and deterministic:
  - it covers the legs touched by the batch, every leg within ±(H + 5) days of them, and every leg
    whose state cites a touched row;
  - the same data gives the same links regardless of batch order (reciprocity makes it
    order-independent, as for transfers).
- **Full user sweep** when any of these happens:
  - an account's `exclude_from_cash_flow` changes;
  - an institution is removed or relinked;
  - an account's type changes;
  - the backfill runs.
- **User actions**, each an RPC under the lock with a compare-and-swap on the legs' state `version`
  (a stale screen is refused, never applied to changed data). Each re-evaluates the affected legs and
  returns their new states in the same transaction:
  - `link_card_payment(user, cash_id, credit_id, versions, accept_difference)`: refused if the cents
    differ and `accept_difference` is false. If either row's `effective_role` is not
    `credit_card_payment`, it is refused unless the call asks to set both overrides — the two-row
    correction of §4.9;
  - `unlink_card_payment`: user pair → `not_this_pair`;
  - `mark_card_payment_not_linked(user, cash_id, version)`;
  - `dismiss_card_payment_candidate`;
  - `undo_card_payment_decision`.

## 4. How each case is handled (examples)

In every example, C is an included checking account, X an included card, E an excluded card and F an
excluded savings account. "X" in a figure is the month's cash flow excluding these legs.

### 4.1 Late payment (card leg more than 5 days late)
Sequence for C +100 on Sep 1 whose card leg posts Sep 7:
1. **Sep 1–6:** `awaiting_card_leg` → range [X − 100, X], with the note "Waiting for Sapphire to
   show this payment".
2. **Sep 7 sync:** the card leg arrives. Tier 1 does not pair them (6 days), so both legs are
   `possible_match` — still a range — and the suggestion reads "Sep 1 payment ↔ Sapphire credit
   Sep 7 (6 days apart)".
3. **The user acts:**
   - **Confirm** → user pair → `tracked` → X.
   - **Reject** → `not_this_pair`. The cash leg re-evaluates to `absent_after_settle` → X − 100 (a
     real unlinked-card payment). The card leg becomes `externally_funded`.

If the card leg had posted on Sep 4, tier 1 would pair it automatically and the range collapses with
no action. Today's module shows −100 permanently in the 6-day case.

### 4.2 Returns
- **Codex's case.** The Sep 1/2 pair is tracked. The reversal X +100 (Sep 10) and the return C −100
  (Sep 16) are 6 days apart, so tier 1 does not pair them. They are the return-of-pair shape (same C
  and X, same cents, after the tracked pair), so:
  - both are `possible_match` → range [X, X + 100];
  - the suggestion reads "Looks like your Sep 1 payment to Sapphire was returned";
  - confirming gives a tracked return pair → X.
  - With T3 = automatic, it pairs without action.
- **Payment and return to an untracked card.** C +100 Sep 1 and C −100 Sep 12 have no candidates.
  After S, with the included cards synced, both are `absent_after_settle`: −100 and +100 → net X,
  with no user action. This is unchanged from today.
- **Return on an excluded card.** E +100 and C −100 within 5 days pair (tier 1, pool includes E) →
  `untracked` / `partner_excluded` → +100, immediately.

### 4.3 Fee (amount) differences
C +100.00 Sep 1, X −98.00 Sep 2:
- Tier 1 never pairs unequal cents, so the legs are `amount_differs` → range [X − 100, X].
- The user can link with the difference accepted. The pair stores `difference_cents = 200`:
  - the matched 98.00 is tracked (0);
  - the unmatched 2.00 is an untracked outflow (−2.00), labelled "unmatched part of card payment". The
    money left checking and did not reach an included card — exactly D5's boundary rule applied to
    the remainder.
  - Cash flow: X − 2.
- The same rule covers currency rounding. If the card also shows a separate $2 fee row, that row is
  ordinary card spending and is not part of this pair.

### 4.4 Ambiguous matches
- **Two payments, one card credit.** C +400 Sep 1, C +400 Sep 3 and X −400 Sep 2 tie, so nothing
  pairs automatically. All three are `ambiguous`.
  - The bounds are per leg and deliberately conservative: [X − 800, X]. The truth is X − 400 or X.
  - The user picks which payment the credit belongs to. The chosen pair is tracked; the other payment
    re-evaluates (awaiting → absence or a new candidate).
- **One payment, two card credits.** C +400 Sep 1, X −400 Sep 2 and Y −400 Sep 2 give the same
  treatment; the user picks the card.
- **A new row breaks an automatic pair.** The pair dissolves into `ambiguous` (§3.3); a user pair
  stays.

### 4.5 Unlinked card
C +250 goes to card Z, which was never linked:
- **No included credit account at all:** `untracked` / `no_included_card` → −250 immediately, with no
  range. Linking a card later triggers a sweep.
- **The user has included card X:**
  - `awaiting_card_leg` until S has passed and X has synced (range for up to about 10 days);
  - then `absent_after_settle` → −250;
  - the user can end the wait at once with "This went to a card I haven't linked" → −250
    (`user_not_linked`).
- A per-payee remembered rule ("payments named … go to an unlinked card") would remove the monthly
  wait. It is **not** included — a possible later addition.

### 4.6 Excluded accounts
- **Payment to an excluded card.** C +500 Sep 1 and E −500 Sep 2 pair in tier 1 →
  `partner_excluded` → −500 immediately, labelled "to Sapphire, which you excluded from cash flow".
  - If E is later included, the sweep makes it `tracked` → 0 for that month. History follows the
    current tracked set, as D5 intends.
- **Excluded cash account funding an included card.** F +300 and X −300 pair. F's leg is ignored for
  cash flow (tracked set); X's leg is labelled "funded from an excluded account", 0. Unchanged D5.

### 4.7 Removal, relinking and stale institutions
- **LIM removal of the card's institution.** Its transactions are deleted and the links cascade. The
  sweep re-evaluates the cash legs: there is no included card leg anymore, so they become
  `absent_after_settle` → untracked, and past months change from 0 to −amount.
  - This is correct under D5 (the tracked set shrank).
  - The removal confirmation must say so: "Payments from your other accounts to this card will count
    as money leaving your tracked accounts."
- **Card item in `login_required` / not syncing.** Its legs cannot arrive, so affected cash legs stay
  `card_not_syncing` → range, with "Reconnect Sapphire to finish matching 2 payments". Reconnect and
  sync resolve them.

### 4.8 Pending → posted
- **Pending legs take part** in tier 1 and tier 2 like posted ones (their state shows "pending"). Most
  card payments appear pending on the checking side first.
- **On posting**, the pending row is removed and the posted row inserted in one
  `apply_synced_transaction_batch_v2` call:
  - automatic links on the pending row cascade away;
  - the posted row has no state until reconciliation runs → unresolved, never untracked (§3.2);
  - reconciliation then re-derives its automatic pair from current data.
- **User decisions on a pending row** — a user pair, `no_tracked_counterpart`, or dismissals — are
  copied into the carry-over's `card_payment_decisions`. They are re-applied to the posted row by the
  same RPC **only if** the posted amount equals the pending amount **and** the partner still exists.
  Otherwise they are dropped, the posted row gets a `review_note` ("Card-payment match cleared: amount
  changed from 100.00 to 98.00"), and the leg re-evaluates. This is the C1 rule of the continuity
  design.
- **Either side may post first, in any sync.** A user pair stored in a carry-over names its partner
  by row id. If that partner has itself posted, the lookup follows the partner's carry-over to its
  `consumed_by_transaction_id`. This makes the result independent of arrival order, as continuity
  already is.
- **A posting that moves the date outside ±5 days** turns an automatic pair into `possible_match`,
  visibly.

### 4.9 Role and amount changes
- **User overrides a leg away from `credit_card_payment`.** Its links (user links too) are removed in
  the same override RPC, the D9 "dependents reset under the lock" pattern, and the partner
  re-evaluates.
- **User overrides a row *to* `credit_card_payment`.** It joins the pool, and the same RPC evaluates
  it.
- **Plaid modifies a posted row's amount.** Automatic links recompute. A user pair survives only if
  both legs' cents are unchanged; otherwise it is dropped with a review note.

## 5. What the aggregation module becomes (pure, still no I/O)

- **Inputs:** each card leg arrives with its stored state (`state`, `reason`, partner account id,
  `difference_cents`). The module no longer pairs card legs itself, so the ±5-day card window and the
  card half of `PAIRING_PAD_DAYS` leave the module. Transfers are unchanged.
- **Outputs:**
  - the existing tracked, untracked and returned lines, now fed from states;
  - `cashFlowLow` / `cashFlowHigh` and `savingsRateLow` / `savingsRateHigh`;
  - `cardPaymentsUnresolved { count, paymentsAmount, returnsAmount, byReason }`;
  - `cashFlow` is a single number **only when** nothing is unresolved.
- **Invariants:**
  - low ≤ high;
  - high − low = Σ |cash-side unresolved amount|;
  - with nothing unresolved, low = high = today's D5 figure computed from the resolved states.
- **Tests:** the two `it.fails` tests in `semanticAggregation.test.ts` become passing tests. Their
  correct figure is reached through a stored user pair (or a return-of-pair decision under T3), and
  the characterization tests are replaced by the §11 acceptance tests.

## 6. What users see while a payment is unresolved

### 6.1 Per payment (independent of the headline decision)
- **Transaction list:** a chip reading "Card payment · not matched yet", with the reason in plain
  words and the one action it needs:

  | Reason | Text | Actions |
  |---|---|---|
  | awaiting | "Waiting for Sapphire to show this payment — usually 1–3 days." | "It went to a card I haven't linked" |
  | card_not_syncing | "Sapphire hasn't synced since Sep 3. Reconnect to finish matching." | Reconnect · "Card I haven't linked" |
  | possible_match | "Is this Sapphire's $100.00 credit on Sep 7 (6 days later)?" | Match · Not this one |
  | return-of-pair | "Looks like your Sep 1 payment to Sapphire was returned." | Match return · Not this one |
  | amount_differs | "Sapphire shows $98.00 on Sep 2. Match, and count the $2.00 difference as money that left your accounts?" | Match with difference · Not this one |
  | ambiguous | "Two payments could match Sapphire's $400.00 credit on Sep 2 — which one?" | Pick one · Neither |

- **Overview / Cash Flow:** a "Card payments to review (2)" entry, opening a list of every unresolved
  leg across periods.
- **Unaffected:** Budget and Spending (card payments are never spending), Net worth and Liquid cash
  (balance-based).

### 6.2 The headline figures — **Trevor's decision T1** (not assumed)
Any period with an unresolved cash-side leg has two possible D5 values. There are three ways to show
them:

- **(A) Range — recommended.**
  - Display: "Cash flow **$1,100 – $1,200**" with the line "1 card payment ($100) isn't matched yet —
    Review".
  - The savings rate is shown the same way ("18 % – 20 %").
  - Charts: the bar is drawn to the conservative bound, with a hatched segment to the other bound. A
    month-over-month change is shown only when both months are resolved.
  - Pro: never displays a number that may be wrong. The common case (a card leg 1–3 days behind)
    collapses automatically when the leg arrives.
  - Con: more UI work, and ranges in the current month for a few days after each card payment.
- **(B) Withhold** — the affected period's cash flow and savings rate show "—" with "Needs review: 1
  card payment" until resolved. This is strict, like the Q3 split refusal. The current month would be
  blank for days after most card payments.
- **(C) One provisional number with a warning**, assuming either tracked or untracked. **This displays
  a possibly incorrect total with a warning, which is not accepted by default.** It is only an option
  if Trevor explicitly accepts it and chooses the assumption.

The API carries the full information for any of the three, so T1 affects only the frontend slice:
- `cashFlow: number | null` (null iff unresolved);
- `cashFlowRange { low, high }`, `savingsRateRange`;
- `cardPaymentsUnresolved`.

Legacy fields stay frozen per D11.

## 7. D5 preservation check

| Situation | D5 effect | This design |
|---|---|---|
| Payment to an included card (paired) | 0 | `tracked`, 0 — now also when > 5 days apart, once confirmed |
| Payment to an unlinked card | −amount | `absent_after_settle` / `no_included_card` / `user_not_linked`, −amount |
| Payment to an excluded card | −amount | `partner_excluded`, −amount (now proven by pairing) |
| Its return (untracked) | +amount | same states, +amount |
| Card leg funded from outside or an excluded account | 0 (informational) | credit-side leg, always 0 |
| Not known yet | — (D5 had no such state) | both D5 values reported; the headline per T1 |

No row is counted under a new definition. The only new thing is refusing to guess between two D5
values.

## 8. Implementation outline (for sizing; not written)

1. **Migration:**
   - the two tables and the carry-over column;
   - RPCs (`link_card_payment`, `unlink_card_payment`, `mark_card_payment_not_linked`,
     `dismiss_card_payment_candidate`, `undo_card_payment_decision`);
   - `apply_synced_transaction_batch_v2` extended to carry `card_payment_decisions` — or a v3 if
     coexistence with an old backend requires it, as continuity did;
   - indexes on `(user_id, cash_transaction_id)`, `(user_id, credit_transaction_id)` and
     `(user_id, state)`;
   - grants, and postconditions as in the continuity migration.
2. **Reconciliation pass and full-sweep entry points; dry-run mode.** The pairing backfill runs with,
   and after, the Phase A backfill. It joins that **release gate**.
3. **Pure module change (§5):** the fixture extended with stored states.
4. **Frontend:** the chip, the review list, and T1's headline treatment.
5. **Rollback:** drop the new objects. The aggregation falls back to Phase B slice 1 behaviour only in
   a disconnected build — never in a live one, which is the reason for the release gate.

## 9. The read-only audit (draft, not run)

- **File:** `supabase/preflight/phase_b_card_payment_matching_audit.sql`. It has two single-SELECT
  statements.
- **Validation:** checked only against synthetic rows in a throwaway local container of Supabase's
  PostgreSQL 17 image, in a read-only session. Reproduce with
  `supabase/tests/card_payment_audit/run.sh` (28 synthetic rows; each bucket asserted in
  `expected.out`).

**What it respects:**
- user overrides first, then the stored `auto_role`, then — for the NULL rows the Phase A backfill has
  not reached — the classifier's own row-level rules. These are the only source of
  `credit_card_payment`; reconciliation never produces it.
- `role_basis` reports which of the three applied;
- the tracked set.

**Buckets map onto §3.2:**

| Audit bucket | Meaning under this design |
|---|---|
| `confirmed_paired_within_5d` | tier 1 → `tracked` |
| `possible_exact_amount_6_to_60d`, `possible_tie_or_not_reciprocal_5d`, `possible_amount_differs_within_5d` | `unresolved`: `possible_match` / `ambiguous` / `amount_differs` — **today counted wrongly or at risk** |
| `possible_partner_on_excluded_card` | `untracked` / `partner_excluded` (today untracked too, but by absence) |
| `unknown_no_included_card` | `untracked` / `no_included_card` |
| `unknown_recent_no_candidate`, `unknown_no_candidate` | `awaiting_card_leg` or `absent_after_settle` (depends on sync recency) |
| `out_of_scope_*` | not card payments under the current classification (low-confidence fallback → debt payment, overridden away, or excluded) |

`current_rule_cash_flow_effect` is what today's module adds to cash flow for each bucket. Summed over
the `possible_*` buckets, it is the size of the error R3 describes.

**Output is minimal:** counts, distinct-user counts and amounts per bucket. It includes no ids, names,
dates or institution names, and reads no token column.

**Sandbox:** the Plaid environment belongs to the deployment. If production ran on Sandbox throughout,
every row is Sandbox data. Items are still split by Sandbox institution ids and names, and by an
optional list of known test users; everything else is labelled `not_identified`, **not** "real".

**How to use the results:** they set the T2/T4 defaults and the UI priority. They do not choose
between definitions — the definition is D5, unchanged.

## 10. Decisions needed from Trevor

| # | Decision | Recommendation |
|---|---|---|
| **T1** | Headline figures while unresolved: (A) range, (B) withhold, (C) provisional number + warning | **(A)**. (C) only with your explicit acceptance, since it can show an incorrect total |
| **T2** | Candidate horizon H and near-amount tolerance | H = 60 days, $5.00 — suggestions only, so a wider H costs only occasional dismissals |
| **T3** | Return-of-pair: suggest (user confirms) or apply automatically | **Suggest.** Automatic would be a new automatic matching rule beyond ±5 days |
| **T4** | Proof of absence after S days with fresh syncs, S = ? — or no automatic absence (every unmatched payment waits for the user when they have an included card) | **Allow, S = 10 days.** Set by the audit's recent/late distribution. A later-arriving leg reopens the month visibly |
| **T5** | Use excluded accounts' legs as pairing evidence (effect still per tracked set) | **Yes.** It proves "to an excluded card" instead of inferring it |
| **T6** | Fee-difference pairs: count the difference as an untracked outflow/return | **Yes.** It is D5's boundary rule applied to the remainder |
| **T7** | Automatic pairs in already-closed months may dissolve when new data creates ambiguity | **Yes, visibly** (the month shows a range). The alternative freezes a possibly wrong pair |

## 11. Acceptance tests

**Pure module (vitest), from stored states:**
1. **Late leg** (C +100 Sep 1, X −100 Sep 7):
   - unconfirmed: range [−100, 0], `cashFlow = null`;
   - user pair: 0;
   - `not_this_pair` plus absence: −100.
2. **Codex return:**
   - unconfirmed: range [0, +100];
   - return pair confirmed: 0. Today's `it.fails` test becomes `it`.
3. **Untracked card payment and return:** −100 + 100 → 0, with no user action.
4. **Fee pair with difference 2.00:** −2.00; without the link, range [−100, 0].
5. **Tie (two payments, one credit):** three unresolved legs, bounds [−800, 0]. After the user picks:
   one tracked, and the other's bounds follow its new state.
6. **Excluded card partner:** −500 with no range. After inclusion is toggled and states swept: 0.
7. **Excluded cash account funding an included card:** 0, label "funded from an excluded account".
8. **No included credit account:** −250 immediately, with no range.
9. **Invariants on generated histories** (clustered dates, as in slice 1):
   - low ≤ high;
   - high − low = Σ |unresolved cash-side|;
   - resolved ⇒ low = high = the D5 value;
   - a credit-side leg never changes either bound.
10. **Missing state → unresolved**, never untracked.
11. **Result independent of rows outside the period:** no pad needed for card legs.
12. **Transfers:** unchanged figures on the full §9.1 fixture.

**Reconciliation and RPCs (real-PostgreSQL harness, throwaway container):**
13. Tier 1 is deterministic and independent of batch order.
14. An exact candidate 6–60 days away is **never** paired automatically (T3 = suggest), and is listed
    as a candidate.
15. **Absence:**
    - requires S elapsed **and** every included credit item active with `last_synced_at` ≥ date + S;
    - a stale item keeps `card_not_syncing`;
    - a later-arriving counterpart reopens the leg.
16. **User decisions are never overwritten** by reconciliation reruns, the full sweep or the backfill.
17. **Link RPC:**
    - a stale `version` is refused;
    - unequal cents are refused without `accept_difference`;
    - a non-card role is refused unless both overrides are requested;
    - everything happens under the per-user lock;
    - concurrent sync plus link: the link either lands and survives, or is refused — never lost.
18. **Pending → posted:**
    - same amount: the user pair is carried;
    - changed amount: dropped, `review_note` set, leg unresolved;
    - partner posts first, second, or in a later sync: same final links.
19. **Override away** removes the leg's links in the same RPC; **override to** card payment joins the
    pool.
20. **LIM removal of a card's institution:** links cascade. The sweep turns the cash legs untracked,
    and the months change exactly by the removed payments.
21. **Grants:** no `anon` / `authenticated` privilege on the new tables; RPCs are service-role only,
    SECURITY INVOKER, with an empty `search_path`.
22. **Audit check:** `supabase/tests/card_payment_audit/run.sh` passes.

**Frontend (vitest + testing-library):**
23. Each reason in §6.1 renders its text and actions. Each action calls its RPC with the leg's
    `version`, and the chip updates from the response.
24. The headline follows T1:
    - (A) the range text, the review link, and a hatched chart segment;
    - no month-over-month change is shown when either month is unresolved;
    - a single number appears when resolved.
25. **Review list:** counts match `cardPaymentsUnresolved`, across periods.
