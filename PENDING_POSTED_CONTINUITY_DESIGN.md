# Pending → posted transaction continuity — Design for review

**Status:** design only, revision 5. No code, schema or production data is changed by this document.
**Decided (Trevor):** C1–C6 as recommended (§11).

**Revision 5 — changes from Codex's fourth review (one blocker):**
1. §6.2: a **backstop trigger** for the backend-rollback window. An old backend's lock-free mapping
   backfill could fill a category the user deliberately cleared through the new backend while leaving
   `budget_category_source = 'user'`, so the returning new backend would read the fill as the user's
   choice. New-backend writers now stamp `budget_category_set_at`; a `BEFORE UPDATE` trigger keeps a
   `'user'`-cleared row at NULL when a writer changes the value without touching the stamp — the same
   silent-pin pattern as `plaid_items_keep_removing`. Regression tests K20/K20b.
2. §10 K19 now states its assumption (pending and posted Plaid categories match); §9/§12 count **five
   RPCs plus the trigger function**; §5 I3/C6 say a later backfill fills an uncategorised posted row
   only if one is actually run.

**Revision 4 — changes from Codex's third review (two category gaps):**
1. §5 I3: posting **never infers** that a category was assigned automatically, and never re-maps. The
   pending row's `budget_category_id` and `budget_category_source` are copied **exactly**, including
   NULL/NULL — a pre-column clear, an old-backend clear, or a user's choice that happens to equal the
   current mapping are all preserved. The one cost (a never-categorised pending row whose posted Plaid
   category would map) is stated and offered as decision **C6**. K17 rewritten.
2. §6: the existing `backfillCategoryMapping` write path (a lock-free `UPDATE … where
   budget_category_id is null`) becomes a locked RPC that skips `source = 'user'` rows, records
   `source = 'mapping'` on rows it fills, also fills matching **unconsumed carry-overs**, and so
   serialises with pending-row edits and posting. Regression tests K18/K19.

**Revision 3 — changes from Codex's second review:**
1. §5 I3 / §6: when `budget_category_source` is unknown (rows predating the column) or stale (an old
   backend's direct `UPDATE` during the coexistence window), the pending row's **existing** category
   choice is preserved; the mapping is re-applied only when the stored value is demonstrably the
   mapping's own output. The carry-over records the pending Plaid category to make that test possible.
2. §10 K12 replaced by cases where the loan-balance clamp actually **binds** (the remaining balance is
   below the principal at re-link time), with the note and review flag that raises.
3. §9/§12: the rollback never drops `user_role_override_at` once it has been created — it is Phase B's
   user-history column and may already contain corrections.
**Baseline inspected:** `main` at `0916de0` (production migration head `20260926120000`).
**Author:** Claude (Fable 5.1), 2026-09-26. **Reviewers:** Trevor, then Codex.
**Decided (Trevor):** C1–C5 as recommended (§11).
**Sequence:** ships **before** Financial Semantics Phase B (Phase B decision D1). Phase B relies on the
contract in §3.

**Revision 2 — changes from Codex's review:**
1. §5: **one** atomic write path for inserts, updates *and* removals (`apply_synced_transaction_batch_v2`);
   today's two-call sequence (batch RPC, then a separate delete RPC) is replaced, and §9 specifies how
   old and new backends coexist during deployment and rollback (new function name, old one retained).
2. §6: pending-row mutations — category, approval, splits — move into RPCs under the same per-user
   lock as posting, so they serialise with it; an intentionally cleared category is preserved as NULL
   via a new `budget_category_source` column.
3. §4: `consumed_by_transaction_id` now cascades (the previous `set null` contradicted the CHECK);
   superseded lookups are scoped to the signed-in user; `user_role_override_at` is created by **this**
   migration (Phase B's no longer adds it); `replace_transaction_splits` moves here too.
4. §5 I5/I4: re-linking is explicitly skipped on a sign flip; a deleted loan is still explainable
   (name and id snapshots); splits whose budget category was deleted are dropped with a note; a loan
   whose remaining balance is below the recorded principal is a test case (K12).

---

## 1. The problem

Plaid reports most card and many bank transactions twice: first as a **pending** transaction, then,
days later, as a **posted** one with a new `transaction_id` and a `pending_transaction_id` pointing at
the pending one, while the pending one is reported as `removed`. Today the sync path
(`syncService.syncItemTransactions` → `dataService.applyTransactionChanges`) treats those as
unrelated events:

- inserts and updates go through one RPC (`apply_synced_transaction_batch(p_user_id, p_inserts,
  p_updates)`, which takes the per-user advisory lock);
- removals go through a **second, separate** RPC call afterwards
  (`delete_transactions_and_restore_loan_balances`, which also restores any manual-loan principal the
  removed row had applied — correct and kept as behaviour);
- the `added` posted row is inserted as a brand-new transaction: `needs_review = true`, budget
  category from the category mapping only, no splits, no manual-loan link, a fresh classification,
  and — once Phase B exists — no `user_role_override`.

So every correction a user makes to a pending transaction is silently lost a few days later, and a
page's inserts and its removals are two transactions, not one. `pending_transaction_id` is not stored
anywhere; `mapPlaidTransaction` drops it. Category and approval edits are plain `UPDATE`s with no lock
(`dataService.setTransactionCategory`, `approveTransaction`); split replacement is a delete followed
by an insert.

**Plaid facts the design relies on** (Transactions Sync documentation):
- A posted transaction carries `pending_transaction_id` = the pending transaction's id, when Plaid
  can link them. Not every posted transaction had a pending one, and Plaid does not guarantee the
  link for every pair.
- The posted `added` and the pending `removed` usually arrive in the same `/transactions/sync`
  update, but they can be split across pages (`has_more`) and across separate syncs.
- A pending transaction can be `modified` while pending (amount or date change), and can be
  `removed` **without** ever posting (a declined or expired authorisation).
- The posted amount can differ from the pending amount (tips, fuel pre-authorisations, currency
  settlement); the sign can, rarely, differ (a correction).

---

## 2. Goals, non-goals

**Goals**
- G1. Every user-made state on a pending transaction survives posting: budget category (including an
  intentionally cleared one), approval, splits, manual-loan link (with its principal), and
  `user_role_override` (+ timestamp).
- G2. Survives in **every arrival order**: same page, posted before removal, removal before posted
  (possibly a different sync, days apart).
- G3. The manual-loan applied-amount ledger stays exact at every commit point: Σ restored =
  Σ `loan_balance_applied` (the LIM/Phase A invariant), with no double restoration and no
  un-restored principal — including when the posted amount differs from the pending amount and when
  the loan's remaining balance is below the recorded principal.
- G4. Idempotent under Plaid's page replay (an unadvanced cursor re-sends the same page).
- G5. A user mutation racing the posting is never silently lost or applied to a dead row; the client
  learns what happened and can re-target.
- G6. **One** atomic database operation per sync page — inserts, updates and removals together —
  under the per-user advisory lock; and every pending-row mutation under that same lock.
- G7. Old and new backend versions can run against the schema during deployment and rollback without
  corrupting anything.

**Non-goals**
- Guessing links Plaid didn't make (no fuzzy pending↔posted matching by amount/merchant).
- Changing classification rules, aggregation, or anything else in Phase B.
- Retaining history of *posted* rows Plaid removes (a removed posted row is a genuine reversal;
  today's delete + restore stays).
- Manual-loan balance-as-of semantics.

---

## 3. Properties Phase B relies on (the contract)

P1. After a posted row is inserted, it carries the pending row's budget category (a user-cleared NULL
    stays NULL), `user_role_override`, `user_role_override_at`, and (per §7) its approval state, splits
    and loan link.
P2. `auto_role`/`role_source`/`role_confidence` on the posted row are **re-classified** from the posted
    row's own fields (never copied); the override, if any, still wins in `effective_role`.
P3. Loan ledger: exact at every commit (G3).
P4. Any mutation RPC (category, approve, splits, and Phase B's role override) takes the per-user lock,
    verifies ownership, and raises `transaction_not_found` for a missing row; the controller then
    answers `409 transaction_superseded` (with the posted row) or `409 transaction_pending_removed`,
    both looked up **for the signed-in user only** (§8).
P5. Rows carry `pending_transaction_id`, `review_note`, and `posted_from_pending_amount`, so the UI
    can say "Posted (was pending $52.10)".
P6. `transactions.user_role_override_at` and `replace_transaction_splits` exist after this migration;
    Phase B's migration does not create them.

---

## 4. Data model (one additive migration)

```sql
alter table public.transactions
  add column pending_transaction_id       text null,      -- Plaid's id of the pending row this posted row replaced
  add column posted_from_pending_amount   numeric null,   -- the pending amount, when it differed (null otherwise)
  add column review_note                  text null,      -- why needs_review was (re)set; cleared on approve
  add column budget_category_source       text null       -- 'mapping' | 'user' | null (§6): who set budget_category_id
    constraint transactions_budget_category_source_check
    check (budget_category_source is null or budget_category_source in ('mapping', 'user')),
  add column budget_category_set_seq      bigint null,        -- protocol marker stamped by every NEW-backend category writer (§6.2)
  -- Implementation note (Codex cleanup point 1): the marker is a value from a dedicated sequence,
  -- transactions_budget_category_seq, not a timestamp — nextval() is guaranteed to differ on every
  -- write, including two writes inside one transaction where now() would be identical.
  add column user_role_override_at        timestamptz null;   -- Phase B's override timestamp, created here (§3 P6)
create index transactions_pending_transaction_id_idx on public.transactions (pending_transaction_id)
  where pending_transaction_id is not null;

create table public.transaction_carryovers (
  id                            uuid primary key default gen_random_uuid(),
  user_id                       uuid not null references auth.users(id) on delete cascade,
  account_id                    uuid not null references public.accounts(id) on delete cascade,
  pending_plaid_transaction_id  text not null unique,
  pending_transaction_row_id    uuid not null unique,  -- the deleted pending row's uuid, for §8's superseded lookup
  pending_amount                numeric(12,2) not null,
  pending_date                  date not null,
  pending_name                  text null,
  pending_plaid_category        text null,      -- the pending row's Plaid `category`: lets backfill_category_mapping fill an unconsumed carry-over of that category exactly as it fills a live row (§6.1)
  budget_category_id            uuid null references public.budget_categories(id) on delete set null,
  budget_category_source        text null,
  budget_category_set_at        timestamptz null,
  needs_review                  boolean not null,
  user_role_override            text null,
  user_role_override_at         timestamptz null,
  splits                        jsonb null,     -- [{budget_category_id, amount, note}] or null
  manual_loan_id                uuid null references public.manual_loans(id) on delete set null,
  manual_loan_id_snapshot       uuid null,      -- never nulled: explains "its loan was deleted" (§5 I5)
  manual_loan_name_snapshot     text null,
  principal_portion             numeric null,
  removed_at                    timestamptz not null default now(),
  expires_at                    timestamptz not null,   -- removed_at + 30 days (C2)
  consumed_at                   timestamptz null,
  consumed_by_transaction_id    uuid null references public.transactions(id) on delete cascade,
  constraint transaction_carryovers_consumed_check
    check ((consumed_at is null) = (consumed_by_transaction_id is null)),
  constraint transaction_carryovers_link_check
    check (manual_loan_id is null or principal_portion is not null)
);
-- RLS on, no policies; revoke all from public/anon/authenticated; service_role: select/insert/update/delete.
```

- **`consumed_by_transaction_id … on delete cascade`** (Codex's finding): a consumed carry-over is an
  audit record for one posted row; if that row is later deleted (Plaid removes it, LIM removes the
  item, an account is deleted), the record goes with it. `set null` would have violated the CHECK the
  moment the posted row disappeared, making every such deletion fail.
- **`manual_loan_id` (FK, `set null`) + snapshots (no FK):** the FK column decides whether re-linking
  is still valid; the snapshots survive the loan's deletion so the posted row's note can name it.
- Why a separate table rather than soft-deleting the pending row: every existing query (feeds,
  aggregates, LIM preview/removal counts, loan payment history, digests) would need a `removed_at is
  null` filter, and one missed filter would double-count or resurrect a dead row. The carry-over
  record is invisible to all of them by construction.

**Cascades and interactions:**
- LIM removal deletes the item's accounts → carry-overs cascade with them. Their loan restoration
  already happened when the pending row was removed (§5 R2), so the ledger and the removal preview
  digest are unaffected.
- Deleting a manual loan (`delete_manual_loan_atomic`) sets `manual_loan_id` to null on its
  carry-overs; the snapshots remain → a later posting carries everything except the link and notes
  "Its loan 'SoFi' was deleted before this posted".
- Deleting a budget category (`deleteBudgetCategory` — the API still allows a hard delete) sets the
  carry-over's `budget_category_id` to null; under C6 the posted row is then simply uncategorised
  (NULL is copied exactly — nothing falls back to the mapping). Split entries in the JSON pointing at
  the missing category are handled in §5 I4.
- Archiving a budget category keeps the reference (archived categories keep their history today).

---

## 5. One atomic write path per sync page: `apply_synced_transaction_batch_v2`

```sql
create function public.apply_synced_transaction_batch_v2(
  p_user_id uuid, p_inserts jsonb, p_updates jsonb, p_removed_plaid_ids text[]
) returns jsonb  -- { inserted: [...], carried: [{posted_id, pending_plaid_id, notes}], removed: n }
```

A **new** function (§9 explains why it is not a `create or replace` of the existing one). SECURITY
INVOKER, `search_path = ''`, `pg_advisory_xact_lock(hashtext(p_user_id::text))` first, service_role
only; every row it touches is locked `for update` with its ownership chain, as the existing batch RPC
does. The existing `delete_transactions_and_restore_loan_balances` is **called from inside** it for
the restoration arithmetic (same code path, same clamp semantics), never from the application as a
second step. Per page, in this order:

**R. Removals first.** For each id in `p_removed_plaid_ids` that matches an owned row:
- R1. **Posted** row (`pending = false`): delete and restore as today. No carry-over.
- R2. **Pending** row: insert a carry-over from the row and its splits (`on conflict
  (pending_plaid_transaction_id) do nothing` — replay-safe), then restore its `loan_balance_applied`
  and delete it (cascading its splits). `expires_at = now() + interval '30 days'`.

**I. Inserts** (rows in `p_inserts` that don't exist yet). For each with a non-null
`pending_transaction_id` X:
- I1. Source lookup, in order: (a) a **live** owned pending row with Plaid id X (posted arrived before
  the removal); (b) an **unconsumed, unexpired** carry-over for X owned by `p_user_id`; (c) nothing →
  insert as a new transaction exactly as today, with `pending_transaction_id` recorded for the UI.
- I2. Case (a): first bring the live row through R2 inside this same transaction (carry-over,
  restore, delete), so the pending row's ledger effect is undone **now** and the later `removed` for X
  is a no-op. Both arrival orders then converge on one path: a carry-over record is always the source.
- I3. Insert the posted row with, from the carry-over:
  - `budget_category_id` and `budget_category_source` — **copied exactly, always, including
    NULL/NULL. Posting never consults the category mapping.** Codex's finding against revision 3:
    equality with the current mapping does not prove a value was assigned automatically (a user may
    have chosen that same category), and a pending row cleared before the column existed — or
    cleared by an old backend during the coexistence window — is NULL with a null or stale source,
    so any "NULL → re-map" rule would re-categorise a deliberate clear. Whenever the origin of the
    pending value is uncertain, the only safe action is to preserve it, and the origin is uncertain
    in every case except `source = 'user'` (which is preserved anyway). So there is no decision
    table: the posted row inherits the pending row's value and label as they are.
    - The **cost**: a pending row that had no category (no mapping matched its pending Plaid
      category, and nobody set one) posts with no category even if a mapping exists for the posted
      row's Plaid category. That row still appears in the review queue (`needs_review` is inherited).
      It is filled — with `source = 'mapping'` — **only if a backfill is actually run**, i.e. only when
      the user next creates or changes the mapping for that Plaid category (`backfill_category_mapping`,
      §6.1); an existing mapping does not apply itself to it. Otherwise the user categorises it by
      hand. Pending and posted Plaid categories rarely differ, so this is uncommon; decision **C6**
      (§11, decided) records the alternative and why it is not recommended.
    - `budget_category_set_at` is copied along with the value and label (§6.2).
    - **Old-backend edits during rollout and rollback** (§9 windows 2 and 4): an old backend's direct
      `UPDATE` sets or clears the value and leaves the label stale. Because posting copies exactly, a
      value it set is preserved and a value it cleared stays cleared — the stale label changes
      nothing at posting time. The stale label matters only to the mapping backfill (§6): a clear made
      by an *old* backend is NULL with a non-`'user'` label and is therefore fillable by a later
      backfill, exactly as it is today. That is the one accepted degradation, confined to clears made
      while an old backend was running; a clear made through the new backend carries `'user'` and is
      protected everywhere.
  - `user_role_override`/`_at`: copied unless the sign flipped (then dropped, `needs_review = true`,
    note "Sign changed from an outflow to an inflow");
  - `needs_review` per §7; `posted_from_pending_amount` when the amounts differ; `review_note`;
    `pending_transaction_id`.
- I4. **Splits.** Re-created only when the posted amount equals the pending amount (cents) **and**
  every `budget_category_id` in the JSON still exists and belongs to the user; otherwise **dropped**,
  `needs_review = true`, note "Amount changed from $52.10 to $60.10; splits removed" or "A category
  used by this transaction's splits was deleted; splits removed". Never scaled, never partially
  re-created (a partial set would not sum to the amount and the constraint that splits equal the
  amount is what `replace_transaction_splits` enforces).
- I5. **Loan link.** Only if **all** hold: `manual_loan_id` is not null (the loan still exists),
  the loan belongs to the user, the posted amount is **positive**, and the sign did **not** flip
  (a payment that posted as an inflow is not a payment — the link is skipped explicitly, not left
  to the link function's own `amount > 0` check). Then call
  `public.link_transaction_to_manual_loan(user, posted_id, loan, principal', …)` with
  `principal' = least(principal_portion, posted_amount)`. The link function applies
  `least(principal', remaining balance)` to the loan and records that clamped figure as
  `loan_balance_applied` (the applied-delta ledger), so a later LIM removal or loan deletion restores
  exactly what was applied. If `principal' < principal_portion`: `needs_review = true`, note
  "Principal reduced from $350 to $300 (posted amount $300)". If the loan is gone
  (`manual_loan_id` null but `manual_loan_id_snapshot` set): no link, note "Its loan 'SoFi' was
  deleted before this posted; the payment is no longer linked". The advisory lock is already held by
  this transaction; re-acquiring it inside the link function is a no-op.
- I6. Mark the carry-over consumed (`consumed_at`, `consumed_by_transaction_id`).
- I7. Classify the posted row from its own fields (as today); the override wins in `effective_role`.

**U. Updates** (`p_updates`): as today. A `modified` pending row updates in place (the
amount-compatibility check for linked rows stays); a `modified` posted row never re-carries anything.

Reconciliation and the repair sweep run after the page, in the application, as today; the cursor
advances only after they succeed, as today.

**Ledger proof obligation (G3).** For every commit: Σ `manual_loans.current_balance` change since the
start of the operation = Σ restored `loan_balance_applied` − Σ newly recorded `loan_balance_applied`,
and Σ `loan_balance_applied` over live linked rows is the ledger. The harness asserts
`sum(loan_balance_applied)` and each loan's `current_balance` before and after each case in §10,
including K12 where the clamp binds.

**Same-page ordering note.** Because R runs before I, a same-page pending→posted pair takes path
I1(b); a posted-first page takes I1(a)→I2; a removal-first page writes the carry-over and a later
page consumes it. One code path for the carry itself.

---

## 6. Pending-row mutations under the same lock (Codex's item 2)

Today's `UPDATE transactions SET budget_category_id …` / `SET needs_review = false` and the
delete-then-insert of splits run without the per-user lock, so they can interleave with a posting: an
edit can land on a row the batch RPC is about to delete, or between the batch's read of the pending
row and its delete, and be lost. All three become RPCs that take the lock **first**, then lock the row
and its ownership chain, verify ownership, and raise `transaction_not_found` if the row is gone:

```sql
set_transaction_budget_category(p_user_id uuid, p_transaction_id uuid, p_budget_category_id uuid)
  -- NULL allowed; verifies the category belongs to the user when not null;
  -- writes budget_category_id and budget_category_source = 'user' (also for NULL: a deliberate clear)
approve_transaction(p_user_id uuid, p_transaction_id uuid)
  -- needs_review = false, review_note = null
replace_transaction_splits(p_user_id uuid, p_transaction_id uuid, p_splits jsonb)
  -- verifies every budget_category_id is the user's; Σ amounts = the row amount to the cent with the
  -- row's sign; deletes existing splits and inserts the new ones in this one transaction; empty array
  -- clears. (Phase B later adds its role-eligibility check to this same function by replacing it.)
backfill_category_mapping(p_user_id uuid, p_plaid_category text, p_budget_category_id uuid) returns integer
  -- replaces dataService.backfillCategoryMapping's lock-free select-then-UPDATE (§6.1)
```

All SECURITY INVOKER, `search_path = ''`, service_role only, postcondition-asserted. The controllers
switch from direct `supabaseAdmin.from('transactions').update(…)` to these RPCs; the request/response
shapes are unchanged. Because the sync RPC and these RPCs take the same lock, a mutation either lands
on the pending row before the posting (and is carried) or finds the row gone (and is answered per §8)
— there is no third outcome.

### 6.1 The mapping backfill (Codex's finding)

`categoryMappingController` calls `dataService.backfillCategoryMapping(userId, plaidCategory,
budgetCategoryId)` when a mapping is created or changed. Today it selects the user's transactions with
that Plaid category and `budget_category_id is null`, then `UPDATE`s them — with no lock and with no
way to tell a deliberate clear from "never categorised", so it would overwrite a clear the user made
through the new category RPC (`source = 'user'`, value NULL). It becomes the RPC above:

- takes `pg_advisory_xact_lock(hashtext(p_user_id::text))` first, so it serialises with pending-row
  edits (§6), with posting (§5) and with Phase B's overrides;
- verifies `p_budget_category_id` belongs to the user;
- `update public.transactions t set budget_category_id = p_budget_category_id,
  budget_category_source = 'mapping' from … where <owned by p_user_id> and t.category =
  p_plaid_category and t.budget_category_id is null and t.budget_category_source is distinct from
  'user'` — **skips every user-cleared row**, and labels what it fills;
- also `update public.transaction_carryovers c set budget_category_id = …, budget_category_source =
  'mapping' where c.user_id = p_user_id and c.consumed_at is null and c.expires_at > now() and
  c.pending_plaid_category = p_plaid_category and c.budget_category_id is null and
  c.budget_category_source is distinct from 'user'` — so a pending row that was removed but not yet
  posted receives the mapping exactly as a live row would, and a user-cleared carry-over does not;
- returns the number of transaction rows filled (the controller's response is unchanged).

Rows whose label is null (pre-column) or stale (old-backend edits, §5 I3) and whose value is NULL are
filled, as today — their origin cannot be known. A clear made through the new backend is never
filled by the new backfill; §6.2 protects it from the **old** backfill as well.

### 6.2 The rollback-window safeguard: `transactions_keep_user_cleared_category` (Codex's blocker)

During a backend rollback (§9 window 4) the **old** backend runs today's lock-free
`backfillCategoryMapping`: `update transactions set budget_category_id = X where id in (…)` over every
row of that Plaid category whose category is NULL. That includes rows the user deliberately cleared
through the **new** backend (`NULL`, `source = 'user'`). The old code knows nothing about the label,
so it fills the value and leaves `'user'` in place — and when the new backend returns, the row reads
as the user's own choice of X. Nothing in the new backend can detect that after the fact, so the
protection has to live in the database, where it applies to every backend version:

- **Every new-backend writer of `budget_category_id` also stamps `budget_category_set_seq =
  nextval('transactions_budget_category_seq')`** in the same statement: the sync insert (mapping),
  `set_transaction_budget_category` (set or clear), `backfill_category_mapping` (transactions and
  carry-overs), and the posting copy in `_v2` (which copies the pending row's stamp). This is the
  "I know the protocol" signal; an old backend never touches the column. A sequence value, not
  `now()`: it is guaranteed to differ on every write, even for two writes inside one transaction
  (Codex cleanup point 1; proven in harness `a07`).
- **Trigger** `transactions_keep_user_cleared_category`, `BEFORE UPDATE OF budget_category_id ON
  public.transactions FOR EACH ROW`, function `public.transactions_keep_user_cleared_category()`
  (SECURITY INVOKER, `search_path = ''`, revoked from every role like `plaid_items_keep_removing()`):

  ```sql
  if old.budget_category_source = 'user'
     and old.budget_category_id is null
     and new.budget_category_id is not null
     and new.budget_category_set_at is not distinct from old.budget_category_set_at then
    new.budget_category_id := null;   -- a writer that does not know the protocol is filling a deliberate clear: keep the clear
  end if;
  return new;
  ```

  It pins **only** this one transition — a `'user'`-labelled NULL being filled by a statement that did
  not move the stamp. A new-backend re-categorisation of a cleared row moves the stamp and passes; the
  new backfill never targets `'user'` rows; the sync's `_v2` UPDATE path never writes
  `budget_category_id` (updates carry Plaid fields only), so it is unaffected; an old backend filling
  a NULL row labelled null or `'mapping'` passes (that is the documented, unchanged degradation for
  pre-column and old-backend clears). The same silent-pin pattern already backs up `removing` on
  `plaid_items`; a RAISE was rejected because it would fail the old backfill's whole multi-row UPDATE
  after the mapping itself was created.
- **Known, accepted limitation, confined to the rollback window:** through the *old* UI a user cannot
  re-categorise a row they had cleared through the new backend — the old category endpoint is also a
  stamp-less UPDATE and is pinned; the row visibly stays "uncategorised" until the new backend is
  back. Preferable to silently converting a mapping fill into a recorded user choice, which would be
  invisible and permanent.
- **Rollback of the schema** drops the trigger with the rest (§9 row 5); by then no old backend can be
  running against a `'user'` label anyway.

**Why `budget_category_source`.** Without it, "the user cleared this category" and "no mapping matched"
are both NULL: the mapping backfill would refill a deliberate clear, and any posting rule that
consulted the mapping would re-categorise one. Sync sets `'mapping'` when the insert-time mapping
assigns a category (null when it doesn't); the category RPC sets `'user'` (also for NULL — a
deliberate clear); the backfill RPC sets `'mapping'` on what it fills. Posting copies value and label
exactly (§5 I3) and never reads the mapping. The frontend needs no change for this.

---

## 7. What carries, with the amount-change rule (C1, decided)

| Carried state | Same amount | Amount changed (cents differ) | Sign flipped |
|---|---|---|---|
| `budget_category_id` (+ source) | kept (user NULL stays NULL) | kept | kept |
| approval (`needs_review = false`) | kept | **re-flagged**, note with both amounts | re-flagged |
| `user_role_override` + `_at` | kept | kept (a role describes the merchant/purpose, not the cents) | **dropped**, re-flagged (C4) |
| splits | re-created if every category still exists, else dropped + note | **dropped**, re-flagged | dropped, re-flagged |
| loan link + principal | re-linked, same principal (clamped to the remaining balance by the link function, K12) | re-linked with `least(principal, amount)`; re-flagged only if reduced (C3) | **link skipped**, re-flagged (C4) |

Approval is the user saying "I've seen this and it's right" about a specific amount; a
pre-authorisation that posts at a different amount is exactly what a reviewer wants to see, and no
threshold separates a tip from a discrepancy without guessing. Re-flagging costs one tap; the note
carries both amounts. Rows whose amount did not change stay approved.

---

## 8. Mutations racing the posting (G5, P4)

With §6, every mutation and the posting serialise on the per-user lock:

- Mutation first: the pending row gets the change; the posting then carries it (§5).
- Posting first: the pending row is gone and the RPC raises `transaction_not_found`. The controller
  then looks up `transaction_carryovers` **where `user_id = <signed-in user>` and
  `pending_transaction_row_id = <the id the client sent>`** — never by id alone, so a user can never
  learn that another user's row id existed or was superseded:
  - consumed → `409 transaction_superseded` with `superseded_by: <posted TransactionItem>` (its
    ownership is implied by the user-scoped lookup); the UI re-renders the posted row and, for a role
    override, re-issues against it with a fresh CAS value — automatically when the amount is
    unchanged, after a confirm when it changed;
  - unconsumed (removed, not yet posted) → `409 transaction_pending_removed`, "Your bank withdrew
    this pending transaction. If it posts, your earlier changes will carry over." Nothing is written
    (C5);
  - no carry-over for this user → 404 as today.

Phase B's override CAS (`expected_user_role_override`/`expected_auto_role`) applies unchanged to the
re-targeted request.

---

## 9. Deployment, coexistence and rollback (G7, Codex's item 1)

The old RPC `apply_synced_transaction_batch(p_user_id, p_inserts, p_updates)` and
`delete_transactions_and_restore_loan_balances` are **kept unchanged**; the new path is a new function,
`apply_synced_transaction_batch_v2`, plus the four mutation RPCs (category, approval, splits, mapping
backfill). Order of operations and what runs
against what:

| Window | Backend | Schema | Behaviour |
|---|---|---|---|
| 1. Before the migration | old | old | today |
| 2. Migration applied, old backend still running | old | new | old backend calls the old RPCs: inserts/updates then a separate delete; no carry-overs are written; a pending row removed in this window loses its corrections exactly as today (degradation, not corruption). Its category/approve/splits/backfill writes are today's lock-free ones and leave `budget_category_source` null or stale; posting later copies whatever value they left (§5 I3), so nothing they set or cleared is changed — only a clear they made stays fillable by a later backfill, as today. New columns are otherwise null; the new table is empty. |
| 3. New backend deployed | new | new | new backend calls `_v2` and the mutation RPCs; continuity active. |
| 4. Rollback of the backend | old | new | back to window 2 behaviour. Unconsumed carry-overs simply expire; consumed ones are inert audit rows; `review_note`/`posted_from_pending_amount`/`budget_category_source`/`budget_category_set_at` are ignored by the old code. The old category `UPDATE` leaves the label stale — harmless, because posting copies the value exactly whatever the label says (§5 I3). The old lock-free backfill tries to fill every NULL row, including clears labelled `'user'`: the **trigger (§6.2) keeps those at NULL**, so no mapping fill can masquerade as a user choice when the new backend returns; NULL rows labelled null/`'mapping'` are filled as today. Limitation: a new-backend clear cannot be re-categorised through the old UI in this window (§6.2). |
| 5. Schema rollback (only if abandoning the feature) | old | old | drop the table, the index, the trigger and its function, the **five RPCs** (`apply_synced_transaction_batch_v2`, `set_transaction_budget_category`, `approve_transaction`, `replace_transaction_splits`, `backfill_category_mapping`) and the **five continuity-only columns** (`pending_transaction_id`, `posted_from_pending_amount`, `review_note`, `budget_category_source`, `budget_category_set_at`); the old RPCs were never touched, so nothing has to be restored. **`user_role_override_at` is never dropped**: it is Phase B's user-history column, created here only for migration ordering; once any row holds a value, dropping it would destroy when the user made a correction. It is nullable and harmless to every backend version. Data in the dropped columns is not financial. |

The new backend must never run against the old schema (it would fail on the missing RPC at the first
sync), so the migration is applied first, as for LIM. The dry run must list exactly one file. A later
cleanup release (after `MIN_CLIENT_API_LEVEL` is raised, or simply once no old backend can run) drops
the old batch RPC.

---

## 10. Tests

### 10.1 Fixture (harness, real PostgreSQL, full history)

Account C (checking), card X (`credit`), manual loan L (balance 10 000, `match_text` none), budget
categories Dining, Groceries, Household. Cases, each asserting the row set, `sum(loan_balance_applied)`,
each loan's `current_balance`, splits, `budget_category_source`, notes, and idempotency by replaying
the same page twice:

| Case | Pending | User state on pending | Posted | Expected |
|---|---|---|---|---|
| K1 same page, same amount | 09-03 restaurant 52.10 | Dining (user), approved, override `expense` | same page: removed P, added Q 52.10 | Q: Dining/`user`, approved, override + `_at` kept, `pending_transaction_id` set, no note; carry-over consumed |
| K2 same page, amount changed | 52.10 | Dining, approved, splits 30/22.10 | Q 60.10 | Q: Dining, **needs_review**, splits dropped, note "Amount changed from $52.10 to $60.10; splits removed", `posted_from_pending_amount = 52.10` |
| K3 posted first | 400.00 linked to L, principal 350 | approved | page 1: added Q 400; page 2: removed P | after page 1: P gone (restored 350), Q linked, applied 350, L net unchanged; after page 2: no-op; Σ applied = 350 |
| K4 removal first, later sync | 400 linked 350 | Dining | sync 1: removed P → carry-over, L +350; sync 2: added Q 300 | Q linked principal' = 300, applied 300, L net +50 vs before, needs_review, note "Principal reduced from $350 to $300 (posted amount $300)" |
| K5 never posts | 25.00 | Groceries | removed P; 31 days pass | carry-over expires and is swept; nothing else changes |
| K6 sign flip | +52.10 override `expense`, linked to L principal 50 | — | Q −52.10 | override dropped, **no link attempted** (asserted: `link_transaction_to_manual_loan` not invoked; Q unlinked; L restored the 50 and nothing re-applied), needs_review, note "Sign changed…" |
| K7 loan deleted in between | 400 linked 350 | — | removed P; `delete_manual_loan_atomic(L)`; added Q 400 | Q not linked, needs_review, note "Its loan 'SoFi' was deleted before this posted; the payment is no longer linked" (from the snapshots); no balance touched (L is gone) |
| K8 replay | K2's page applied twice | | | identical state; one Q row; one carry-over, consumed once |
| K9 LIM removal with pending carry-overs | K4 after sync 1 | | remove the item | carry-over cascades; removal counts/digest unchanged; Σ ledger restored exactly as LIM already proves |
| K10 concurrency: override vs posting | 52.10 | — | holder: `_v2` posting P→Q; contender: `set_transaction_role_override(P)` | either order: Q ends with the override; the late call raises `transaction_not_found`, the controller answers `transaction_superseded`, the re-issue against Q succeeds |
| K11 no link from Plaid | 52.10 Dining | | Q without `pending_transaction_id` | Q is a new row (today's behaviour); P's carry-over stays unconsumed until expiry — nothing is guessed |
| **K12 the balance clamp binds** | L balance **300**; pending P 400 linked with principal 350 → the link clamps: applied `least(350, 300) = 300`, L = 0 | — | removed P (restore 300 → L = 300); added Q 400 | re-link with principal' 350 applies `least(350, 300) = 300` → `loan_balance_applied = 300`, L = 0; Q's `principal_portion` stays 350 (the user's figure) while the ledger records 300; `needs_review = true`, note "Only $300 of the $350 principal could be applied; the loan balance reached $0". Σ applied = 300 = what LIM removal or loan deletion will restore |
| **K12b another payment lands in between** | L 1 000; P 400 linked 350 (applied 350, L = 650) | — | sync 1: removed P (restore → 1 000); a posted payment Q2 with principal 900 links (applied 900, L = 100); sync 2: added Q 400 | re-link principal' 350 applies `least(350, 100) = 100` → applied 100, L = 0, `needs_review`, note as above with $100/$350; Σ applied over live rows = 900 + 100 = 1 000 = Σ recorded clamps |
| **K12c posted amount and balance both bind** | L 250; P 400 linked 350 (applied 250, L = 0) | — | removed P (→ 250); added Q **300** | principal' = `least(350, 300) = 300` (C3), applied `least(300, 250) = 250`, L = 0; two notes (principal reduced to $300; only $250 applied); `posted_from_pending_amount = 400` |
| **K17 category copied exactly, never re-mapped** | (a) pre-column row: Dining chosen by hand, `source` null, mapping(pending) = Groceries; (b) old-backend window: `UPDATE` set Household, label stale `'mapping'`; (c) row whose Groceries **equals** mapping(pending) (label `'mapping'`), posted Plaid category maps to **Dining**; (d) pre-column **cleared** row: NULL / null; (e) old-backend **clear** in the window: NULL / stale `'mapping'`; (f) never-categorised pending row: NULL / null, posted Plaid category maps to Dining; (g) new-backend clear: NULL / `'user'` | | Q | (a) Dining / null; (b) Household / `'mapping'` (stale label kept, value kept); (c) **Groceries** / `'mapping'` — not re-derived to Dining, the user may have chosen Groceries; (d) **NULL** / null — not re-mapped; (e) **NULL** / `'mapping'` — not re-mapped; (f) **NULL** / null — the accepted cost (C6): the row stays in the review queue and K18's backfill fills it later; (g) NULL / `'user'`. In every case value and label are byte-identical to the pending row's |
| **K18 mapping backfill skips user clears** | rows with Plaid category FOOD_AND_DRINK: R1 NULL / `'user'` (cleared via the new RPC), R2 NULL / null (pre-column), R3 NULL / `'mapping'` (old-backend clear), R4 Dining / `'user'`; unconsumed carry-overs: V1 NULL / `'user'`, V2 NULL / null, both `pending_plaid_category = FOOD_AND_DRINK` | user creates mapping FOOD_AND_DRINK → Groceries | `backfill_category_mapping` | R1 **unchanged** (NULL / `'user'`); R2 → Groceries / `'mapping'`; R3 → Groceries / `'mapping'` (the documented degradation for old-backend clears); R4 unchanged; V1 **unchanged**; V2 → Groceries / `'mapping'`; return value 2; not executable by client roles; another user's mapping id raises; **control against `main`:** today's `backfillCategoryMapping` fills R1 too |
| **K19 backfill vs posting, serialised** | pending P (NULL / null, Plaid category FOOD_AND_DRINK); **the posted row Q carries the same Plaid category** — the "same result in either order" claim assumes this, since the backfill matches on the row's own `category` | | holder: `_v2` page posting P→Q; contender: `backfill_category_mapping(FOOD_AND_DRINK → Groceries)` | backfill first: the carry-over is filled, Q posts with Groceries / `'mapping'`; posting first: Q posts NULL / null, then the backfill fills Q → Groceries / `'mapping'`; both orders end identically, both stamp `budget_category_set_at`. Variant with P cleared via the new RPC (NULL / `'user'`): both orders end NULL / `'user'`. Variant where Q's Plaid category **differs** (GENERAL_MERCHANDISE): backfill first → carry-over filled → Q Groceries; posting first → Q NULL and the backfill does not match it → the orders differ, which is expected and documented here, not a defect |
| **K20 old backfill cannot fill a new-backend clear** | R1 cleared via `set_transaction_budget_category` → NULL / `'user'` / stamped t1; R2 NULL / null; R3 NULL / `'mapping'` (old-backend clear) — all FOOD_AND_DRINK | | simulate the **old** backend's backfill: `update public.transactions set budget_category_id = <Groceries> where id in (R1, R2, R3)` as service_role, no stamp change | R1 stays **NULL / `'user'` / t1** (pinned by the trigger); R2 → Groceries (label still null); R3 → Groceries (label still `'mapping'`); the statement succeeds (no RAISE); then the new backend's `set_transaction_budget_category(R1, Dining)` → Dining / `'user'` / t2 (the stamp moved, so the trigger lets it through); **control against `main`** (no trigger): R1 is filled and reads as a user choice |
| **K20b the accepted limitation** | R1 as in K20 | | simulate the **old** category endpoint on R1: `update … set budget_category_id = <Dining> where id = R1` | pinned: R1 stays NULL / `'user'` (documented §6.2); the same statement on a row labelled null succeeds — the pin is specific to `'user'`-labelled NULLs |
| **K13 category deleted while splits held** | 60.00 splits Groceries 40 / Household 20 | | removed P; `deleteBudgetCategory(Household)`; added Q 60.00 | splits dropped (not partially re-created), needs_review, note "A category used by this transaction's splits was deleted; splits removed"; Q's own `budget_category_id` (Groceries) kept |
| **K14 cleared category** | 52.10, mapping assigned Dining, then the user **cleared** it (NULL, source `user`) | | Q 52.10 whose Plaid category maps to Dining | Q: `budget_category_id` **NULL**, source `user` — the mapping is not re-applied. Control: same row without the clear (source `mapping`) → Q gets Dining from the mapping |
| **K15 mutation under lock** | 52.10 | | holder: `_v2` page posting P→Q, paused after R2; contender: `set_transaction_budget_category(P, Groceries)` | contender waits on the lock, then raises `transaction_not_found`; controller → `transaction_superseded` (scoped to the user: a second user's lookup of the same id returns 404) |
| **K16 old backend on new schema** | 52.10 Dining | | old RPC sequence: `apply_synced_transaction_batch` (insert Q) then `delete_transactions_and_restore_loan_balances` (P) | Q is a new row without carry (today's behaviour); no carry-over row exists; no error — window 2 of §9 |

### 10.2 Backend unit tests
`applyTransactionChanges` builds one `_v2` call with removals, inserts and updates (no second RPC
call); the `superseded`/`pending_removed` controller responses for category, approve, splits, link,
and role, including that the lookup passes the signed-in user id; `mapPlaidTransaction` keeps
`pending_transaction_id`; controllers call the new mutation RPCs (no direct `update`);
`categoryMappingController` calls `backfill_category_mapping` (no `select … is null` + `update` pair
remains anywhere in `dataService`); the sweep deletes only expired unconsumed and old consumed records.

### 10.3 Frontend tests
"Posted · was pending $52.10" and `review_note` render; approve clears the note; the superseded flow
re-targets automatically when the amount is unchanged and confirms when it changed; `role="alert"`
for the pending-removed refusal; clearing a category then reloading shows it still cleared.

### 10.4 Control against `main`
K1 on today's code: Q has `needs_review = true`, no category, no override — the "fails before" proof.

---

## 11. Decisions (Trevor, 2026-09-26: all as recommended)

- **C1** Re-flag an approved pending row when the posted amount changes; keep approval when equal.
- **C2** Retention 30 days for unconsumed and consumed carry-overs.
- **C3** Posted amount smaller than the linked principal: re-link with `least(principal, amount)` and
  re-flag.
- **C4** Sign flip: drop the override, skip the loan link, re-flag.
- **C5** A mutation on a pending row Plaid has withdrawn but not (yet) posted: refuse with an
  explanation.
- **C6** (decided as recommended) — Posting copies the pending category exactly, including NULL, and
  never consults the mapping (§5 I3). Cost: a pending row that never received a category posts
  without one even when a mapping exists for the posted Plaid category; it stays in the review queue
  and is filled only if a mapping backfill is later actually run for that Plaid category (or the user
  categorises it). Alternative rejected: re-map rows that are NULL with a null label — that would
  re-categorise every clear made before the column existed or by an old backend.

---

## 12. Rollout

1. Codex review → implement on `feature/pending-posted-continuity`.
2. Preflight (read-only): ledger head; objects absent (the table, the **six** new `transactions`
   columns incl. `user_role_override_at`, the index, the **five RPCs and the trigger function**, the
   trigger); count of `pending = true` rows and how many carry a category/approval/splits/link (the
   exposure); count of rows with `budget_category_id is null` per Plaid category (what a future
   backfill could fill — none of them can yet be labelled `'user'`); confirm `pending_transaction_id`
   values are present in a Sandbox sync response.
3. Migration dry-run (one file) → push → postflight (RLS/grants on the new table; the **five RPCs'**
   privileges — `apply_synced_transaction_batch_v2`, `set_transaction_budget_category`,
   `approve_transaction`, `replace_transaction_splits`, `backfill_category_mapping` — executable by
   `service_role` only; the trigger function executable by no role and the trigger enabled; the old
   batch and delete RPCs byte-identical to before; Phase A objects untouched).
4. Merge/deploy (window 2 → 3 of §9); Sandbox smoke test: a pending Sandbox transaction categorised,
   cleared, re-categorised and approved, then posted — verify K1 and K14 live.
5. Rollback per §9 rows 4–5 — the backend first; the schema only if the feature is abandoned, and
   never dropping `user_role_override_at`.
