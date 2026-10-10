# Phase B, I3A-R packet 2-A: guarded manual recovery

**Status (2026-10-09): local implementation candidate, corrected once after an independent triage. Unstaged, uncommitted, unpushed, not accepted, not released.** Nothing here was run against a hosted database, and no hosting or production setting changed. Its validation results are in the evidence export that accompanies the candidate, not in this file.

**Correction pass (2026-10-09).** The first candidate was triaged independently and not accepted. Four things changed, and this file describes the corrected state:

- **Capture reads the graph, not the decisions (§3.1).** The first candidate found affected payments only through the decisions a removal writes. A payment whose candidates were ALL removed gets no decision, so it got no obligation, and a later unrelated transaction could pair with it unguarded. That was a defect of a new removal — available facts dropped — and not lost history. It is corrected.
- **A missing receipt is not "not saved" (§9).** The first screen read "no receipt found" as a confirmed non-commit and let the user drop the operation. A receipt is invisible while its transaction is open. The outcome now stays unknown.
- **Queued is not executing (§8, §9).** The first screen said figures "are being brought up to date" whenever a queue row existed. With no worker running, nothing does that. It now says queued.
- **The existing tests were updated (§14)** under a nine-file extension of the allowlist, each expectation derived by hand from the approved contract; the RPC comparison now carries the recovery inputs and compares the review metadata.

**Second correction pass (v3, 2026-10-10), frontend only.** The corrected candidate was reviewed independently again. Its database and server behaviour (the capture, the RPC comparison) was accepted and is unchanged here, byte for byte. Two things in the screen were not accepted, and this file describes their corrected state:

- **An unresolved change outlives the screen (§9.1).** The corrected screen kept the operation id and the request in the open component only: closing the review, opening it from the other entry, reloading the page or signing in again forgot them, and a different change could then be sent while the first was still undecided. The operation is now recorded in the browser, per user, **before** it is sent, and restored wherever the review is opened.
- **"Queued" says nothing more (§8, §9).** The corrected screen said "it has not run yet", which a queue row cannot establish: an attempt may be running, or may have failed. It now says only: "A refresh is queued. The figures are not up to date."

Three updated assertions of the first correction pass went beyond the assertions that pass had named, inside files it was allowed to change. Their retention was approved explicitly on 2026-10-10 (§14).

**Third correction pass (v4, 2026-10-10), frontend and one test runner.** The v3 candidate was reviewed independently. The queue wording was accepted; the database and server behaviour stays accepted and unchanged. Two things were not accepted, and this file describes their corrected state:

- **The browser record was not safe between two tabs of the same user (§9.2).** Recording, noting and resolving each read the record, decided and wrote, and another tab could change the record in between: a tab could overwrite an unresolved change it had not seen, and a late answer for one change could remove or rewrite the change that had replaced it. v3 said a second tab "cannot write a second one"; that was not true without exclusion. Every change of the record is now made under an exclusive lock of that user's journal (the browser's Web Locks), with the record read again inside it, and an answer changes the screen only while the screen still shows the operation it belongs to. Where the lock cannot be had, nothing is changed and nothing is sent.
- **The TypeScript mutation runner could not run (§11).** One of its mutants looked for the sentence v3 had replaced, so the runner stopped before its baseline. It is repaired and runs unfiltered again.

§9 now names all five answers that decide nothing when a request is sent again; v3 named three.

- Branch `codex/phase-b-i3a-r-packet-2a-review`, created from `218a1eb34b93c2aed39c2daba84c66181e53a9ef` (I3A-R packet 1 plus the CI image correction).
- One migration with a rollback script: `20261009120000_card_payment_recovery_review.sql`.
- Backend: one service, one controller, one router, one worker, two flags. Frontend: one review component and its two entries. One new database harness.
- Product contract: Trevor's approval of 2026-10-09 (four choices), on the design and addendum of the same date. This file states what was built; where it makes an engineering choice inside that contract, it says so.

**This packet retires nothing.** No ambiguity hold is ended. No removed-destination record is retired. No review obligation is discharged. There is no "reviewed" switch, no release of the guard, no settlement of a source, and no check that a returned transaction is the removed one. P-Y and P-D (the policy amendment in `PHASE_B_I3A_R_P1_REMOVAL_PROVENANCE.md`) stay two separate permissions for later, separately approved work. What a user can do here is decide **the current payment**, with the decisions that already existed.

## 1. The problem

After an institution is removed, the removal keeps what was known about the payments that survive: a hold (H) on a pair that a removed candidate stood in the way of, and a record (D) of a removed destination. Both are about the legs that existed then.

A transaction that appears afterwards is none of those legs. The ordinary matcher pairs it by amount and date alone. So a payment whose history says "its card was removed" could silently read **tracked, $0** against a transaction nobody reviewed:

| | What arrives after the removal | Before this packet |
|---|---|---|
| E7 | an unrelated card payment of the same amount, one day from the payment | pairs automatically: $0 |
| E2 | the removed card, linked again, with its payment on the original day | pairs automatically: $0, with H and D still stored |

The fixture throughout: K, a payment of $370 from checking on the 10th. Its card X was removed; X's side was dated the 11th. Y, a payment into a card that stays, is dated the 12th. The removal left D on K and H on K/Y. Database amounts are cents: 37000.

## 2. What was approved

1. **Safeguard scope.** Only historically affected payments. After normal reciprocal selection and the existing hold vetoes, withhold — both ways — a remaining selected pair unless its surviving-edge membership is positively established for every relevant obligation on either leg, coverage gaps included. No next-best match. No freeze of an owner or an institution. Correspondence alone bypasses nothing.
2. **Publication.** User decisions, reservations and frozen invalidity keep their precedence. A withheld pair is published as such **before** the record D, which stays stored.

   | Withheld leg, no controlling user decision | Reads |
   |---|---|
   | Included cash leg; an included card exists | unresolved / `relink_review_required`; no scalar effect; bounds min(0, −cents) to max(0, −cents) |
   | Included cash leg; no included card | untracked / `no_included_card`; effect −cents; review state kept |
   | Included card leg | unresolved / `relink_review_required`; effect 0 |
   | Leg on an excluded account | not counted / `excluded_account`; effect 0; review state kept |

   A fresh range is uncertainty. A stale, missing or unsupported result is never a range, a total or zero.
3. **Actions.** Current pairing and "a card I haven't linked" are the existing decisions. Rejecting a suggestion rejects that suggestion at that revision of the evidence. Defer is workflow only. Dismissing a candidate is the existing dismissal and can change the figure. Ordinary undo resurrects nothing. No action grants anything to a later transaction.
4. **Unknown history.** A, B and every gap stay separate. Seeding uses only what is retained. Histories whose anchors are all gone are an activation gate, not something to reconstruct.

## 3. Definitions as built

### 3.1 Review obligation

An obligation names an **affected payment**: a surviving leg that had an eligible candidate on the institution being removed.

**Who is affected is read from the eligible graph**, before the delete, from the complete pool of the strict evaluation the removal has just run:

- **The cut.** Every tier 1 edge — the evaluator's own rule: both legs in the pool, opposite sides, exactly opposite cents, at most 5 days apart, not dismissed — between a leg on an account that **stays** and a leg on an account of the item being **removed**. The staying leg is an affected payment. The removed leg is a **source** of its obligation.
- **And** the surviving leg of every user-confirmed pair the removal preserves. A user decision holds that leg, so it is not in the pool and has no edge.

Whether the removal also writes a decision for the payment makes no difference:

| The payment at the removal | The removal writes | Affected |
|---|---|---|
| matched automatically to a removed leg; a kept leg also fitted | a record and a hold | yes |
| matched automatically to a removed leg; nothing else fitted | a record | yes |
| tied between a removed leg and a kept leg | a hold | yes |
| **tied between removed legs only; nothing kept fitted** | **nothing** | **yes** |
| **matched to a kept leg; a farther candidate was removed** | **nothing** | **yes** — its match is a known edge and stays |
| a surviving card leg whose cash candidates were removed (the mirror) | a hold, or nothing | yes — the card leg; no record is ever written for a card leg |
| held by the user's confirmation of a removed leg | the preserved confirmation | yes |
| no eligible candidate on the removed institution | nothing | no |

There is one obligation per (affected payment, removal). The payment is named by its lineage reference — account, Plaid id, cents — **with no foreign key**. The row stays when the account, the decision or the provenance row it came from is deleted. It goes only with its user.

Each obligation keeps its **sources**, one removed transaction at a time:

- For a removed transaction the removal **wrote a decision** about: one row per decision, with the removed transaction copied from the decision's provenance row (packet 1). Two decisions are two rows.
- For a removed candidate it **wrote no decision** about: one row of kind `graph_source` per (obligation, removed transaction) — the removal, the removed account and transaction, its date and cents — read from rows that still exist. **It names no decision. None is invented, and nothing is added to packet 1's provenance tables.**
- A removed transaction that a decision of the same removal already names for that payment gets no second, graph-only row.

The capture checks itself against the graph: it counts the cut a second time, straight from the pool, and requires every edge of it to be represented by an obligation and a source. If not, the removal is refused and nothing is removed. (The first candidate checked itself against the plan of decisions, which is empty exactly where it matters.)

**History this does not reach.** A removal that ran before this migration, or while it was rolled back, recorded no graph. Its payments are seeded from the decisions that were retained (§3.2). A payment of such a removal that got no decision cannot be identified now. That is the anchorless-history gate (§13), not this capture.

### 3.2 Known surviving edge

Each obligation lists the edges it positively knows: the other leg of every pair that joined the affected payment to a leg that **survived that removal**, in the evaluator's eligible pool immediately before it.

- **Captured** (a removal run with this migration): every such edge, read from the complete pool — excluded accounts included — after the strict evaluation and before the delete. Not only winners, and not the published states.
- **Seeded** (history that existed before this migration): a hold names one such edge, and that is all that is recorded. A record names none.
- An edge is a pair of **lineages**. A pending row that posts is the same leg. A corrected amount is still the same two legs; whether they match is for the ordinary rules, as before.
- A leg that a user decision held at the removal was not in the pool. It has no known edge. **So after the user undoes a preserved confirmation, the payment's pair with a card that was already there is withheld and reads a range** — the removal knew no edge of that payment, and that the card was there with the right amount is not one. This is the approved rule applied to that case; it needs no further decision. Undo is not always a range: an edge every obligation of the payment lists still matches, and the no-included-card rule still applies.
- A payment whose automatic match stayed has that match as a known edge. It keeps matching. A newcomer that would take the match's place is withheld.
- A removed transaction that comes back did not survive that removal. It is never a known edge.

Membership is not eligibility. The evaluator still decides whether a listed pair is the automatic match today.

### 3.3 Gaps

A gap is its own obligation and lists nothing.

| Gap | When |
|---|---|
| `unattributed_decision` | a retained hold or record has no provenance row |
| `unrecorded_removal` | a removal of this user recorded no sources: it has packet 1's marker with a later ordinal than the obligation's removal, or it is cleaned with no generation row at all |

A later complete capture does not remove an earlier gap.

### 3.4 The guard

Tier 1 and the holds are computed exactly as before. Then, for each automatic pair that is left: if either leg is an affected payment, the pair stays only if **every** obligation on either leg lists it. Otherwise it is withheld in both directions. Nothing is selected in its place. Both legs stay in the pool, as candidates of each other and of anything else.

Why E1 differs from E7: in E1 the return is on the 14th, so K/Y is still the selected pair and H already withholds it. The guard has nothing left to withhold, and K reads D: −$370. The rule is not "a relink happened, so show a range".

### 3.5 Old results

Each publication of the new evaluator stamps its user (`card_payment_evaluator_contracts`, contract 2). The reader returns states only for a stamped user. The migration and its rollback delete every stamp. So nothing published by another evaluator is ever read as current, and after the migration every user is unreadable until evaluated again. The migration registers that refresh for every user with a version row.

New obligations and known edges are matching inputs: inserting one advances the owner's input version in the same transaction.

## 4. User authority is unchanged

- A leg held by a user decision — active or inactive — is outside automatic matching. The guard never sees it.
- An explicit pair gives the existing result ($0 when both accounts are included and the amounts are equal). H, D and the obligation remain.
- A different amount must be accepted explicitly: `acceptedDifferenceCents` = |cash| − |card|, exactly.
- A newer explicit decision supersedes an older one. The receipt names what it superseded. Undoing the newer one does not bring the older one back.
- A record or a hold cannot be undone: it is not the user's.
- Exact applied-loan reversal on removal is untouched.

## 5. Database

### 5.1 Objects

| Table | Holds | Service role |
|---|---|---|
| `card_payment_review_obligations` | §3.1, §3.3 | select, insert |
| `card_payment_review_obligation_sources` | one row per removal-written decision, and one per removed candidate no decision was written for (`graph_source`, no decision id) | select, insert |
| `card_payment_review_memberships` | §3.2 | select, insert |
| `card_payment_review_states` | derived, per evaluation: legs under review | select, insert, delete |
| `card_payment_evaluator_contracts` | §3.5 | select, insert, update |
| `card_payment_review_revisions` | a per-user counter of review changes | select, insert, update |
| `card_payment_review_annotations` | rejected suggestions, deferrals | select, insert |
| `card_payment_recovery_actions` | receipts, key (user, operation id) | select, insert |
| `card_payment_recovery_refresh_queue` | one row per owner to refresh | select, insert, update, delete |

Row security is on with no policy. No client role has any privilege. No table references an account, a transaction, a decision or an item.

### 5.2 Replaced functions

All three are generated from the committed bodies by exact replacement; the migration pins the previous and the new checksums.

- `remove_plaid_item_local`: packet 1's body plus one statement inside the preservation block, after its count check: `card_payment_review_capture` (§3.1). If the capture fails — or finds that it did not cover the cut — the existing refusal applies and nothing is removed.
- `evaluate_card_payments`: three scratch tables; the guard after the holds; the withheld-leg branch between tier 1 and the record; the review states; the stamp; removal of the queue work the publication satisfies. The removal still reads `cpe_pool`, `cpe_txn`, `cpe_dismissed` unchanged. `cpe_tier1` is as before less the withheld pairs, so a withheld leg reads as a leg with no automatic match — which is what it publishes. The capture reads edges from `cpe_pool`, never from `cpe_tier1`.
- `get_card_payment_states`: requires the stamp; adds `evaluatorContract` and `reviews` beside `legs`. The leg objects are unchanged.

The four decision RPCs are not changed. The migration checks their checksums.

### 5.3 Interfaces

| Function | Contract |
|---|---|
| `get_card_payment_recovery_reviews(p_user_id uuid, p_cursor text, p_limit integer) → jsonb` | One snapshot. Legs under review with history, gaps, candidates (suggestions only) and figures — only when fresh. Otherwise the count and no figure. Newest first; cursor `date|id`, validated; limit 1–50. |
| `apply_card_payment_recovery_action(p_user_id uuid, p_operation_id uuid, p_expected_input_version bigint, p_expected_review_revision bigint, p_action jsonb) → jsonb` | §5.4 |
| `get_card_payment_recovery_action(p_user_id uuid, p_operation_id uuid) → jsonb` | The receipt, or `found: false`, with current freshness read separately. `found: false` means **no receipt is visible now**: an action writes its receipt in its own transaction, and another session sees nothing until it commits. It is not "not saved". |
| `request_card_payment_recovery_refresh(p_user_id uuid, p_operation_id uuid) → jsonb` | §8.2 |
| `claim_card_payment_recovery_refresh(p_worker_token uuid, p_limit integer) → jsonb` | §8.1 |
| `refresh_card_payment_recovery_owner(p_user_id uuid, p_lease_token uuid) → jsonb` | §8.1 |

Every function is SECURITY INVOKER with an empty search path and executable by the service role only. Seeding and the trigger functions are executable by no application role.

For a payment that reads a definite state (its record, a user decision) the leg state carries no candidate list. The review reader then derives suggestions from the same evaluation's leg states, by the evaluator's suggestion shapes. This is an engineering choice: without it the user could not choose the return in E1.

### 5.4 One action, one transaction

Order inside `apply_card_payment_recovery_action`:

1. READ COMMITTED; the user's advisory lock (L1).
2. The receipt of this operation id. Same intent: return it (`replayed`). Other intent: refuse.
3. The review revision the user saw.
4. The accounts of the named transactions, FOR KEY SHARE, in id order.
5. The version row (L2). The versions must be current, freshly evaluated and stamped.
6. The subject must be under review at that version. A foreign or unknown id gets the same refusal.
7. The existing decision RPC, in this transaction. For a note: the annotation only.
8. The versions as they are now; the receipt; the queue row when the result is not fresh.

Anything raised anywhere rolls all of it back. The decision RPC's own evaluation is best-effort as always: when it fails in the ordinary way the action still commits and answers `committed_pending`. A cancellation or a timeout of the statement aborts the transaction. A client whose **request** timed out knows nothing: the transaction may still be running. It keeps the operation id and the exact intent. It may ask for the receipt, and it may send the same operation again: the wrapper looks for the receipt first, under the user's lock, so a second copy waits for the first and answers `replayed` from the one receipt. Finding no receipt decides nothing.

Actions: `pair_current`, `confirm_unlinked`, `dismiss_candidate`, `undo_decision`, `reject_suggestion`, `defer`. The intent hash covers exactly the action's own fields. A receipt records the intent, the versions seen and committed, the decision written, what it superseded, and the obligations on the legs concerned — all of which remain. It carries no figure.

### 5.5 Lock order

| Path | Order |
|---|---|
| Action | L1 → account KEY SHARE (id order) → L2 → receipt → queue row |
| Removal | as packet 1; the capture's inserts come after L2 |
| Evaluation | L1 → L2 → queue row |
| Any writer that bumps the version | its own rows → L2 → queue row (trigger) |
| Claim | queue rows only, SKIP LOCKED, its own transaction |
| Refresh | lease read without a lock → evaluation (L1, L2) → queue row |

The queue row is always taken after L2, or alone. Lock-free writers exist as before. No general freedom from deadlock is claimed: one that occurs is detected, rolls back cleanly and leaves the queue row.

## 6. API

All four routes are under `/api/card-payment-recovery`, behind the session check and the client-API-level contract. The owner is the session's user. Nothing in a body, query or path is read as an owner.

| Route | Answer |
|---|---|
| `GET /reviews?cursor=&limit=` | the page, `actions_enabled`, freshness |
| `POST /actions` | `committed_fresh`, `committed_pending` or `replayed`, with the receipt and freshness; no figure |
| `GET /actions/:operationId` | `found`, the receipt, freshness. `found: false` = no receipt visible now (§5.3) |
| `POST /refresh-retries` | `queued` or `replayed`. `queued` = work is waiting; it says nothing about a worker |

| Status | Meaning |
|---|---|
| 200 | answered, including `committed_pending` and `found: false` |
| 400 | malformed request; no database call |
| 403 `recovery_actions_disabled` | `POST /actions` while changes are off |
| 404 / 409 / 422 | a refusal with a fixed code; nothing was written |
| 503 | no usable answer |
| 504 `outcome_unknown` | the request was abandoned; nothing is known; the body names the operation id |

No response and no log line carries a database message. The API level stays 2: an older bundle reads the new reason as an ordinary unresolved range. A build that meets a reason or contract it does not know shows the figures as unavailable.

## 7. Flags

| Variable | Default | Effect |
|---|---|---|
| `CARD_PAYMENT_RECOVERY_ACTIONS_ENABLED` | off | on: `POST /actions` is served. Off: only that endpoint is refused. The guard, the review, receipts and the refresh retry do not depend on it. |
| `CARD_PAYMENT_RECOVERY_WORKER_ENABLED` | off | on: this process runs the refresh worker. |

The guard has no flag. It is the evaluator.

## 8. Refresh

### 8.1 The worker

Work is registered in the writer's own transaction, by a trigger on the version row, whenever the inputs of an owner with obligations change — a sync, an account setting, a decision, a removal. An action that commits without a fresh result registers it too.

The worker claims and refreshes. It does not depend on a bank sync or on `CARD_PAYMENT_SYNC_EVALUATION_ENABLED`. It holds no state: its first poll at start finds whatever is outstanding.

**A queue row is not an executor.** Registration is durable and safe. Nothing runs it unless a process with `CARD_PAYMENT_RECOVERY_WORKER_ENABLED` on is running. With every worker off, a refresh stays queued indefinitely, figures stay unavailable, and no reader is given a result. No response and no screen text says otherwise: they say "queued".

| Setting | Value |
|---|---|
| Claims per poll | at most 10 |
| Refreshes at a time | 2, never two for one owner |
| Poll interval | 5 s; at once after a full batch |
| Lease | 120 s |
| Refresh call timeout (client) | 60 s |
| Lock wait inside a refresh | 10 s |
| Back-off after a failure | 5 s doubling, at most 5 minutes |
| After 8 failures in a row | `needs_attention`; not handed out until a retry is requested; the row is kept |
| Queue unreachable | 15 s doubling, at most 5 minutes |

An acknowledgement is fenced by the lease token and by the version: a lost lease acknowledges nothing, and work registered for a later version is never removed. These values were validated locally only. Hosted statement and request limits are a release gate.

### 8.2 The refresh-only retry

`POST /refresh-retries` with an operation id. It registers work for the server's current version of the owner, clears the attention flag and makes the row due. It keeps the failure history. It is accepted whatever the freshness is. It replays no decision, releases nothing and changes no version. It is available while actions are off.

## 9. The review screen

Reachable from Transactions (a header entry and a "Review payment" link on each affected row) and from every card-payment list of the Effects Drilldown — including when the payment is not among the rows shown, and when the figures are not current.

- It says what the payment counts as now. A range stays a range.
- It says why: the removed institution and date, each source with its date and amount — a source the removal wrote no decision for included — and each gap.
- It lists candidates as suggestions, never as facts, and marks the one that was withheld.
- Each action says what it does. A dismissal says it can change the figure. A rejected suggestion says nothing else changes.
- A different amount needs a second, explicit step.
- While figures are not current it shows no review and no figure, and offers the refresh. When a queue row exists it says exactly "**A refresh is queued. The figures are not up to date.**" — the same sentence whether the row was just registered, is leased by a worker, has failed below the attention threshold, or waits with every worker off. The screen cannot tell these apart and does not pretend to: it never says that a refresh is running, has not run, or will finish. The needs-attention state keeps its own sentence ("couldn't be brought up to date after several tries").
- A response it cannot read is shown as "update the app".

**When the outcome of a request is not known** (a timeout, a lost connection, a server error, an unreadable answer):

- It says so, and blocks every other change on the screen.
- It keeps the operation id and the exact request.
- "Check whether it was saved" asks for the receipt of that operation id. A receipt ends the unknown state: it was saved. **No receipt does not**: the screen says that none is visible yet, that this is not a failure, and stays unknown. There is no "it was not saved" and no way to drop the operation and start another.
- "Send the same request again" sends the same operation id with the same intent. A success or a replay ends the unknown state. So does a refusal of that operation by the server — except the five answers below, which decide nothing.
- If the login changed since the request was sent, nothing is asked or sent under the new login, and no outcome is claimed.

**The five answers to a resent request that leave the outcome unknown** (`UNDECIDED_REFUSALS` in `CardPaymentRecoveryReview.tsx`; the list is the code's, unchanged since the first correction pass):

| Code | Where it comes from | What it says about this delivery |
|---|---|---|
| `retry` | the database function raised its retry signal, or the database reported a conflict that asks for a retry | this delivery's transaction was rolled back without the intent being judged |
| `recovery_actions_disabled` | 403 from the API: changes are switched off in the process that received it | it was turned away before the database was asked |
| `client_update_required` | 409 from the API's client-level gate (or the client's own gate): this build is too old | it was turned away before the request body was read |
| `recovery_unavailable` | 503 from the API: the recovery functions could not be reached or gave no usable answer | nothing is known of what the database did with it, if it arrived there at all |
| `invalid_request` | 400 from the API: the body was not accepted as a request | it was turned away before any operation was looked for |

Why none of them settles the **earlier** delivery of the same operation: an operation is settled by what the database does under the user's lock — it looks for the operation's receipt first, and only when there is none does it judge the intent at the versions the request names. A receipt, a commit, or a refusal produced at that point is an answer about the operation. Each of the five is produced **before** that point, or without reaching it: the server never looked for the receipt. So the first delivery may have committed, may still be on its way, or may never have arrived, exactly as before the resend. The resend told the client only that this second delivery did nothing. A request with no code at all in its refusal is treated the same way. The record stays, the screen stays "unknown", and the user can check or send it again later.

By contrast, a coded refusal made at that point (a stale version, an operation conflict, a payment no longer under review…) does settle it: no receipt existed when the server looked, and the intent was refused at versions that only move forward, so an earlier copy still on its way carries the same versions and will be refused as well.

### 9.1 An unresolved change outlives the screen (v3)

`frontend/src/lib/cardPaymentRecoveryPending.ts`. One record per user, in the browser's `localStorage`, under a key that ends in that user's id.

- **Recorded before it is sent.** A change is written, read back and only then sent. If the browser cannot keep the record — storage is unavailable, full, or refuses — the change is **not sent** and the screen says so. There is no in-memory fallback.
- **What is kept:** the format number, the user's id, the operation id, the label shown to the user, the exact request (the action, its subject and partner ids, the two expected versions, and an accepted difference in cents when the user confirmed one), whether it is being sent or unknown, what the last check found, and when it was recorded. **Not kept:** any session or bearer token, password, key, account data, review content, or bank payload. Nothing of it is logged.
- **Restored before anything else can be done.** Whenever the review opens — from Transactions, from the Effects Drilldown, after navigation, after a reload or an app update (a fresh copy of the app), after the same user signs in again — the record is read first. While one exists, the screen shows the same operation id as unknown and every other change on it is disabled. Both entries show "1 change to check", also when the review itself cannot be read.
- **One at a time.** A second change of the same user is refused while one is unresolved. The record is never overwritten by another operation — between tabs too, under the conditions of §9.2.
- **Per user.** Another user on the same browser sees nothing of it, and nothing is asked or sent for it under their login. It stays where it is, and the first user gets it back. An answer that arrives late resolves only the record of the user who sent the request, and only that operation.
- **Resolved by the server only.** The record is removed when the server answers that operation: a commit, a replay, a receipt found by the lookup, or a refusal of that operation. "No receipt visible", "could not reach the server", elapsed time, a stale view, closing the screen — none of these removes it. There is no "forget" and no automatic resend. Sending again is the user's explicit act and replays the stored request unchanged, under the same operation id.
- **A record this version cannot read** (another format, damaged, a different shape) is treated as an unresolved change of unknown content: nothing can be sent, it is not overwritten, and the screen asks for the app to be reloaded.

Limits, stated plainly:

1. **It is this browser's memory, not the server's.** Clearing site data, a private window that is closed, another browser or another device: the record is gone or was never there. The server-side protection is unchanged and does not depend on it: the same operation id replays, and a different operation is checked against the versions it names.
2. **It is not encrypted** and can be read or edited by anything that can read this origin's storage. The user id in it is bookkeeping, not authority: the server authorizes every request from the session, as before.
3. **No expiry.** An unresolved record stays until the server resolves it. Nothing purges it when a user is deleted on the server or signs in on this browser never again. A retention rule is not defined here (§13).
4. **A refresh request is not recorded.** It decides nothing, and asking again is harmless.
5. **Two tabs.** A second tab learns of a record through the browser's storage event. That notification is not what keeps the tabs from overwriting each other: the lock of §9.2 is, with the limits stated there. (v3 claimed here that a second tab "cannot write a second one" while also saying the check and the write were not locked. The claim was wrong; v4 adds the lock.)
6. **Only this screen.** The rest of the app stays usable; nothing else is frozen.

### 9.2 One change of the record at a time, across tabs (v4)

Two tabs of the same user share the record. Recording a change, noting "no answer" and resolving are each a read, a decision and a write.

**Mechanism.** The browser's Web Locks API: `navigator.locks.request(name, { mode: 'exclusive' }, callback)`. The browser grants a lock name to one holder at a time among all tabs and workers of the same origin (and storage partition), queues the others in order, and releases the lock when the callback returns. The name is per user: `my-finances:card-payment-recovery:pending-journal:v1:<user id>`. Read-back checks, storage events and flags in a page's memory are not used as exclusion: none of them is.

- **All three changes take the lock**: recording (admission), noting (status), resolving (removal). No other code writes the record.
- **The record is read again inside the lock.** What a tab saw earlier — "nothing is pending" — decides nothing.
- **Admission.** Of two competing changes exactly one is recorded. The other finds it, is refused, and is **not sent**; its tab then shows the recorded change as pending.
- **Late answers.** A note or a resolution for operation X changes or removes the record only while the record **is** X. After X was resolved in one tab and Y recorded, a late answer for X in another tab finds Y, changes nothing, and reports that.
- **The screen follows the record.** An answer for X changes what a screen shows only while that screen still shows X (or nothing). If Y is pending there, X's answer neither clears Y, nor replaces it, nor is shown beside it; the figures are reloaded and Y stays pending with every other change blocked.
- **Short.** The lock is held for the change itself — synchronous, a few storage calls — and never while a request to the server is under way. The record, not a held lock, is what remembers an unresolved operation.
- **No lock, no change.** If the browser has no Web Locks, refuses the request, or the lock does not come within 5 seconds, the change is not made — not then and not later:
  - a new change is not recorded, so it is **not sent**; the screen says that it could not make sure another tab is not sending a change at the same moment;
  - a "no answer" note is not written: the record stays as it was, and the change is shown as unknown;
  - a resolution is not made: the record stays, the change stays listed, and the screen says that the change was answered but its record could not be updated. A later check or resend of the same operation clears it.
  Waiting too long is not an answer of the server. Nothing is forgotten and no pending change loses its place. There is no path that changes the record without the lock.
- **Existing records.** The record's format is unchanged (format 1). A record written by v3 is read, noted and resolved as it is.

**Supported environment.** Web Locks needs a secure context (HTTPS, or `localhost`) and a browser that implements it: Chrome 69 or later, Edge 79 or later, Firefox 96 or later, Safari 15.4 or later (as published in MDN's compatibility data on 2026-10-10). Elsewhere this screen can read and check but cannot send a change. The requirement is not enforced by anything but the fail-closed behaviour above.

**What the lock does not do.**

1. **It binds only code that takes it.** A tab still running a build from before v4 changes the record without it. Nothing forces old tabs to reload when a new build is deployed; until they do, the v3 behaviour applies between an old tab and any other tab. Anything else that writes this origin's storage directly is outside it too, and so is other code of this origin that asks for the same lock name with the API's `steal` option (this code never does).
2. **It is per browser profile and origin.** Another browser, profile, device, or a private window has its own storage and its own locks: no record is shared, and none is protected, across them (limit 1 of §9.1).
3. **It orders changes of the record; it does not make the server call and the record one step.** A change is recorded and then sent. A tab that is closed between the two leaves a record of a change that was never sent; it is shown as unknown, and checking or resending it is safe.
4. **A second tab shows another tab's change that is still being sent as "unknown".** It may check it or send it again; the server runs one operation id at most once.
5. **It was exercised in one browser.** The exclusion itself is the browser's; the tests in the repository use a stand-in for it (jsdom has no Web Locks), and one run in a real browser with two tabs is in the v4 evidence export.
6. **It does not encrypt, expire or purge anything** (§9.1, §13).

Engineering choices: the screen remembers which login it was opened under and refuses to send — or to look a receipt up — under another, without changing `App.tsx`. It loads the API module when a review is first read, so the two entry components do not pull in the API client for screens that never open a review.

## 10. Rollback and re-application

The rollback restores the three previous bodies and keeps every table and row.

- **It refuses while any review obligation exists.** The previous evaluator would publish the unguarded pair as fresh.
- With `set card_payment.recovery_review_rollback = 'fence_affected_owners'` it proceeds and installs a fence: a trigger that keeps `evaluated_version` null for every owner with an obligation. Their figures are then explicitly unavailable. Other users are served as before.
- A removal made while rolled back captures no obligation. Re-applying the migration seeds it from what is retained.
- Re-applying clears every stamp, drops the fence, seeds idempotently and registers refresh for everyone.
- Rollback order: this file's rollback first, then packet 1's, then the two older ones.

## 11. Tests

`supabase/tests/card_payment_recovery_review/`. None of it is run by the existing CI workflow.

| File | Covers |
|---|---|
| `run.sh` | sql r01–r08, concurrency c01–c08, and the SQL-versus-reference comparison |
| `sql/r01` | the approved oracle: E1, E7, E2, pair and undo, reject, defer, dismiss, a new transaction after a dismissal, excluded accounts, no included card, aggregate bounds |
| `sql/r02` | obligations, sources, known edges, every obligation, either leg, pending lineage, no fallback, legacy seeding, gaps, detachment |
| `sql/r03` | preserved confirmations active and inactive, supersession, accepted difference, reservation, loan reversal |
| `sql/r04` | grants, row security, forged and foreign owners, pagination, cursor, content of an answer |
| `sql/r05` | failure injection, pending commit, replay, conflicting reuse, stale and malformed requests, evidence changing while a request waits |
| `sql/r06` | registration, claim, lease expiry, two workers, later work, back-off, needs attention, the retry; a retry with no worker runs nothing and publishes nothing; a new worker's first claim finds waiting work |
| `sql/r07` | seeding invalidates, the stamp, readers in between, strict capture, user deletion against row deletion |
| `sql/r08` | **capture from the graph**: a tie whose candidates are all removed; the mirror; a second removal that writes no new decision; a match that stays. Obligations, each source, generations, owner isolation, no invented decision, and the guarded readings afterwards |
| `concurrency/c01–c07` | same operation twice, action against removal both ways, lock-free writers, two workers, the lock budget |
| `concurrency/c08` | **receipt timing**: a lookup while the action's transaction is open finds no receipt; the same operation sent again waits and is a replay; one receipt, one decision |
| `rehearsal.sh` | rollback on an empty database, upgrade with history, refusal, fenced rollback, a removal while rolled back, re-application |
| `mutations.sh`, `mutants.cjs` | 30 database mutants and 2 rollback mutants, each with the assertion that must fail. Six are about the graph capture, one of them the first candidate's defect itself (anchors from the plan only) |
| `mutations_ts.cjs` | 25 TypeScript mutants, among them: "no receipt" read as "not saved"; a resend under a new operation id; a queued refresh described as running. In v3 its mutant `t21_queued_shown_as_running` looked for a sentence v3 had replaced, so the runner stopped with "anchor not found" before running anything. **Repaired in v4:** `t21` now targets the current sentence ("A refresh is queued. The figures are not up to date. No figure is shown.") and still replaces it with a claim that the figures are being brought up to date, caught by the same named test. `t19` ("no receipt" read as "not saved") was pointed at the line v4 rewrote, with the same defect and the same named test. No other mutant changed; none was removed, skipped or softened. The lifecycle and cross-tab controls of v3 and v4 are outside the repository (§15, §16) |
| `rpc_metadata_controls.sh` | negative controls of the existing RPC comparison: recovery inputs omitted; review metadata corrupted with every leg unchanged; review metadata absent; a hand-written review expectation and a hand-written figure contradicted |
| `capture_cost.sh` | §12 |

Backend and frontend tests sit beside the modules they test.

Financial expectations are written out by hand in each test. The SQL-versus-reference comparison is supplementary: the two evaluators could share a mistake.

### 11.1 Traceability to the 48 historical cases and E1–E8

**S** = asserted in this packet, with the test. **Deferred** = a positive terminal, provider or contradiction path that this packet does not implement; it is not counted as a pass.

| Case | First-slice assertion | Test | Deferred |
|---|---|---|---|
| 1 | a return on the original day is withheld; H and D remain | r01 E2 | P-Y settlement of H |
| 2, 3 | no correspondence is inferred from institution or mask; nothing is retired | r01 E7 (no identity is read anywhere); TS "similarity is not membership" | — |
| 4 | an unrelated event on the 11th: range {−37000, 0} | r01 E7 | — |
| 5 | a new-Item pending → posted edge proves nothing; lineage is per account | r02 PEND | provider bridge |
| 6 | a return with another amount is a suggestion; the difference must be accepted | r03 DIFF | P-Y with changed amount |
| 7 | a return on the 14th, no consent: −37000 | r01 E1 | H retirement |
| 8, 9, 10 | nothing is retired by absence, partial import or description | r01 baseline after removal; r02 DETACH | — |
| 11 | conflicting replacements stay unresolved | existing evaluator rule; equivalence corpus | — |
| 12 | two sources are two rows | r02 EVERY | — |
| 13, 15, 17, 18, 22 | A and B are separate; no action retires either | r02 EVERY; r01 "nothing was retired" | every positive retirement |
| 14 | a tie stays uncertain | r02 EVERY (before removal 2) | — |
| 16 | — | — | contradiction containment |
| 19 | no fallback pair is invented | r02 NOFALL | enumerated authorization |
| 20 | gaps are explicit; current correction stays reachable; a new removal keeps what it knew even where it writes no decision | r02 LEGACY, MARKER; r07 SEED; r08 TIE, MIRROR | — |
| 21 | a second removal captures its own obligation — also when it writes no record and no hold | r02 removal 2; r08 REPEAT; rehearsal s5–s6 | duplicate-relink settlement |
| 23, 24 | preserved confirmation, active and inactive, unchanged by a return | r03 ACT, INACT | — |
| 25 | an explicit choice stands; H and D remain | r01 PAIR, E1 from its review | — |
| 26 | pair then undo: nothing retired, nothing resurrected | r01 PAIR; r03 SUP | — |
| 27 | an excluded returning card is evidence | r01 XEX | retirement |
| 28 | an excluded payment contributes 0 and keeps its review | r01 KEX | retirement |
| 29 | ambiguity never creates a record | r02 EVERY, EITHER | — |
| 30 | a confirmed unlinked destination survives a return | r03 UNL | — |
| 31 | foreign ids: uniform refusal, no write | r04 | — |
| 32 | a dismissal is not consent | r01 DIS, DIS2 | — |
| 33 | the same operation 100 times | r05 §4 | retirement retry |
| 34 | removal after relink: a new generation, new obligations | c03; rehearsal s5–s6 | — |
| 35 | action and evaluation overlap | c01–c04, c07 | — |
| 36 | failure between decision, receipt and registration | r05 §1–§2 | — |
| 37 | committed with a pending evaluation | r05 §3 | — |
| 38 | unknown outcome: no receipt while the transaction is open is not a failure; the same operation replays once | r05 §3; c08; backend and screen tests | — |
| 39 | an unrelated institution with matching descriptors, closer | r01 E7 | — |
| 40, 41 | later evidence is reconsidered without a sync | r06 §1; worker tests | automatic retirement |
| 42 | actions off: protection, review and refresh remain; with no worker a queued refresh publishes nothing | controller tests; r06 §6b | — |
| 43 | two workers | r06 §3; c05 | — |
| 44, 45 | a correction or a deletion while a request waits | r05 §7; c02, c07 | — |
| 46 | — | — | provider withdrawal after settlement |
| 47 | disable and downgrade | rehearsal s3–s6; r1, r2 mutants | — |
| 48 | the mirror: an affected card leg | r02 EITHER | retirement |
| E1 | −$370, no settlement | r01 E1 | — |
| E2 | withheld; an explicit pair gives $0 without retirement | r01 E2, PAIR | — |
| E3, E6 | — | — | P-Y-only and P-D-only terminal actions |
| E4, E5 | H and D ids and both sources unchanged after every action | r01, r02 EVERY | the retired branches |
| E7 | no automatic pair; a fresh range; a stale result exposes nothing | r01 E7; r07 BETWEEN | — |
| E8 | a new-Item lineage edge proves nothing about the old account | r02 PEND (same-account lineage only) | any bridge |

## 12. Capture cost

`capture_cost.sh` measures, on synthetic histories, what a removal writes and what the capture adds before the delete:

- an ordinary history (each payment its own amount);
- a dense one (one amount, one day, every payment tied between every card);
- the dense one with **no kept card**: every candidate of every payment is removed. The removal writes no decision; the capture must still keep every payment and every removed candidate.

It asserts the hand-computed row counts, so nothing is truncated to meet a budget. It runs removals under a statement timeout that cannot be met and asserts that nothing was removed and nothing written.

Growth, for n tied payments, n removed and n kept legs: n³ holds and decision-backed sources (inherited from packet 1's one hold per payment, removed candidate and kept candidate), n² known edges, n obligations. With no kept leg: no decision, n obligations, n² graph-observed sources.

Its timings are those of one machine, measured on the corrected capture. They do not validate a hosted database's capacity or statement limits.

## 13. Known gaps and release gates

Not solved here. Each needs a decision or separate work before activation.

1. **Anchorless history.** A removal that ran before this migration — or while it was rolled back — recorded no graph. Seeding uses the decisions it left. A payment of such a removal that got no decision (all its candidates removed; its match stayed and a farther candidate went) cannot be identified now, and for removals older than the holds nothing was left at all. No backfill and no owner-wide freeze was built. Explicit treatment is required before activation.
2. **An executor must be running.** The migration makes every user unreadable until evaluated again, and every later change of an affected owner is queued. Without a process whose worker flag is on, nothing is refreshed and figures stay unavailable. Worker availability and deployment order are activation gates.
3. **A tie between two newcomers** selects no pair, so the guard withholds nothing and a payment with a record reads the record. This is the approved rule (§3.4), stated here so it is not a surprise.
4. **Scope of "affected".** A payment whose match stayed is affected when the removal cut another of its eligible edges (§3.1). Its match keeps working; newcomers are withheld. This follows the capture requirement (the complete eligible graph). It widens who is under review compared with the first candidate.
5. **Retention, redaction, disclosure.** Obligations, sources, receipts and annotations go with their user and with nothing else. No duration and no purge is defined. A graph-observed source keeps a removed transaction's Plaid ids, date and cents although no decision exists for it.
6. **Hosted limits.** Lease, timeouts and capture cost were validated locally only. Nothing here guarantees freedom from deadlock, registry quota or hosted statement limits.
7. **Terminal actions.** P-Y, P-D, provider correspondence and contradiction handling are not implemented.
8. **The unresolved-change record is local to one browser (§9.1).** It does not follow the user to another device, does not survive cleared site data, is not encrypted, has no expiry and no purge. A server-side record of unresolved operations was not built. Retention and disclosure of the browser record need the same decision as item 5.
9. **The cross-tab lock depends on the browser and on every tab running this build (§9.2).** Without Web Locks no change can be sent from the review. A tab left open on an older build is not bound by the lock; forcing old tabs to update is not built. Whether that needs a product or deployment rule is open.
10. **A record that cannot be read, or that cannot be cleared, has no support path.** The screen stops and says so; nothing in the app removes such a record, by design. What a user or support does then is not defined.

(Closed in v4: `mutations_ts.cjs` mutant `t21` targets the current sentence again, §11.)

## 14. Existing tests updated in the correction pass

The existing harnesses apply every migration in the folder, so they run against this one. Nine existing test files were updated, under an explicit extension of the allowlist, and only where the approved contract changes what they assert. Every new expected value was derived by hand. No assertion was skipped or softened.

| File | What changed |
|---|---|
| `access_control/sql/a18` | a re-imported leg is withheld, not re-tracked: the ranges {−60, 0}, {0, +35}, {−140, 0}, {−98, 0}. A second removal then has no automatic match to record: no second record |
| `access_control/sql/a21` (V1), `a24` (C-amount) | after the user undoes a preserved confirmation, the pair with the kept card is withheld: {−470, 0}, {−298, 0} (§3.2) |
| `access_control/sql/a22` (C-new, E) | a new, closer leg and a re-imported leg are withheld: {−720, 0}, {−770, 0} |
| `access_control/sql/a25` (E, O, H, O2; its open-question-7 record) | new evidence and the relinked leg are withheld. After a second removal: one record and two holds; the second hold's source is a removed candidate |
| `access_control/sql/a26` (R) | the same, with provenance: one record, one provenance row — and the second removal's own obligation and graph-observed source are asserted |
| `access_control/sql/a27` | the inventory of functions that name a provenance table lists the three that read it; no client role may execute any; none of the three writes to it. The removal-body checksum is this migration's. The reader's key list has its two new keys |
| `card_payment_evaluator/rpc_sequences.sql`, `compare_rpc.cjs` | the reference evaluator is given the owner's review obligations; the review metadata is compared on its own; Q10, Q12, Q15 and Q18 state the guarded results by hand, with figures and reviews at checkpoints; Q20 is new (a return on an excluded card; no included card) |

Not updated and not run: `supabase/tests/lim_removal_matching_mutations/` (packet 1's 95 mutants run `access_control` tests against the newest removal body and pin its checksum). It is outside the allowlist.

**Retention approved explicitly (2026-10-10).** The second independent review found that three of these changes went beyond the assertions the correction pass had named, although inside files it was allowed to change, and judged each of them correct. Trevor approved keeping them as they are. They are unchanged since the corrected candidate:

| File | The change | Why it stands |
|---|---|---|
| `access_control/sql/a18_lim_removal_card_payments.sql` | the second-removal block: no second removed-destination record | a return that the guard withheld was never a resolved automatic match, so a removal has no known destination to record |
| `access_control/sql/a25_lim_removal_automatic_destination.sql` | the open-question-7 reading | it states the behaviour approved for this packet; the earlier exports keep the earlier reading |
| `access_control/sql/a27_lim_removal_provenance_access.sql` | the reader's keys `evaluatorContract` and `reviews` | a compatibility assertion of the new reader; its access checks were strengthened, not relaxed |

## 15. The v3 pass: what changed and how it was checked

Changed in v3: `frontend/src/lib/cardPaymentRecoveryPending.ts` and its test (new); `CardPaymentRecoveryReview.tsx`, `TransactionsFeed.tsx`, `EffectsDrilldown.tsx` and their tests; this file. Nothing else: no backend file, migration, rollback, SQL or comparison harness, reference evaluator, package manifest, lockfile, workflow or hosting file. The v3 evidence export proves that by comparing every other path with the corrected candidate.

How results are attributed in that export:

- **Run again in v3**, on the v3 bytes: the frontend tests, typecheck, build and PWA contract; negative controls of the lifecycle and the wording, each of which must fail on a named test; and one local run of browser, API and database in which a change is delayed past the server's time limit, the review is left, reloaded and signed out of, and the original request then commits.
- **Kept from the corrected candidate's export, on inputs shown to be unchanged:** the database suites, the concurrency cases, the rollback rehearsal, the database mutants, the RPC comparison and its controls, the capture cost, the backend tests. They were not run again and are not presented as v3 runs.
- **Superseded:** the corrected candidate's frontend test runs, its screen mutants and its browser run were made on the screen that v3 replaces.

Still true of the earlier evidence: the first correction pass's fail-before logs are the builder's own and one of them does not carry its input fingerprint; its browser observations are the builder's transcription; the copy of the first triage saved in that export differs from the original by one missing leading `*` and one added final line break, so it is not byte-verbatim. Both are kept as they are.

## 16. The v4 pass: what changed and how it was checked

Changed in v4, and nothing else:

| Path | Change |
|---|---|
| `frontend/src/lib/cardPaymentRecoveryPending.ts` | the three changes of the record run under the user's journal lock and read the record again inside it; no lock, no change (§9.2). The record's format and every rule of §9.1 are unchanged |
| `frontend/src/lib/cardPaymentRecoveryPending.test.ts` | the overlap, coordination and v3-record tests; existing tests await the three calls, with their expectations unchanged |
| `frontend/src/components/CardPaymentRecoveryReview.tsx` | a change is recorded under the lock and only then sent; an answer changes the record and the screen only for its own operation; the two messages for "no turn at the record" |
| `frontend/src/components/CardPaymentRecoveryReview.test.tsx` | the two-tab and no-coordination tests; no existing test changed |
| `supabase/tests/card_payment_recovery_review/mutations_ts.cjs` | `t21` and `t19` point at the current lines (§11) |
| this file | the status, §9, §9.1, §9.2, §11, §13, this section |
| `frontend/src/components/TransactionsFeed.test.tsx`, `EffectsDrilldown.test.tsx`, `EffectsDrilldown.review.test.tsx` | **outside the six paths first named for v4; added with Trevor's approval of 2026-10-10 before any edit.** jsdom has no Web Locks, and these files send a change through the real screen, which now fails closed without the lock. Each got the same small stand-in for the lock manager in its set-up, and nothing else: no assertion, fixture or test changed |

No backend file, migration, rollback, SQL or comparison harness, reference evaluator, entry component, API client, service worker, package manifest, lockfile, workflow or hosting file changed. The three approved a18/a25/a27 edits are byte-identical. The v4 evidence export shows this by comparing every path with v3.

Not changed on purpose: the success notice that is not seen after a change made from the Effects Drilldown's list (later, separate UI work); retention, purge and support rules for the record; anything on the server.

How results are attributed in the v4 export:

- **Run in v4**, on the v4 bytes: the frontend tests, typecheck, build and PWA contract; the fail-before of the overlap tests on the v3 code; negative controls for bypassed coordination and missing identity checks, each failing on a named test; **the repository's TypeScript mutation runner, unfiltered**; and one local run in a real browser with two tabs of one synthetic user.
- **Kept from the earlier exports, on inputs shown unchanged:** the database suites, concurrency cases, rollback rehearsal, database mutants, RPC comparison and its controls, capture cost, and the backend's full test run — under their original identities, as v2 results. v3's delayed-original and cancelled-original runs stay v3 results about the v3 screen; the v4 two-tab run does not extend them.
- **Superseded:** v3's frontend runs and its external controls were made on the code v4 changes; v2's unfiltered runner result describes the runner before its repair.

What the tests in the repository do and do not show: they run the real module and screen against a stand-in for Web Locks, with another tab's change placed exactly between a read and a write. They show that this code takes the lock, re-reads inside it and binds answers to their operation. They do not show what a browser's lock manager guarantees; that is the browser's, and was observed once, in one browser.
