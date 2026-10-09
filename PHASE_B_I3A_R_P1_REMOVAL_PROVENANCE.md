# Phase B, I3A-R packet 1: removal provenance

**Status (2026-10-09): implementation candidate, validated locally (§12) and independently audited. The audit found no implementation defect and required documentation corrections before commit; they are the policy amendment below and the corrections marked "corrected 2026-10-09" in §6, §11 and §12. Uncommitted, unpushed, not released.** Nothing here was run against a hosted database. Local, disposable databases only.

- Branch `feature/phase-b-i3a-r-provenance`, created from `43302e4a0b9dc1fb0f56046463b90ccf7adffa51` (I3A revision 5, the head of draft PR #17).
- One migration with a rollback script: `20261008120000_card_payment_removal_provenance.sql`. Two new tables, their two guard triggers, and one replaced function body, `remove_plaid_item_local(uuid, uuid)`.
- No backend, API, frontend, dependency or workflow change. Neither evaluator changes. No decision RPC changes.

**This packet settles nothing.** No hold is ended. No record is retired. There is no automatic settlement and no manual recovery action, RPC, route or screen. Nothing reads the new tables. Open question 7 of `PHASE_B_I3A_LIM_REMOVAL_MATCHING.md` (a payment that keeps reading "removed card" after its institution is linked again) is exactly as open as it was.

What the packet does: it makes sure that what a later, separately approved packet needs in order to answer that question safely still exists by then. An institution removal deletes the rows its protections depend on. What is not recorded at that moment cannot be recovered afterwards.

## Policy amendment (2026-10-09)

This amendment was recorded following the independent audit of this packet. The policy had already been approved before that audit and was supplied in the original audit request. This amendment records that existing approval; it does not create a new one. 2026-10-09 is the date of this amendment, not of the approval. It is the approved policy for everything that comes after provenance capture. Where earlier text in this document, in `PHASE_B_I3A_LIM_REMOVAL_MATCHING.md` or in `CARD_PAYMENT_PAIRING_DESIGN.md` recorded the question as unresolved or pointed to an automatic route, this amendment governs.

| | Policy |
|---|---|
| **P-Y** | Permanent release of a historical matching protection requires explicit user authorization, scoped to the relevant source or dependencies |
| **P-D** | Retirement of removed-destination evidence requires separately identifiable authorization. P-Y does not implicitly authorize P-D |

- **One workflow may ask for both.** A single, clearly explained review workflow may collect both permissions. Their meanings stay distinct, and so does the recorded authorization.
- Reliable account/event correspondence is evidence, not consent. Similar institution, mask, amount and date—even an exact descriptive match—do not establish reliable correspondence by themselves.
- **Required before production activation:** a narrowly scoped review safeguard for affected relinked-transaction matching, and a reachable user-assisted recovery workflow.
- **This packet implements provenance capture only.** It does not implement settlement, user recovery, the review safeguard or production activation.

Current implementation examples include system ambiguity holds for P-Y and `destination_removed_card` records for P-D. These are nonexclusive examples, not definitions limiting policy scope. P-Y requires explicit authorization for permanent release of the named historical matching protections and their source dependencies. P-D requires separately identifiable authorization to retire removed-destination evidence. Neither permission grants the other. User-confirmed decisions and reservations retain their separate precedence and undo/supersession rules.

**What the older documents recorded as unresolved, and what is superseded.**

- *Historical, recorded as unresolved.* The older documents recorded as unresolved what should happen after the removed institution is linked again: open question 7 of `PHASE_B_I3A_LIM_REMOVAL_MATCHING.md` §9.3. That text is kept as it was written. This amendment does not decide the question anew; it records the policy that had already been approved.
- *Superseded.* The I3A-R roadmap that preceded this packet carried an automatic route as an option for the owner: permanently releasing protections, and retiring removed-destination evidence, without the user's authorization when a removed transaction made an "exact return". Where that conflicts with P-Y or P-D it no longer stands. No automatic step permanently releases a protection or retires removed-destination evidence. A return, however exact, is not authorization.
- *Unchanged.* Everything this packet does. It ends no row and reads none of what it records. A user's own decision is still never an input of any settlement (§2, item 4). The other decisions of §11 stand.

The remaining packets are not redesigned here.

## 1. The defect

Before it deletes an institution, `remove_plaid_item_local` writes three kinds of decisions about the legs that survive (I3A §3):

| | Decision | Whose |
|---|---|---|
| (a) | `pair_counterpart_removed`: a pair the user confirmed, kept on the surviving leg | the user's |
| (b) | `destination_removed_card`: a record that a payment was matched automatically to a removed card | the system's |
| (c) | `ambiguity_hold_removed_card` / `_cash_account`: a hold that keeps a pair of two surviving legs from forming while a removed candidate would have been at least as close | the system's |

Each exists because of **one** removed transaction: its *source*. Revision 5 kept of that source a date (on a hold), a Plaid id and an amount (on a user pair), or nothing (on a record). And it merged:

- Statement (c) wrote one hold per pair and date. Two removed candidates with the same date became one row: two payments on one removed card on one day, or one on each of two removed cards. A later removal wrote no hold where an earlier removal's hold with the same pair and date was still live.
- Statement (b) wrote no record where a live record with the same key existed, whichever removal had written it.

For what is published that is complete. The evaluator needs the pair and the date, and one row withholds as well as two. But a row could not say which removed transactions it depends on, and one row could depend on several. Ending such a row because one of its sources is known to be back would also end the protection that another, still absent, source justifies.

Adding a removal id to the merge key would not repair this. Two transactions on one removed account with the same amount and date would still collapse, and a row would still not name its source.

## 2. The contract

1. **One system row per source.** (b) writes one record for each (surviving cash leg, removed partner). (c) writes one hold for each (owner, removed candidate, kept candidate). A removal never reuses, extends or suppresses a row because a similar one exists. (a) is unchanged: one decision per user pair.
2. **Every row a removal writes has exactly one provenance row**, written in the same transaction, before the delete, from the live rows. The function counts what it planned, what it wrote and what it recorded, and removes nothing if they differ. No other decision ever has a provenance row: it is written by the removal while it runs and never backfilled.
3. **A source event is `(removal_id, source_plaid_account_id, source_plaid_transaction_id)`.** Two removals differ in the first part. Two transactions on one removed account differ in the last, whatever their amounts and dates. One source can justify several rows; each carries it, and they describe it identically.
4. **User decisions stay apart.** Every provenance row says what its source was to the surviving leg:

   | `source_relation` | Meaning | On |
   |---|---|---|
   | `confirmed_counterpart` | the other leg of a pair the **user** confirmed | a `pair_counterpart_removed` decision, and only there |
   | `automatic_partner` | the leg the evaluator had matched the surviving leg to | a record; a hold whose removed candidate was that match |
   | `removed_candidate` | a competing candidate that was not the match | a hold |

   A `confirmed_counterpart` row is on the user's decision. Only the user ends it. It is never an input of any settlement. The table's trigger ties the relation to the decision kind in both directions.
5. **What was observed is recorded, and nothing else.** A system row's source always had one current row. A source that cannot be read is refused, never recorded as missing. Only a confirmed pair's reference can have resolved to something else:

   | `source_resolution` | What was there | What is recorded |
   |---|---|---|
   | `row` | one current row | its Plaid id, pending id, pending flag, date, cents, currency |
   | `waiting_to_post` | no row; an unconsumed carry-over of the removed pending row, which the removal also deletes | the carry-over's date and amount |
   | `ambiguous` | several rows named the reference | none of them (see §8, limit 3) |
   | `gone` | nothing | nothing |

   No transaction id, date or amount is invented. The reference and the cents the user confirmed stay on the decision, as before.
6. **Nothing published changes** (§5).

## 3. What is stored

`card_payment_removal_generations`: one row per removal the provenance knows of.

| Column | |
|---|---|
| `removal_id` | primary key; the ledger row in `plaid_item_removals`, which already keeps the item's id, its Plaid item id and the institution name |
| `user_id` | must be the ledger row's user |
| `ordinal` | the order, per user, in which removals became known to the provenance. Assigned by the trigger under the user's advisory lock; a supplied value is ignored |
| `sources_recorded` | `true`: run by this body, with provenance. `false`: a marker for a removal that finished without provenance (§4) |
| `institution_id` | the item's `institution_id` as it was; NULL when it had none, and on a marker. Descriptive |
| `recorded_at` | transaction start. Does **not** order removals; `ordinal` does |

`card_payment_removal_sources`: one row per decision a removal wrote.

| Column | |
|---|---|
| `decision_id` | primary key; the decision. Deleted with it |
| `user_id`, `removal_id` | the generation, by a composite foreign key: one user throughout |
| `source_relation`, `source_resolution` | §2, items 4 and 5 |
| `source_plaid_account_id` | the removed account's Plaid id |
| `source_plaid_transaction_id` | the removed row's Plaid id; NULL when there was no single row |
| `source_pending_transaction_id`, `source_pending`, `source_date`, `source_cents`, `source_iso_currency_code` | the removed row as the evaluator read it. A NULL pending flag is recorded as false |
| `source_account_type`, `source_account_subtype`, `source_account_mask` | descriptive only |

**Not stored:** access tokens or any credential, account numbers, balances, account names and official names (free text), transaction names or merchants, accounts that are not a source, and any other transaction of the removed item.

The new tables reference the decision, the ledger row, the generation and the user. They reference no account, item or transaction, so the provenance survives the delete it describes.

### Limits of the identifiers

Plaid issues new item, account and transaction ids when an institution is linked again. The repository stores no identifier that is stable across a relink, and this packet invents none.

- The stored ids are **historical**. They show that two rows share a source. They can never show that a source has returned.
- Type, subtype and mask describe an account. They are not identity. Plaid documents that a mask may be absent and may repeat within an institution.
- A later packet must bring its own evidence of correspondence, or the user's confirmation. Nothing may infer it from institution, mask, amount and date alone.
- Rows written by successive removals for one pair and date, or for one leg, are separate dependencies. Settling one never implies another.
- Every system row without a provenance row is unattributed and stays protected. That includes rows written before this packet and rows written while it was rolled back.

## 4. Removals that ran without provenance

A removal run by the revision 5 body (before this migration, or while it is rolled back) records nothing and merges as §1 describes. It also merges into a live row that carries **another** removal's provenance. That row then stands for a source it does not name.

Timestamps cannot say which rows that affected. `cleaned_at` and `recorded_at` are transaction start times, and calls queue on the user's advisory lock, so a later removal can carry an earlier time. The order is recorded instead:

- Every generation gets an `ordinal`, per user, assigned under that lock.
- The first statement of the preservation block gives every earlier cleaned removal of this user that has no generation row a **marker** (`sources_recorded = false`), before the removal's own generation.
- A removal marks only its own user's removals. Another user's unrecorded removal waits for that user's next removal, which runs under that user's lock.

**The rule a later packet must apply before it relies on a row's provenance:** a system row written by generation G is known to depend on its recorded source alone only if the user has no marker with a greater ordinal than G, and no cleaned removal without a generation row.

Removals made before this migration get markers that precede every recorded generation. They cast doubt on nothing.

## 5. What does not change, and three things that do

No state, reason, detail, partner, effect, range or candidate list changes. The evaluator is not touched and reads none of this. Identical live holds withhold as one: its hold list has no key and the withholding is "any hold that applies". Several live records on one leg read as one.

Three things differ from revision 5. None is a figure.

1. **Row counts.** More system rows exist after same-date removed candidates or after a second removal, and the reader's `decisions` list is longer. A removal writes what it would have written had no earlier row existed: rows are added per removal, never multiplied by the rows already there. Nothing in this packet retires them, so they accumulate across relink-and-remove cycles (§10).
2. **Which record a leg names.** With several live records the evaluator keeps the least decision id. A leg's `decisionId` is therefore not an attribution, and never the leg's complete set of dependencies. A later packet must enumerate a leg's live records and holds and join the provenance table. It must not go through the leg state. No application code reads `decisionId` or the `decisions` list today.
3. **The reading after a full rollback to the evaluator before `20261006110000`.** That rollback script's case (iii) says two holds on one leg read `conflicting_decisions` where one reads `not_cash_side`, and an undo there must be repeated per hold. Same-date candidates and second removals now fall under that existing case. The legs are claimed and unresolved either way.

## 6. The function

The body is revision 5's with these edits and no other. The migration was generated from the reviewed body by exact replacements; the unchanged statements are byte for byte the reviewed ones.

- The item row's `institution_id` is read with its status.
- The preservation block first writes the markers and the generation, then creates and empties a scratch table of the transaction (`pg_temp.rpp_plan`), like the evaluator's.
- Statements (a), (b) and (c) keep their selects, joins and predicates. They write to the plan instead of the decisions table: each row with the id its decision will get, and its source.
- (b) no longer skips a leg that has a live record. (c) no longer says `DISTINCT` and no longer skips a pair that has a live hold with the same date.
- The plan is then written: the decisions, with the columns and in the order each statement used; and one provenance row for each, read in one statement from the removed account and transaction rows, which still exist.
- The function checks that every planned decision was written and has its provenance row.

Everything else is unchanged: the locks and their order, the strict evaluation before, the loan restoration, the counts, the delete, the ledger row, the best-effort evaluation after, the result.

**Failures.** Every new statement is inside the existing preservation block. If any fails, the block raises the existing refusal ("known card-payment destinations could not be preserved (SQLSTATE …); nothing was removed") and the whole call rolls back. The removal stays `plaid_removed` and can be retried. There is no path on which the delete proceeds without the provenance, and no fallback that records less.

A cleaned removal is replayed before any of this and writes nothing. A second execution that got past the replay and the status check would stop at the generation insert: at its guard (the removal is no longer running), or at its primary key while the removal is still `plaid_removed`. The migration's header names only the key; this is the exact statement.

**Locks.** No new lock class and no new order. The two tables are not inputs of the evaluator and have no version-bump trigger.

*(corrected 2026-10-09)* This paragraph used to call the KEY SHARE lock on the user's `auth.users` row "one difference in extent", taken on every removal "where revision 5 took it only when it wrote a decision or a state". The saved probe does not show that. In the measured case — a user with no card-payment leg, where the removal writes no decision and no state — revision 5 already takes that lock (`supabase/tests/lim_removal_lock_comparison/results/2026-10-09_packet1.txt`, the EXTENT lines: `user_row=locked` under `20261006120000` and under `20261008120000`, `free` only under `20260926120000`). Revision 5 takes it at the delete, whose version bump re-checks the foreign key. This packet takes it earlier in that case: at the generation insert, before the delete. In both cases it is taken after L1, the account rows and L2. What this packet does add is KEY SHARE on the ledger row of each earlier cleaned removal that gets a marker (`earlier_removal=locked` under `20261008120000` only).

The inexact sentence is also in the migration's header, in its LOCKS section: `supabase/migrations/20261008120000_card_payment_removal_provenance.sql`, lines 190 to 192 ("One difference in extent: … where 20261006120000 took it only when it wrote a decision or a state. A concurrent deletion of that user is the existing detected-deadlock case, now for every removal."). The migration is not edited for a comment: its bytes are the ones every run was made on. That header sentence is superseded by this paragraph. A concurrent deletion of the user has been the detected-deadlock case for every removal since `20261006120000`.

## 7. Ownership, access, retention and redaction

**Access.** Row security is on for both tables, with no policy. No client role has any privilege. The service role may SELECT and INSERT, nothing else. No API response gains a field.

**Ownership.** Triggers enforce what a foreign key cannot:

- A generation's user is its ledger row's user.
- A recorded generation is inserted only while its removal is running (ledger status `plaid_removed`). A marker is inserted only for a removal that is finished.
- A provenance row's user is its decision's user and its generation's user.
- Its decision is of a kind a removal writes, and its relation fits that kind.
- Its generation is recorded, running, and was written in the same transaction. Its account is an account of the item being removed.
- It agrees with its decision: a hold's date is its source's date; a confirmed pair's reference is its source's id or the pending id that row replaced.
- Where it says there was a row, a transaction with that Plaid id, date and amount is on that account.

Their messages are fixed and carry no value. A generation's ordinal and time are assigned by its trigger, whatever an insert supplies.

What the triggers cannot know: which of the removed account's transactions was the surviving leg's partner or candidate, and whether a decision was written by the removal it is attached to. Inside one transaction that has itself written a recorded generation, a row for an older decision of the same user would pass. The function writes its plan and nothing else, and the tests pin that.

**Retention.** A provenance row lives exactly as long as the decision row it explains. A decision row is deleted only with a surviving account it names, or with its user. An undone or replaced decision is superseded, not deleted, and its provenance stays with it. So retention is: while the surviving account stays linked. That is not a bounded time. There is no orphaned evidence and no purge job. (`CARD_PAYMENT_PAIRING_DESIGN.md` §3.5 intends a purge of decisions whose lineage has been gone for 30 days. None is built. If it is, a provenance row goes with its decision.)

**Redaction.** Three classes of columns:

| Class | Columns | Rule |
|---|---|---|
| Identity | `decision_id`, `user_id`, `removal_id`, `source_relation`, `source_resolution`, `source_plaid_account_id`, `source_plaid_transaction_id`; a generation's `ordinal` and `sources_recorded` | never changed, by anyone: the triggers refuse it |
| Evidence | pending id, pending flag, date, cents, currency | kept while the decision is live |
| Descriptive | `source_account_type`, `source_account_subtype`, `source_account_mask`; a generation's `institution_id` | nullable, in no constraint, read by nothing: can be set to NULL at any time |

No application role can change or delete a row, and this packet adds no path that ends a system row. Until one exists, redaction is an operator action as the tables' owner.

**The packet that ends rows must redact when it ends them.** When a decision that has a provenance row is settled, undone or replaced, its descriptive columns are set to NULL in the same transaction. That is a release condition of that packet.

**What a removal keeps is more than before.** Revision 5 kept, of a removed candidate, its date; of a confirmed pair's removed leg, its Plaid id and cents. The two approved documents are amended where they said so (§9). The application's removal confirmation, its connections screen and the README say that removing an institution deletes "everything imported from it"; whether that wording should change is a product decision (§11).

## 8. Known limits

1. The provenance cannot show that a source has returned (§3).
2. Retention is unbounded while the surviving account stays linked, and redaction has no application path yet (§7).
3. For a confirmed pair whose reference had become ambiguous, the several rows that named it are deleted and none is recorded. One provenance row per decision cannot represent them. The decision is an invalid user confirmation: it never settles, and it records that the lineage was ambiguous.
4. A removal that ran without provenance casts doubt on every system row of that user that was live then (§4). The rule is conservative: it excludes rows the removal did not in fact merge into.
5. System rows accumulate across relink-and-remove cycles (§5, §10).
6. A decision can still be deleted or re-kinded by the service role directly, as before. No application path does. A provenance row is exactly as deletable as its decision.
7. The triggers check that a described row exists on the named account. They cannot check that it is the right one (§7).
8. The function's count check compares the plan with what the provenance statement reports having written. It catches a statement that writes fewer rows. It is not independent of that statement: were the statement itself removed from the function, a removal that plans only holds would pass the check. The installed function always runs it, and the tests and negative controls pin that (§10).
9. A generation's `recorded_at` carries the same-transaction rule, and no application role can change it. The tables' owner can; the trigger's immutability list does not name it.

## 9. Migration and rollback

`20261008120000` applies only on top of the exact revision 5 body, the `20261006110000` evaluator and reference rule, the `20260930120000` best-effort wrapper and the `20261001120000` lineage rule. Its DDL is repeatable, and its postcondition verifies the exact shape of both tables, their grants, their triggers and the installed body.

The rollback script re-creates the revision 5 body verbatim, checksum-verified, and keeps both tables and every row. It compares both tables row for row with what they held when it began.

**Rollback order is now three steps:** this packet's script, then `20261006120000`'s, then `20261006110000`'s. The two older scripts refuse while this body is installed. Their messages do not name this packet ("… is not the 20261006120000 definition; refusing to roll back"; "roll back 20261006120000 first").

While rolled back, removals record nothing and merge. That is recorded, not silent: when the migration is applied again, each such removal is marked by the next removal of that user (§4). The supported path is to roll back and apply again before any feature that settles by source is enabled.

**This packet supersedes sentences it may not edit**, because the revision 5 migration files and rollback scripts are not rewritten. The new migration's header names the first two of these; the third is recorded here:

- `20261006110000`: "the date of the removed candidate. Nothing else of it is kept, and nothing references it." and "that account is gone and nothing references it". More is kept, beside the decision. No foreign key references it.
- `20261006120000`: "a leg that already has a live system record with exactly the same key gets no second one." It gets one per removal. A hold is no longer merged by pair and date either, which that file's body did without its header saying so.
- The rollback script of `20261006110000` says "Roll back 20261006120000 FIRST". Two scripts come first now. Its case (iii) lists when two holds meet on one leg; several holds on one pair after same-date candidates or a second removal are now routine. Its case (v) says an undone hold is undone for good; that holds only where the pair has no other live hold.

`CARD_PAYMENT_PAIRING_DESIGN.md` and `PHASE_B_I3A_LIM_REMOVAL_MATCHING.md` are amended in place. Every edit carries the words "I3A-R packet 1" on one line, as "amended 2026-10-08, I3A-R packet 1", "added 2026-10-08, I3A-R packet 1" or "Since (2026-10-08, I3A-R packet 1".

## 10. Tests and evidence

Every expected value was derived by hand from the fixture and the contract before the test was run. Tests assert identities: which decision, which removal, which removed account and transaction. A count alone is never the assertion.

### 10.1 Access-control suite (`supabase/tests/access_control`)

| Test | New or changed | What it pins |
|---|---|---|
| `a26_lim_removal_provenance` | new | The contract: 74 requirements. Each says what it needs: `rows` (visible in the decisions table alone; revision 5 merges there), `provenance` (needs the new tables), `unchanged` (a published reading that must be the same under both bodies) |
| `a27_lim_removal_provenance_access` | new | Access and integrity of every new object: catalog, runtime refusals per role, every guard predicate and every CHECK with its exact message, immutability, redaction, the four deletion cascades, scratch-table reuse, cross-user isolation, an empty-string Plaid id, user deletion |
| `c37_two_lim_removals_same_date_sources` | new, concurrency | Two removals of one user at once, same amount and date: each writes its own hold with its own source; the second waited on the user's advisory lock |
| `a18`, `a22` (case G), `a25` (cases H, O2, O3) | changed | After a second removal: the rows revision 5 merged are now written, each with its source; the readings are what they were |
| `a19` | changed | Atomicity: three failure injections into the new writes (the provenance row, the generation, a silently skipped row); nothing is removed and the fixed refusal is raised |

Cases of `a26`:

| Case | What is exercised |
|---|---|
| A | two removals protecting one pair with one date |
| B | two removed payments identical in account, amount and date |
| C | a repeated call and further evaluations write nothing |
| D | several dependencies on one payment; one source on several rows |
| E, F | an automatic match; a tie that stays unresolved |
| G | the mirror: a removed cash leg; the kept card leg's match is recorded on its hold |
| H, H2 | excluded accounts on both sides |
| I1, I2, I3 | a source's pending lineage; a pending source; a pending surviving payment that posts |
| J1 to J4, JW, JA | the user's confirmations: active, re-priced, gone, card side surviving, waiting to post, ambiguous |
| K | another user: isolation, and every refusal of a cross-user or late row |
| L | a removal whose provenance cannot be written removes nothing; then the real one |
| P | a NULL pending flag does not block a removal |
| R | a second removal after a relink: two records; the leg names the least id |
| U | an unrecorded removal is marked by the next removal of the same user, never by another user's |
| N, O, GEN, INV | bystanders unchanged; provenance outlives the rows; generations; whole-table invariants |

Against revision 5 (the same tests without this migration): 7 of the 22 removal tests fail, as intended. `a26` holds 24 of its 74 requirements there: the 4 `rows` requirements fail (the missing behaviour), the 46 `provenance` requirements fail (no schema), and **all 24 `unchanged` requirements hold**.

### 10.2 Harnesses

| Harness | New or changed | What it shows |
|---|---|---|
| `lim_removal_matching_mutations` | re-bound to this body | Negative controls. The harness refuses to mutate any text but the installed body. Result in §12 |
| `card_payment_removal_provenance_rehearsal` | new | Upgrade, a removal with provenance, rollback keeping every row, a removal while rolled back (it merges, unrecorded), re-apply, the marker, the rule of §4 evaluated row by row, the three-step rollback chain. A twin database stays on revision 5: the published readings are compared |
| `lim_removal_matching_rehearsal` | one line | Revision 5's own rehearsal; its baseline now also skips this migration |
| `lim_removal_lock_comparison` | three bodies | The lock order under each body, and what every removal takes on `auth.users` |
| `card_payment_evaluator` | extended | SQL against the TypeScript reference: duplicated holds and records in the generated corpus, scenarios S98 to S113, RPC sequences Q16 to Q19 through this body |
| `card_payment_benchmark/removal` | bound to this body | Added cost against revision 5, row growth, plans |
| `replay` | unchanged | Picks the migration up by itself |

### 10.3 Performance (`card_payment_benchmark/removal/results/2026-10-09_packet1.txt`)

Local, synthetic, on a busy machine: counts and work counters are exact; timings are slow and noisy.

- **Where nothing was merged**, the removal writes the same decisions plus one generation and one provenance row each. Whole-removal time is within the spread of the samples (ratio 0.96 to 1.03 at 1,000 and 10,000 rows). WAL grows 5 to 12 %.
- **Where revision 5 merged**, more rows are written, and time follows the rows. Same-date candidates: 800 / 3,200 / 12,800 holds against 400; removal about x1.2 / x1.6 / x2.2. Where owners, removed candidates and kept candidates of one amount grow together, the rows grow with the cube (revision 5: the square); removal about x1.2 / x1.7 / x3.6 to x4.1. Per row, time and work are flat. These are stress shapes.
- **Rows accumulate** across relink-and-remove cycles: one full set per removal, and nothing retires them. Evaluation and read cost grow linearly with them (about +95 ms of removal per earlier removal of 300 rows, on the quieter run).
- **The lock** is held for the whole removal, as before. Every millisecond added is added to what other writers of that user wait.
- **Statement timeout.** The benchmark session has none. The image configures 8 s for the role an API request starts as. On this machine revision 5 already runs 7 to 16 s at the largest ordinary fixtures. Whether 8 s applies to the service-role call is not established (§11, decision 5).
- Nothing is unbounded per row. What is unbounded is the number of rows: by the number of same-amount legs within five days, and by the number of removals.

### 10.4 Not covered

- `a22` case N has no negative control, and three revision 5 controls are now stopped by the guard before their behavioural assertion.
- The full-size 5-sample benchmark runs at 50,000 rows and the full `cycles` run were not done. No benchmark fixture populates `transaction_carryovers`; a scratch plan with it populated is cited in the results file.
- Nothing was run against a hosted database.

## 11. Decisions that remain with the owner

None of these blocks the independent review of this packet. Each has a recommendation; none is decided here.

| # | Decision | Recommendation | Why it is the owner's |
|---|---|---|---|
| 1 | The wording "everything imported from it" in the removal confirmation, the connections screen and the README | Reword before release, for example: "A minimal record of card payments to or from it is kept so that your remaining accounts stay correct" | What a removal keeps is now more than a date and an amount (§3, §7). It is user-facing text and a privacy statement |
| 2 | What is kept of the removed account: type, subtype and mask; not the name | Keep as built | The three are the descriptive fields a later recovery screen and any corroboration would use. The name is free text and can carry a person's name. What is not captured now cannot be captured later; what is captured can be redacted |
| 3 | When the descriptive fields are redacted | When the row is ended, in the packet that ends rows | This packet ends no row. Until then retention lasts while the surviving account stays linked |
| 4 | Whether the function's count check should read the table instead of the statement's row count (§8, limit 8) | Optional hardening, one statement. It changes the function body, so the body-bound runs would be repeated | Robustness against a later edit that removes the statement. Not a defect of the installed function |
| 5 | The statement and lock timeouts that apply to the removal call in the hosted project | Confirm the hosted role settings and how the API applies them to a service-role request, before release | On the loaded test machine the largest ordinary fixtures already run 7 to 16 s under revision 5; the image configures 8 s for the role a request starts as. This packet adds to it at stress shapes only (§10, performance) |
| 6 | Comment-only pointers in files this packet may not edit: the two earlier rollback scripts' headers, `backend/src/services/itemRemoval.ts`, `backend/src/services/dataService.ts`, `README.md` | Add them with the commit that lands this packet, if the owner allows comment-only edits there | Their statements are incomplete with this migration applied, not false. This packet touches no backend, frontend or earlier migration file |
| 7 | The seven lines of `PHASE_B_I3A_LIM_REMOVAL_MATCHING.md` that were reworded in place rather than inside a dated parenthesis | Accept | The sentences are true as they stand; the alternative is to restore the old words and put the correction after them |

*(corrected 2026-10-09)* This paragraph used to list three product decisions of the I3A-R reconciliation as open: whether automatic settlement requires an exact return; what a payment reads while a possible return waits for the user; the manual recovery actions. The policy recorded in the amendment at the top of this document governs the first: permanent release requires the user's explicit authorization (P-Y), retirement of removed-destination evidence requires separately identifiable authorization (P-D), and no return settles anything automatically. The other two are still to be designed, within that policy. Open question 7 of `PHASE_B_I3A_LIM_REMOVAL_MATCHING.md` was recorded as unresolved. The policy that governs it is recorded in that amendment and is not implemented: what this packet's code does is exactly what that question describes.

## 12. Validation run

2026-10-09, on the frozen candidate, one check at a time, local disposable databases only. The inputs (everything under `supabase/` and `backend/src`, and the package manifests) were identical before and after.

| Check | Result |
|---|---|
| Removal tests on this body (`a18`–`a27`, `c26`–`c37`) | **22 passed, 0 failed.** `a26` 74 of 74; `a22` 46 of 46; `a25` 72 of 72 |
| The same tests on revision 5 (this migration excluded) | 15 passed, 7 failed, as intended (§10.1) |
| Revision 5's tests without both removal migrations | 0 passed, 8 failed, as documented for revision 5 |
| Full access-control suite | **64 passed, 0 failed** |
| Lock comparison | all 17 cases and 3 extent probes as documented, over three bodies |
| Evaluator equivalence | 826 user evaluations, 0 differ (300 generated histories, 113 scenarios); 74 against hand-derived outcomes, 0 differ; RPC sequences 19 scenarios, 66 evaluations, 0 failures |
| Migration replay (emulator and the pinned Supabase CLI 2.117.0) | 11 passed, 0 failed |
| Card-payment audit | passed |
| Revision 5 rehearsal | passed: 24 steps, fifteen snapshots |
| Provenance rehearsal | **passed: 33 steps, sixteen snapshots and the twin's two** |
| Backend typecheck, tests, build | clean; 46 files, 1,631 passed, 3 todo; clean |
| Whitespace check of the whole candidate | clean |
| Negative controls | **96 harness rows = 1 unmodified baseline + 95 mutants. Of the 95 mutants, 92 are detected by the named assertions and 3 survive by design (redundant filters). The baseline passes every test, as it must. 0 unexpected.** Every row with its expectation and its outcome: `supabase/tests/lim_removal_matching_mutations/results/2026-10-09_packet1.txt`. *(corrected 2026-10-09: this row used to count the baseline among "4 survive by design"; the baseline is not a mutant.)* |
| Benchmark and its plans | reused: measured on these migration bytes (md5 `f840ef9e6bbb97cfb94df1c756a4760f`), which did not change afterwards |

The function body is `cc12b7a12c6510924781b93c658ee854`; revision 5's is `7997a757408fa888aa44bdbc9d85f89d`.
