-- Financial Semantics Foundation, Phase A: persists the extra Plaid category detail needed to
-- distinguish a credit-card payment / internal transfer from ordinary spend (see the approved
-- Financial Semantics Foundation Design + corrections), plus one canonical semantic-role
-- classification per transaction. Entirely additive — no existing column is touched, no existing
-- financial calculation reads any of this yet (Phase B+ work).
--
-- personal_finance_category_detailed / _confidence: Plaid's own granular category and its
-- confidence in that category (VERY_HIGH/HIGH/MEDIUM/LOW/UNKNOWN, stored verbatim from Plaid, not
-- validated here) — already sent by Plaid on every transaction today but previously discarded
-- (only .primary was kept, in the existing `category` column). No new Plaid API call.
--
-- auto_role / role_source / role_confidence: the backend classifier's own output — see
-- transactionClassifier.ts for the precedence that produces these. classifier_version records
-- which version of that logic produced them, so a future algorithm change can selectively
-- re-classify only stale rows via an explicit backfill rather than silently reclassifying
-- everything. All three of auto_role/role_source/role_confidence are set atomically by the same
-- write (never independently), enforced by the all-or-none check below.
--
-- user_role_override: the user's own correction, if any — never written by sync, backfill, or
-- reconciliation, the same "later automation never resets an explicit user choice" guarantee this
-- schema already relies on for budget_category_id/needs_review.
--
-- effective_role: generated (not independently writable) so it can never drift from its own
-- inputs — every consumer that only needs a single-role-per-row answer reads this directly;
-- consumers that must account for manual-loan principal/interest decomposition use the
-- getSemanticEffects() backend helper instead (see that module's own doc comment for why
-- effective_role alone is insufficient for those rows).
--
-- ================================================================================================
-- DIRTY-DATA GATE (Round 16 remediation) — must stay the FIRST executable statements in this file.
-- ================================================================================================
-- This migration adds nine NOT VALID numeric CHECK constraints (see further below). NOT VALID
-- skips checking existing rows when the constraint is ADDED, but PostgreSQL still checks the
-- COMPLETE resulting row against every CHECK constraint on every later UPDATE of that row —
-- whichever columns the UPDATE touches. So a pre-existing violating row would become
-- un-updatable by every write path the moment this migration committed: a Plaid resync of it
-- fails the whole sync batch (and the sync cursor stops advancing), linking any transaction to a
-- loan with an unrelated bad column fails, and even editing a note fails. Verified on PostgreSQL 17
-- against the real schema history. This migration therefore refuses to install the constraints
-- over dirty data at all:
--
--  1. The LOCK below takes ACCESS EXCLUSIVE on the three constrained tables. Locks are held until
--     the migration's transaction ends, so no other session can insert or update a row in them
--     between the check below and the moment the constraints are installed and committed. A writer
--     that already holds a conflicting lock is waited for FIRST — so a violating row it commits is
--     seen by the check. Writers that arrive later queue behind this lock and are checked against
--     the new constraints once it commits. (ACCESS EXCLUSIVE rather than something weaker because
--     the transactions rewrite and the ADD CONSTRAINTs below need it anyway, and it is held until
--     commit regardless; taking it up front in a fixed order avoids lock-upgrade deadlocks. Reads
--     of these three tables wait for the duration of this migration.)
--  2. LOCK TABLE is only permitted inside a transaction block, so as the first statement it also
--     proves this file is running in ONE transaction: a runner that executed it statement by
--     statement in autocommit would fail right here, before anything was changed, rather than
--     leaving the migration half applied. Every model this has been verified against — an explicit
--     BEGIN/COMMIT (`psql -1`), and a single multi-statement query that PostgreSQL runs as one
--     implicit transaction — makes the whole file, gate included, all-or-nothing.
--  3. If any row violates any of the nine constraints, the DO block raises and the whole
--     migration rolls back: no column, table, function, grant or constraint from this file
--     remains. It never corrects, deletes or guesses at financial data. The error lists the
--     violation count per constraint; the operator lists the actual rows with the read-only
--     preflight queries in supabase/preflight/20260912120000_phase_a_numeric_preflight.sql,
--     corrects them deliberately, and re-runs this migration.
--
-- lock_timeout makes the migration fail cleanly (and roll back) rather than queue indefinitely
-- behind a long-running transaction while every other session queues behind it.
set local lock_timeout = '15s';

lock table public.manual_loans, public.manual_loan_payments, public.transactions in access exclusive mode;

do $$
declare
  v_found text := '';
  v_count bigint;
begin
  -- Each predicate is exactly its constraint's CHECK expression below; `is false` matches CHECK's
  -- own semantics (a NULL result passes a CHECK constraint).
  select count(*) into v_count from public.manual_loans
    where (current_balance >= 0 and current_balance < 'Infinity'::numeric) is false;
  if v_count > 0 then v_found := v_found || format(E'\n  manual_loans_current_balance_check: %s row(s)', v_count); end if;

  select count(*) into v_count from public.manual_loans
    where (origination_principal_amount is null
           or (origination_principal_amount >= 0 and origination_principal_amount < 'Infinity'::numeric)) is false;
  if v_count > 0 then v_found := v_found || format(E'\n  manual_loans_origination_principal_amount_check: %s row(s)', v_count); end if;

  select count(*) into v_count from public.manual_loans
    where (interest_rate_percentage is null
           or (interest_rate_percentage >= 0 and interest_rate_percentage < 'Infinity'::numeric)) is false;
  if v_count > 0 then v_found := v_found || format(E'\n  manual_loans_interest_rate_percentage_check: %s row(s)', v_count); end if;

  select count(*) into v_count from public.manual_loans
    where (minimum_payment_amount is null
           or (minimum_payment_amount >= 0 and minimum_payment_amount < 'Infinity'::numeric)) is false;
  if v_count > 0 then v_found := v_found || format(E'\n  manual_loans_minimum_payment_amount_check: %s row(s)', v_count); end if;

  select count(*) into v_count from public.manual_loans
    where (term_months is null or term_months > 0) is false;
  if v_count > 0 then v_found := v_found || format(E'\n  manual_loans_term_months_check: %s row(s)', v_count); end if;

  select count(*) into v_count from public.transactions
    where (amount > -'Infinity'::numeric and amount < 'Infinity'::numeric) is false;
  if v_count > 0 then v_found := v_found || format(E'\n  transactions_amount_finite_check: %s row(s)', v_count); end if;

  select count(*) into v_count from public.transactions
    where (principal_portion is null
           or (principal_portion >= 0 and principal_portion < 'Infinity'::numeric)) is false;
  if v_count > 0 then v_found := v_found || format(E'\n  transactions_principal_portion_check: %s row(s)', v_count); end if;

  select count(*) into v_count from public.manual_loan_payments
    where (principal_portion >= 0 and principal_portion < 'Infinity'::numeric) is false;
  if v_count > 0 then v_found := v_found || format(E'\n  manual_loan_payments_principal_portion_check: %s row(s)', v_count); end if;

  select count(*) into v_count from public.manual_loan_payments
    where (interest_portion >= 0 and interest_portion < 'Infinity'::numeric) is false;
  if v_count > 0 then v_found := v_found || format(E'\n  manual_loan_payments_interest_portion_check: %s row(s)', v_count); end if;

  if v_found <> '' then
    raise exception using
      errcode = 'check_violation',
      message = 'Phase A migration aborted before making any change: existing rows violate the new numeric constraints',
      detail = 'Violating rows per constraint:' || v_found,
      hint = 'List the rows with supabase/preflight/20260912120000_phase_a_numeric_preflight.sql, correct them '
             || '(one UPDATE per row fixing every bad column), then re-run this migration. Nothing was modified.';
  end if;
end
$$;

-- Adding a STORED generated column (effective_role, below) makes PostgreSQL rewrite the entire
-- transactions table while holding ACCESS EXCLUSIVE (already taken above). Reads and writes of
-- transactions wait for that rewrite and for the rest of this migration; the duration scales with
-- the table's size in production and cannot be predicted from test-data timings — plan the rollout
-- window around it.
alter table public.transactions
  add column personal_finance_category_detailed text null,
  add column personal_finance_category_confidence text null,
  add column auto_role text null,
  add column role_source text null,
  add column role_confidence text null,
  add column classifier_version smallint not null default 1,
  add column user_role_override text null;

alter table public.transactions
  add column effective_role text generated always as (
    coalesce(user_role_override, auto_role)
  ) stored;

alter table public.transactions
  add constraint transactions_auto_role_check
    check (auto_role is null or auto_role in
      ('expense', 'income', 'internal_transfer', 'credit_card_payment', 'debt_payment', 'refund'));

alter table public.transactions
  add constraint transactions_user_role_override_check
    check (user_role_override is null or user_role_override in
      ('expense', 'income', 'internal_transfer', 'credit_card_payment', 'debt_payment', 'refund'));

-- Round 2 remediation: 'refund_candidate_unconfirmed' was removed — an ordinary negative
-- transaction with no refund evidence classifies directly and finally as income/sign_default
-- (see transactionClassifier.ts's own doc comment); reconciliation independently reconsiders any
-- sign_default negative row against real refund evidence, with no separate speculative tag needed.
alter table public.transactions
  add constraint transactions_role_source_check
    check (role_source is null or role_source in (
      'manual_loan_link',
      'category_detailed',
      'category_primary_fallback',
      'category_detailed_account_transfer',
      'account_pair_match',
      'refund_match',
      'transfer_like_unconfirmed',
      'sign_default'
    ));

alter table public.transactions
  add constraint transactions_role_confidence_check
    check (role_confidence is null or role_confidence in ('high', 'medium', 'low'));

alter table public.transactions
  add constraint transactions_classifier_version_check
    check (classifier_version > 0);

-- auto_role/role_source/role_confidence are set together by the classifier or not at all — this
-- catches any future write path that accidentally sets one without the other two.
alter table public.transactions
  add constraint transactions_role_fields_all_or_none_check
    check (
      (auto_role is null and role_source is null and role_confidence is null)
      or
      (auto_role is not null and role_source is not null and role_confidence is not null)
    );

-- Round 3 remediation: ownership-safe, truly atomic semantic-role mutation. The application layer
-- previously issued `UPDATE ... WHERE id IN (...)` and only inspected the returned rows for
-- ownership AFTER the write — a wrong-user id, or one of two ids in an intended transfer pair,
-- could already be mutated before that check ever ran. This function moves the entire
-- verify-then-write sequence inside ONE PostgreSQL function invocation (itself one statement, one
-- implicit transaction): it locks the OWNED candidate rows before touching anything, verifies
-- that count matches the caller's own transaction-id list exactly, performs the update restricted
-- to exactly that locked/verified set, and re-verifies the affected-row count afterward. Any
-- mismatch at any point RAISEs, which rolls back everything this call did — there is no code path
-- that can leave a partial/half-resolved mutation durable. Used for both a single-row mutation
-- (pass a one-element array) and an atomic transfer-pair mutation (pass a two-element array) —
-- one function, parameterized by array length, rather than two near-duplicate ones.
--
-- Round 4 remediation §1: the ownership/lock step below deliberately does NOT combine `count(*)`
-- with `for update` in the same SELECT — PostgreSQL rejects `FOR UPDATE`/`FOR SHARE` combined
-- with an aggregate function (a genuine SQL compile error, not merely a style preference), so an
-- earlier version of this function that wrote exactly that would have failed at execution time.
-- The fix separates the two concerns: an INNER, non-aggregate `SELECT ... FOR UPDATE OF t` locks
-- and materializes the owned candidate ids into `v_owned_ids` first; an OUTER `array_agg` (no
-- locking clause of its own, so it's unaffected by the restriction) then counts them. The
-- subsequent UPDATE is restricted to exactly `v_owned_ids` (the already-locked, already-verified
-- set), not re-derived via a second ownership join — there is no gap between verifying ownership
-- and writing within which the locked rows could be anything other than what was just checked.
--
-- security invoker (the default, stated explicitly for audit clarity): this function is only ever
-- invoked by the backend's own service-role connection (see dataService.ts's
-- applyTransactionSemanticRoles, its sole caller — never exposed to the authenticated/anon roles
-- PostgREST serves directly to the frontend). The service role already has full table access
-- (Supabase grants it BYPASSRLS), so there is no privilege this function needs to elevate to via
-- security definer — using invoker keeps it running with exactly the caller's own (already
-- sufficient, already audited) privileges, the smaller attack surface of the two options.
-- search_path is pinned empty and every identifier is schema-qualified, so this function's
-- behavior can never be altered by a schema earlier in some other role's search_path.
--
-- Round 5 remediation (blocker 3, partial mitigation): candidate discovery/ranking happens in the
-- application layer, in a SEPARATE request from this mutation — this function alone cannot make
-- that whole read-then-decide-then-write sequence transactional. What it CAN do, and now does, is
-- serialize concurrent writers for the SAME user: `pg_advisory_xact_lock` below blocks a second
-- concurrent call for this user_id until the first one commits or rolls back, closing the
-- practical race window (a sync and a manual-loan link/unlink, or two syncs, interleaving between
-- one caller's read and its write) without requiring every reader to also hold a lock. This is a
-- transaction-scoped lock (auto-released at COMMIT/ROLLBACK, never orphaned) keyed by user_id, so
-- writers for DIFFERENT users never block each other.
--
-- Round 5 remediation (HIGH — ownership-chain rows not locked): the locking SELECT below now also
-- locks the joined `accounts`/`plaid_items` rows (`for update of t, a, pi`), not just
-- `transactions` — a concurrent reparenting of an account to a different plaid_item/user between
-- this check and the UPDATE could otherwise change ownership out from under an already-"verified"
-- row. No current application code path reparents those relationships, but locking the whole
-- ownership chain removes the assumption entirely rather than relying on it never happening.
--
-- Round 6 remediation (blocker 3, completing the mitigation): the advisory lock above prevents
-- two concurrent WRITES for the same user from interleaving with each other, but it does nothing
-- about a write that was DECIDED (candidate ranked, pair confirmed) against a READ that happened
-- moments earlier, outside any lock, in the application layer — by the time this function
-- actually runs, a different concurrent operation could already have changed the very rows this
-- call is about to write over. `p_expected_role_sources` (parallel to `p_transaction_ids`, same
-- length and order) closes that gap with an explicit compare-and-swap: the caller passes the
-- role_source each row was observed to have AT THE MOMENT candidate selection decided to write
-- it, and this function verifies every owned row's CURRENT role_source still matches before
-- writing anything. A mismatch means the semantic state this call's decision was based on is
-- already stale — RAISE and roll back, exactly like any other integrity failure, rather than
-- commit a decision made from data that's no longer true.
create or replace function public.apply_transaction_semantic_roles(
  p_user_id uuid,
  p_transaction_ids uuid[],
  p_expected_role_sources text[],
  p_auto_role text,
  p_role_source text,
  p_role_confidence text,
  p_classifier_version smallint
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_input_count integer;
  v_distinct_count integer;
  v_owned_ids uuid[];
  v_owned_count integer;
  v_updated_count integer;
  v_stale_count integer;
begin
  -- Serialize concurrent semantic writers for this user (see this function's own comment above)
  -- before reading anything — every subsequent step in this call sees a consistent view no other
  -- concurrent call for the same user can interleave with.
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  v_input_count := coalesce(array_length(p_transaction_ids, 1), 0);
  if v_input_count = 0 then
    raise exception 'apply_transaction_semantic_roles: no transaction ids supplied';
  end if;

  if coalesce(array_length(p_expected_role_sources, 1), 0) is distinct from v_input_count then
    raise exception 'apply_transaction_semantic_roles: expected_role_sources length (%) must match transaction_ids length (%)',
      coalesce(array_length(p_expected_role_sources, 1), 0), v_input_count;
  end if;

  -- Reject duplicate ids outright — otherwise a caller passing e.g. [X, X] could satisfy a naive
  -- "count matches" check without actually referring to two distinct rows.
  select count(distinct x) into v_distinct_count from unnest(p_transaction_ids) as x;
  if v_distinct_count is distinct from v_input_count then
    raise exception 'apply_transaction_semantic_roles: duplicate transaction ids supplied (% distinct of %)',
      v_distinct_count, v_input_count;
  end if;

  -- Verify ownership and LOCK the candidate rows (and their ownership chain) inside this same
  -- transaction, before any write. The locking SELECT itself carries no aggregate (Postgres
  -- forbids that combination) — it just locks and returns each owned row's id; the surrounding
  -- array_agg (unlocked) is what counts them. An id that doesn't come back here (wrong user, or
  -- the row no longer exists) means the whole call fails — nothing is ever partially applied to
  -- the ids that DID resolve.
  select array_agg(owned.id) into v_owned_ids
  from (
    select t.id
    from public.transactions t
    join public.accounts a on a.id = t.account_id
    join public.plaid_items pi on pi.id = a.item_id
    where t.id = any(p_transaction_ids)
      and pi.user_id = p_user_id
    for update of t, a, pi
  ) owned;

  v_owned_count := coalesce(array_length(v_owned_ids, 1), 0);

  if v_owned_count is distinct from v_input_count then
    raise exception 'apply_transaction_semantic_roles: ownership check failed (expected % owned rows, found %)',
      v_input_count, v_owned_count;
  end if;

  -- Compare-and-swap check (Round 6 remediation, blocker 3): every owned row's CURRENT
  -- role_source, now locked, must still match what the caller expected when it decided to write
  -- this mutation. Multi-argument unnest() pairs the two arrays strictly by position (the array
  -- length check above already guarantees they're the same length, so there's no padding/
  -- misalignment risk) — this is a positional pairing, not a join that could reorder anything.
  select count(*) into v_stale_count
  from unnest(p_transaction_ids, p_expected_role_sources) as expected(id, role_source)
  join public.transactions t on t.id = expected.id
  where t.role_source is distinct from expected.role_source;

  if v_stale_count > 0 then
    raise exception 'apply_transaction_semantic_roles: % row(s) no longer have the expected role_source — a concurrent modification changed the semantic state this decision was based on',
      v_stale_count;
  end if;

  -- Restricted to v_owned_ids (the exact set just locked and verified above) rather than
  -- re-derived via a second ownership join — there is no window in which "the rows this UPDATE
  -- touches" could differ from "the rows we just proved are owned and holding a row lock".
  update public.transactions t
  set auto_role = p_auto_role,
      role_source = p_role_source,
      role_confidence = p_role_confidence,
      classifier_version = p_classifier_version
  where t.id = any(v_owned_ids);

  get diagnostics v_updated_count = row_count;

  if v_updated_count is distinct from v_input_count then
    raise exception 'apply_transaction_semantic_roles: update count mismatch (expected %, got %)',
      v_input_count, v_updated_count;
  end if;
end;
$$;

-- Round 4 remediation §2: `revoke ... from public` alone is insufficient. This project's base
-- schema (see 20260825195130_remote_schema.sql) runs
-- `alter default privileges for role "postgres" in schema "public" grant execute on functions to
-- "anon"/"authenticated"` — meaning EVERY function this migration creates (as role "postgres")
-- receives a DIRECT execute grant to anon and authenticated automatically at creation time,
-- entirely independent of PUBLIC. Revoking from PUBLIC only removes the privilege every role gets
-- implicitly through PUBLIC; it does nothing to a grant made directly to a named role. Without
-- the explicit revokes below, this function — despite `security invoker` and despite never being
-- called from application code as anon/authenticated — would still be directly EXECUTE-able by
-- both the anonymous and authenticated PostgREST roles the frontend uses, letting any signed-in
-- user attempt (and have rejected, but still attempt) an arbitrary semantic-role mutation via a
-- direct RPC call. Explicitly revoking from anon and authenticated (in addition to PUBLIC) closes
-- that gap; only service_role — the backend's own connection — may ever execute this function.
revoke execute on function public.apply_transaction_semantic_roles(uuid, uuid[], text[], text, text, text, smallint) from public;
revoke execute on function public.apply_transaction_semantic_roles(uuid, uuid[], text[], text, text, text, smallint) from anon;
revoke execute on function public.apply_transaction_semantic_roles(uuid, uuid[], text[], text, text, text, smallint) from authenticated;
grant execute on function public.apply_transaction_semantic_roles(uuid, uuid[], text[], text, text, text, smallint) to service_role;

-- Round 6 remediation (blocker 4): every manual-loan-balance-affecting mutation below was
-- previously two separate requests — one write to the linked row (a transaction or a manual
-- payment), one write to manual_loans.current_balance — with no way to make them succeed or fail
-- together. A failure between the two (network blip, process restart, a concurrent request) could
-- durably split them: the link/payment persists but the balance never moves, or vice versa, and a
-- retry of the ORIGINAL request could then double-apply or skip the delta entirely, since the
-- retry re-reads whatever half-applied state was left behind. Each function below performs its
-- row mutation AND its balance adjustment inside one PL/pgSQL function invocation — one implicit
-- Postgres transaction — so there is no window in which one could persist without the other.
--
-- All follow the same shape already established by apply_transaction_semantic_roles: a per-user
-- pg_advisory_xact_lock taken first (serializing every semantic/balance-affecting write for one
-- user against every other, across ALL of these functions AND apply_transaction_semantic_roles —
-- they share the same lock key), explicit ownership verification with FOR UPDATE row locks on
-- every row touched (transactions via its accounts/plaid_items chain, manual_loans and
-- manual_loan_payments directly), and RAISE EXCEPTION (rolling back the whole call) on any
-- integrity failure. security invoker, empty search_path, and public-qualified identifiers
-- throughout, exactly as audited for apply_transaction_semantic_roles above — same rationale, not
-- repeated per function.

-- Atomically links a transaction to a manual loan and decrements the loan's balance by
-- principal_portion. Replaces dataService.ts's old two-step linkTransactionToLoan (an UPDATE to
-- transactions, then a separate read-modify-write to manual_loans.current_balance).
create or replace function public.link_transaction_to_manual_loan(
  p_user_id uuid,
  p_transaction_id uuid,
  p_loan_id uuid,
  p_principal_portion numeric,
  p_classifier_version smallint
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_amount numeric;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  select t.amount into v_amount
  from public.transactions t
  join public.accounts a on a.id = t.account_id
  join public.plaid_items pi on pi.id = a.item_id
  where t.id = p_transaction_id
    and pi.user_id = p_user_id
  for update of t, a, pi;

  if not found then
    raise exception 'link_transaction_to_manual_loan: transaction not found or not owned by user';
  end if;

  -- Round 10 remediation: `>= 0 and < 'Infinity'` rather than a bare `< 0` test — PostgreSQL orders
  -- NaN above every ordinary numeric, so `NaN < 0` is false and NaN would otherwise slip through
  -- whenever v_amount is itself non-finite (making the `> v_amount` comparison false too).
  if p_principal_portion is null
     or not (p_principal_portion >= 0 and p_principal_portion < 'Infinity'::numeric)
     or not (v_amount > -'Infinity'::numeric and v_amount < 'Infinity'::numeric)
     or p_principal_portion > v_amount then
    raise exception 'link_transaction_to_manual_loan: principal_portion (%) must be a finite value between 0 and the transaction amount (%)',
      p_principal_portion, v_amount;
  end if;

  perform 1 from public.manual_loans where id = p_loan_id and user_id = p_user_id for update;
  if not found then
    raise exception 'link_transaction_to_manual_loan: manual loan not found or not owned by user';
  end if;

  update public.transactions
  set manual_loan_id = p_loan_id,
      principal_portion = p_principal_portion,
      auto_role = 'debt_payment',
      role_source = 'manual_loan_link',
      role_confidence = 'high',
      classifier_version = p_classifier_version
  where id = p_transaction_id;

  update public.manual_loans
  set current_balance = greatest(0, round((current_balance - p_principal_portion)::numeric, 2)),
      updated_at = now()
  where id = p_loan_id;
end;
$$;

revoke execute on function public.link_transaction_to_manual_loan(uuid, uuid, uuid, numeric, smallint) from public;
revoke execute on function public.link_transaction_to_manual_loan(uuid, uuid, uuid, numeric, smallint) from anon;
revoke execute on function public.link_transaction_to_manual_loan(uuid, uuid, uuid, numeric, smallint) from authenticated;
grant execute on function public.link_transaction_to_manual_loan(uuid, uuid, uuid, numeric, smallint) to service_role;

-- Atomically reverses a payment link, restoring the loan's balance and reclassifying the
-- transaction. Idempotent (Round 5 remediation §7): returns FALSE without any write at all if the
-- transaction is already unlinked (from any loan), which a retry after a persisted-unlink-but-
-- failed-caller-side-step can safely rely on. Returns TRUE if it performed the unlink.
create or replace function public.unlink_transaction_from_manual_loan(
  p_user_id uuid,
  p_transaction_id uuid,
  p_loan_id uuid,
  p_auto_role text,
  p_role_source text,
  p_role_confidence text,
  p_classifier_version smallint
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_manual_loan_id uuid;
  v_principal_portion numeric;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  select t.manual_loan_id, t.principal_portion into v_manual_loan_id, v_principal_portion
  from public.transactions t
  join public.accounts a on a.id = t.account_id
  join public.plaid_items pi on pi.id = a.item_id
  where t.id = p_transaction_id
    and pi.user_id = p_user_id
  for update of t, a, pi;

  if not found then
    raise exception 'unlink_transaction_from_manual_loan: transaction not found or not owned by user';
  end if;

  if v_manual_loan_id is null then
    return false;
  end if;

  if v_manual_loan_id is distinct from p_loan_id then
    raise exception 'unlink_transaction_from_manual_loan: transaction is linked to a different loan';
  end if;

  perform 1 from public.manual_loans where id = p_loan_id and user_id = p_user_id for update;
  if not found then
    raise exception 'unlink_transaction_from_manual_loan: manual loan not found or not owned by user';
  end if;

  update public.transactions
  set manual_loan_id = null,
      principal_portion = null,
      auto_role = p_auto_role,
      role_source = p_role_source,
      role_confidence = p_role_confidence,
      classifier_version = p_classifier_version
  where id = p_transaction_id;

  update public.manual_loans
  set current_balance = round((current_balance + coalesce(v_principal_portion, 0))::numeric, 2),
      updated_at = now()
  where id = p_loan_id;

  return true;
end;
$$;

revoke execute on function public.unlink_transaction_from_manual_loan(uuid, uuid, uuid, text, text, text, smallint) from public;
revoke execute on function public.unlink_transaction_from_manual_loan(uuid, uuid, uuid, text, text, text, smallint) from anon;
revoke execute on function public.unlink_transaction_from_manual_loan(uuid, uuid, uuid, text, text, text, smallint) from authenticated;
grant execute on function public.unlink_transaction_from_manual_loan(uuid, uuid, uuid, text, text, text, smallint) to service_role;

-- Atomically edits how much of an already-linked payment counts toward principal, adjusting the
-- loan's balance by the difference in the SAME transaction — replaces the old fetch-old-value,
-- write-new-value, then separately read-modify-write-balance sequence.
create or replace function public.update_linked_payment_principal(
  p_user_id uuid,
  p_transaction_id uuid,
  p_loan_id uuid,
  p_new_principal_portion numeric
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_manual_loan_id uuid;
  v_old_principal numeric;
  v_amount numeric;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  select t.manual_loan_id, t.principal_portion, t.amount into v_manual_loan_id, v_old_principal, v_amount
  from public.transactions t
  join public.accounts a on a.id = t.account_id
  join public.plaid_items pi on pi.id = a.item_id
  where t.id = p_transaction_id
    and pi.user_id = p_user_id
  for update of t, a, pi;

  if not found then
    raise exception 'update_linked_payment_principal: transaction not found or not owned by user';
  end if;

  if v_manual_loan_id is distinct from p_loan_id then
    raise exception 'update_linked_payment_principal: transaction is not linked to this loan';
  end if;

  -- Round 10 remediation (finiteness) — see link_transaction_to_manual_loan for why a bare `< 0`
  -- test is not sufficient to exclude NaN.
  if p_new_principal_portion is null
     or not (p_new_principal_portion >= 0 and p_new_principal_portion < 'Infinity'::numeric)
     or not (v_amount > -'Infinity'::numeric and v_amount < 'Infinity'::numeric)
     or p_new_principal_portion > v_amount then
    raise exception 'update_linked_payment_principal: principal_portion (%) must be a finite value between 0 and the transaction amount (%)',
      p_new_principal_portion, v_amount;
  end if;

  perform 1 from public.manual_loans where id = p_loan_id and user_id = p_user_id for update;
  if not found then
    raise exception 'update_linked_payment_principal: manual loan not found or not owned by user';
  end if;

  update public.transactions
  set principal_portion = p_new_principal_portion
  where id = p_transaction_id;

  update public.manual_loans
  set current_balance = greatest(0, round((current_balance + coalesce(v_old_principal, 0) - p_new_principal_portion)::numeric, 2)),
      updated_at = now()
  where id = p_loan_id;
end;
$$;

revoke execute on function public.update_linked_payment_principal(uuid, uuid, uuid, numeric) from public;
revoke execute on function public.update_linked_payment_principal(uuid, uuid, uuid, numeric) from anon;
revoke execute on function public.update_linked_payment_principal(uuid, uuid, uuid, numeric) from authenticated;
grant execute on function public.update_linked_payment_principal(uuid, uuid, uuid, numeric) to service_role;

-- Atomically inserts a manually-logged payment and decrements the loan's balance.
create or replace function public.create_manual_loan_payment(
  p_user_id uuid,
  p_loan_id uuid,
  p_date date,
  p_principal_portion numeric,
  p_interest_portion numeric,
  p_notes text
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_payment_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  perform 1 from public.manual_loans where id = p_loan_id and user_id = p_user_id for update;
  if not found then
    raise exception 'create_manual_loan_payment: manual loan not found or not owned by user';
  end if;

  -- Round 10 remediation (finiteness): `< 0` alone admits NaN and +Infinity, either of which would
  -- propagate straight into the loan's current_balance arithmetic below and poison it permanently.
  if p_principal_portion is null
     or not (p_principal_portion >= 0 and p_principal_portion < 'Infinity'::numeric) then
    raise exception 'create_manual_loan_payment: principal_portion must be a finite non-negative number';
  end if;
  if p_interest_portion is null
     or not (p_interest_portion >= 0 and p_interest_portion < 'Infinity'::numeric) then
    raise exception 'create_manual_loan_payment: interest_portion must be a finite non-negative number';
  end if;

  insert into public.manual_loan_payments (user_id, loan_id, date, principal_portion, interest_portion, notes)
  values (p_user_id, p_loan_id, p_date, p_principal_portion, p_interest_portion, p_notes)
  returning id into v_payment_id;

  update public.manual_loans
  set current_balance = greatest(0, round((current_balance - p_principal_portion)::numeric, 2)),
      updated_at = now()
  where id = p_loan_id;

  return v_payment_id;
end;
$$;

revoke execute on function public.create_manual_loan_payment(uuid, uuid, date, numeric, numeric, text) from public;
revoke execute on function public.create_manual_loan_payment(uuid, uuid, date, numeric, numeric, text) from anon;
revoke execute on function public.create_manual_loan_payment(uuid, uuid, date, numeric, numeric, text) from authenticated;
grant execute on function public.create_manual_loan_payment(uuid, uuid, date, numeric, numeric, text) to service_role;

-- Atomically applies a partial patch to a manually-logged payment, adjusting the loan's balance
-- ONLY when principal_portion is part of the patch. The four `p_set_*` flags distinguish "field
-- not part of this patch" from "field explicitly set to its SQL NULL value" (`notes` legitimately
-- accepts null) — a plain NULL parameter alone can't express that distinction.
create or replace function public.update_manual_loan_payment(
  p_user_id uuid,
  p_payment_id uuid,
  p_loan_id uuid,
  p_set_date boolean,
  p_date date,
  p_set_principal_portion boolean,
  p_principal_portion numeric,
  p_set_interest_portion boolean,
  p_interest_portion numeric,
  p_set_notes boolean,
  p_notes text
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_old_principal numeric;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  perform 1 from public.manual_loans where id = p_loan_id and user_id = p_user_id for update;
  if not found then
    raise exception 'update_manual_loan_payment: manual loan not found or not owned by user';
  end if;

  select principal_portion into v_old_principal
  from public.manual_loan_payments
  where id = p_payment_id and loan_id = p_loan_id
  for update;

  if not found then
    raise exception 'update_manual_loan_payment: payment not found for this loan';
  end if;

  -- Round 10 remediation (finiteness) — see create_manual_loan_payment for why `< 0` alone is not
  -- sufficient to exclude NaN/Infinity.
  if p_set_principal_portion
     and (p_principal_portion is null
          or not (p_principal_portion >= 0 and p_principal_portion < 'Infinity'::numeric)) then
    raise exception 'update_manual_loan_payment: principal_portion must be a finite non-negative number';
  end if;
  if p_set_interest_portion
     and (p_interest_portion is null
          or not (p_interest_portion >= 0 and p_interest_portion < 'Infinity'::numeric)) then
    raise exception 'update_manual_loan_payment: interest_portion must be a finite non-negative number';
  end if;

  update public.manual_loan_payments
  set date = case when p_set_date then p_date else date end,
      principal_portion = case when p_set_principal_portion then p_principal_portion else principal_portion end,
      interest_portion = case when p_set_interest_portion then p_interest_portion else interest_portion end,
      notes = case when p_set_notes then p_notes else notes end
  where id = p_payment_id;

  if p_set_principal_portion then
    update public.manual_loans
    set current_balance = greatest(0, round((current_balance + coalesce(v_old_principal, 0) - p_principal_portion)::numeric, 2)),
        updated_at = now()
    where id = p_loan_id;
  end if;
end;
$$;

revoke execute on function public.update_manual_loan_payment(uuid, uuid, uuid, boolean, date, boolean, numeric, boolean, numeric, boolean, text) from public;
revoke execute on function public.update_manual_loan_payment(uuid, uuid, uuid, boolean, date, boolean, numeric, boolean, numeric, boolean, text) from anon;
revoke execute on function public.update_manual_loan_payment(uuid, uuid, uuid, boolean, date, boolean, numeric, boolean, numeric, boolean, text) from authenticated;
grant execute on function public.update_manual_loan_payment(uuid, uuid, uuid, boolean, date, boolean, numeric, boolean, numeric, boolean, text) to service_role;

-- Atomically deletes a manually-logged payment and restores its principal to the loan's balance.
-- Idempotent: a payment already gone (id not found for this loan) is a silent no-op, matching the
-- pre-existing dataService.ts contract for this operation.
create or replace function public.delete_manual_loan_payment(
  p_user_id uuid,
  p_payment_id uuid,
  p_loan_id uuid
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_principal numeric;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  perform 1 from public.manual_loans where id = p_loan_id and user_id = p_user_id for update;
  if not found then
    raise exception 'delete_manual_loan_payment: manual loan not found or not owned by user';
  end if;

  select principal_portion into v_principal
  from public.manual_loan_payments
  where id = p_payment_id and loan_id = p_loan_id
  for update;

  if not found then
    return;
  end if;

  delete from public.manual_loan_payments where id = p_payment_id;

  update public.manual_loans
  set current_balance = round((current_balance + coalesce(v_principal, 0))::numeric, 2),
      updated_at = now()
  where id = p_loan_id;
end;
$$;

revoke execute on function public.delete_manual_loan_payment(uuid, uuid, uuid) from public;
revoke execute on function public.delete_manual_loan_payment(uuid, uuid, uuid) from anon;
revoke execute on function public.delete_manual_loan_payment(uuid, uuid, uuid) from authenticated;
grant execute on function public.delete_manual_loan_payment(uuid, uuid, uuid) to service_role;

-- Atomically deletes Plaid-removed transactions AND restores the manual-loan balance for any of
-- them that were still linked (Round 6 remediation, blocker 4's Plaid-removal gap) — a linked
-- transaction Plaid reports as removed (e.g. a pending row replaced by its posted counterpart)
-- previously vanished via a plain DELETE with no balance restoration at all, permanently
-- overstating how much principal had been paid down. Scoped to the given user via the same
-- accounts/plaid_items ownership chain as every other function here, even though
-- plaid_transaction_id is already effectively unique, for defense in depth and audit consistency.
create or replace function public.delete_transactions_and_restore_loan_balances(
  p_user_id uuid,
  p_plaid_transaction_ids text[]
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r record;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  for r in
    select t.id, t.manual_loan_id, t.principal_portion
    from public.transactions t
    join public.accounts a on a.id = t.account_id
    join public.plaid_items pi on pi.id = a.item_id
    where t.plaid_transaction_id = any(p_plaid_transaction_ids)
      and pi.user_id = p_user_id
      and t.manual_loan_id is not null
    for update of t
  loop
    update public.manual_loans
    set current_balance = round((current_balance + coalesce(r.principal_portion, 0))::numeric, 2),
        updated_at = now()
    where id = r.manual_loan_id;
  end loop;

  delete from public.transactions t
  using public.accounts a, public.plaid_items pi
  where t.account_id = a.id
    and a.item_id = pi.id
    and t.plaid_transaction_id = any(p_plaid_transaction_ids)
    and pi.user_id = p_user_id;
end;
$$;

revoke execute on function public.delete_transactions_and_restore_loan_balances(uuid, text[]) from public;
revoke execute on function public.delete_transactions_and_restore_loan_balances(uuid, text[]) from anon;
revoke execute on function public.delete_transactions_and_restore_loan_balances(uuid, text[]) from authenticated;
grant execute on function public.delete_transactions_and_restore_loan_balances(uuid, text[]) to service_role;

-- Round 7 remediation (blocker 3, completing the transactional-unification ask): the
-- p_expected_role_sources CAS check added in Round 6 detects a row that CHANGED between
-- candidate ranking (in the application) and this write, but it cannot detect a THIRD row that
-- was inserted or modified in that same window such that, if re-ranked now, it would outrank or
-- tie with the candidate the application already picked — a "phantom candidate." Closing that
-- requires candidate discovery and ranking to happen INSIDE the same locked transaction as the
-- write, not merely re-validating the two target rows. This function does exactly that: under
-- the same per-user advisory lock every other function here uses, it re-runs the transfer-
-- counterpart discovery query and the same deterministic ranking rule (closest date wins, a tie
-- at the best distance is ambiguous) FOR BOTH candidate rows, from CURRENT locked data, and only
-- commits if each row's own freshly-computed best match is still the other one. The application
-- layer's own ranking (roleReconciliation.ts's computeReciprocalTransferResolution) is still what
-- decides WHICH pair looks worth attempting — that stays outside the database, since it also
-- drives dry-run preview and pool-based same-batch lookahead, neither of which apply once we're
-- actually about to write — but this function is the sole authority on whether a candidate pair
-- is still correct at the moment of commit, and never trusts the application's ranking alone.
--
-- Residual, re-examined and resolved (Round 9 final audit): earlier rounds disclosed, but did not
-- close, a theoretical gap — a row matching the search criteria INSERTED by a concurrent
-- transaction strictly after this function's own discovery query runs but before this function
-- commits is not itself lockable (there is no row to lock until it exists), so FOR UPDATE alone
-- cannot detect it; only SERIALIZABLE isolation (or locking the entire candidate keyspace some
-- other way) closes that specific sub-case in the abstract, general case, and a live test against
-- disposable Postgres 15 confirmed SET TRANSACTION ISOLATION LEVEL SERIALIZABLE cannot even be
-- issued as the first statement of a function invoked via a top-level RPC call (the call itself
-- already counts as a preceding query by the time the function body runs) — so that route was
-- never viable here regardless.
--
-- The actual resolution is structural, not isolation-level: EVERY function in this migration that
-- can insert, update, delete, link, unlink, or otherwise mutate a row that candidate discovery
-- would consider — apply_synced_transaction_batch, apply_transaction_semantic_roles,
-- link_transaction_to_manual_loan, unlink_transaction_from_manual_loan,
-- update_linked_payment_principal, delete_transactions_and_restore_loan_balances, and this
-- function itself — acquires the exact same pg_advisory_xact_lock(hashtext(p_user_id::text)) as
-- its OWN first statement, before touching any row, and holds it (a Postgres guarantee for the
-- xact-scoped variant) until its own transaction commits or rolls back. A Round 9 writer-inventory
-- audit of the whole backend (grepped across services/, controllers/, and scripts/) confirmed this
-- function's advisory lock is the ONLY per-user lock of its kind anywhere in the codebase and that
-- every direct write to the transactions table outside these RPCs (dataService.ts's
-- setTransactionCategory, approveTransaction, backfillCategoryMapping) touches only
-- budget_category_id/needs_review, never amount/date/account_id/role_source/auto_role/
-- role_confidence/classifier_version/user_role_override/manual_loan_id/principal_portion — so none
-- of them can produce or alter a transfer candidate. The one remaining unlocked writer this audit
-- found, deleteManualLoan's direct .update() on linked transactions, was fixed in this same round
-- to route through the already-locked unlink_transaction_from_manual_loan RPC instead.
--
-- Given that inventory, this function's OWN advisory-lock acquisition (its first statement,
-- before its discovery query even runs) is sufficient by itself: any concurrent attempt to insert
-- a new candidate row must first acquire that identical lock, which blocks until this function's
-- transaction ends — before that concurrent writer's INSERT statement can even execute, let alone
-- commit. There is therefore no window, for any in-scope writer, in which a phantom row can be
-- inserted between this function's discovery query and its own commit: the lock this function
-- already holds prevents such a writer from starting, not merely from finishing unnoticed. This is
-- PROVEN for every application writer inventoried above, not merely argued — it is NOT a guarantee
-- against a write issued outside the application (e.g. an ad hoc SQL session connecting directly
-- as a role that bypasses this same advisory-lock convention, or a future function added to this
-- schema without adopting it); that residual is inherent to any advisory-lock-based scheme and
-- would apply equally to a SERIALIZABLE-based design. Every modification to an EXISTING row (the
-- concrete scenario the original review's own example described — "a concurrent request links B to
-- a loan or changes B's amount") was already fully closed in Round 7, because that row IS locked
-- and re-read by this function's own discovery query.
create or replace function public.confirm_transfer_pair(
  p_user_id uuid,
  p_row_a_id uuid,
  p_row_b_id uuid,
  p_role_source_filter text,
  p_window_days integer,
  p_classifier_version smallint
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_a record;
  v_b record;
  v_a_best_id uuid;
  v_a_best_distance integer;
  v_a_tie_count integer;
  v_b_best_id uuid;
  v_b_tie_count integer;
  v_confidence text;
  v_updated_count integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  if p_row_a_id = p_row_b_id then
    raise exception 'confirm_transfer_pair: row_a and row_b must be distinct ids';
  end if;
  if p_window_days is null or p_window_days < 0 then
    raise exception 'confirm_transfer_pair: window_days must be a non-negative integer';
  end if;

  -- Lock and load both candidate rows (and their ownership chain) inside this transaction —
  -- everything from here on sees a consistent, locked view no other writer for this user can
  -- interleave with (thanks to the advisory lock above).
  select t.id, t.account_id, t.amount, t.date, t.role_source, t.user_role_override
  into v_a
  from public.transactions t
  join public.accounts a on a.id = t.account_id
  join public.plaid_items pi on pi.id = a.item_id
  where t.id = p_row_a_id and pi.user_id = p_user_id
  for update of t, a, pi;

  if not found then
    raise exception 'confirm_transfer_pair: row_a not found or not owned by user';
  end if;

  select t.id, t.account_id, t.amount, t.date, t.role_source, t.user_role_override
  into v_b
  from public.transactions t
  join public.accounts a on a.id = t.account_id
  join public.plaid_items pi on pi.id = a.item_id
  where t.id = p_row_b_id and pi.user_id = p_user_id
  for update of t, a, pi;

  if not found then
    raise exception 'confirm_transfer_pair: row_b not found or not owned by user';
  end if;

  if v_a.role_source is distinct from p_role_source_filter or v_b.role_source is distinct from p_role_source_filter then
    raise exception 'confirm_transfer_pair: one or both rows no longer have the expected role_source (concurrent modification)';
  end if;

  if not (v_a.user_role_override is null or v_a.user_role_override = 'internal_transfer') then
    raise exception 'confirm_transfer_pair: row_a is no longer eligible (overridden away from internal_transfer)';
  end if;
  if not (v_b.user_role_override is null or v_b.user_role_override = 'internal_transfer') then
    raise exception 'confirm_transfer_pair: row_b is no longer eligible (overridden away from internal_transfer)';
  end if;

  if v_a.account_id = v_b.account_id then
    raise exception 'confirm_transfer_pair: row_a and row_b are on the same account';
  end if;
  if v_a.amount is distinct from (-v_b.amount) then
    raise exception 'confirm_transfer_pair: row_a and row_b are not exact opposite amounts';
  end if;

  -- Re-run candidate discovery + ranking for row_a from CURRENT locked data — the step that
  -- actually closes the phantom-candidate gap (see this function's own doc comment above). Every
  -- candidate this discovers is itself locked (FOR UPDATE), so it cannot be mutated by a
  -- concurrent writer between this check and our own write below.
  select c.id, c.distance into v_a_best_id, v_a_best_distance
  from (
    select t.id, t.date, abs(t.date - v_a.date) as distance
    from public.transactions t
    join public.accounts a on a.id = t.account_id
    join public.plaid_items pi on pi.id = a.item_id
    where pi.user_id = p_user_id
      and t.id <> v_a.id
      and t.account_id <> v_a.account_id
      and t.amount = -v_a.amount
      and t.role_source = p_role_source_filter
      and (t.user_role_override is null or t.user_role_override = 'internal_transfer')
      and t.date between v_a.date - p_window_days and v_a.date + p_window_days
    for update of t
  ) c
  order by c.distance asc, c.id asc
  limit 1;

  if v_a_best_id is distinct from v_b.id then
    raise exception 'confirm_transfer_pair: row_a''s best current candidate is no longer row_b (a competing candidate exists, or the prior candidate changed/vanished)';
  end if;

  select count(*) into v_a_tie_count
  from (
    select t.id, abs(t.date - v_a.date) as distance
    from public.transactions t
    join public.accounts a on a.id = t.account_id
    join public.plaid_items pi on pi.id = a.item_id
    where pi.user_id = p_user_id
      and t.id <> v_a.id
      and t.account_id <> v_a.account_id
      and t.amount = -v_a.amount
      and t.role_source = p_role_source_filter
      and (t.user_role_override is null or t.user_role_override = 'internal_transfer')
      and t.date between v_a.date - p_window_days and v_a.date + p_window_days
  ) c
  where c.distance = v_a_best_distance;

  if v_a_tie_count > 1 then
    raise exception 'confirm_transfer_pair: row_a''s candidates are now ambiguous (a tie exists at the best distance)';
  end if;

  -- Symmetric re-check from row_b's side — reciprocity, not just a one-sided unique winner, is
  -- what makes a pairing correct (see roleReconciliation.ts's own doc comment for the A/B/C
  -- triangle this guards against).
  select c.id into v_b_best_id
  from (
    select t.id, abs(t.date - v_b.date) as distance
    from public.transactions t
    join public.accounts a on a.id = t.account_id
    join public.plaid_items pi on pi.id = a.item_id
    where pi.user_id = p_user_id
      and t.id <> v_b.id
      and t.account_id <> v_b.account_id
      and t.amount = -v_b.amount
      and t.role_source = p_role_source_filter
      and (t.user_role_override is null or t.user_role_override = 'internal_transfer')
      and t.date between v_b.date - p_window_days and v_b.date + p_window_days
    for update of t
  ) c
  order by c.distance asc, c.id asc
  limit 1;

  if v_b_best_id is distinct from v_a.id then
    raise exception 'confirm_transfer_pair: row_b''s best current candidate is no longer row_a (a competing candidate exists, or the prior candidate changed/vanished)';
  end if;

  select count(*) into v_b_tie_count
  from (
    select t.id, abs(t.date - v_b.date) as distance
    from public.transactions t
    join public.accounts a on a.id = t.account_id
    join public.plaid_items pi on pi.id = a.item_id
    where pi.user_id = p_user_id
      and t.id <> v_b.id
      and t.account_id <> v_b.account_id
      and t.amount = -v_b.amount
      and t.role_source = p_role_source_filter
      and (t.user_role_override is null or t.user_role_override = 'internal_transfer')
      and t.date between v_b.date - p_window_days and v_b.date + p_window_days
  ) c
  where c.distance = abs(v_a.date - v_b.date);

  if v_b_tie_count > 1 then
    raise exception 'confirm_transfer_pair: row_b''s candidates are now ambiguous (a tie exists at the best distance)';
  end if;

  v_confidence := case when v_a.date = v_b.date then 'high' else 'medium' end;

  update public.transactions t
  set auto_role = 'internal_transfer',
      role_source = 'account_pair_match',
      role_confidence = v_confidence,
      classifier_version = p_classifier_version
  where t.id in (v_a.id, v_b.id);

  get diagnostics v_updated_count = row_count;
  if v_updated_count is distinct from 2 then
    raise exception 'confirm_transfer_pair: update count mismatch (expected 2, got %)', v_updated_count;
  end if;
end;
$$;

revoke execute on function public.confirm_transfer_pair(uuid, uuid, uuid, text, integer, smallint) from public;
revoke execute on function public.confirm_transfer_pair(uuid, uuid, uuid, text, integer, smallint) from anon;
revoke execute on function public.confirm_transfer_pair(uuid, uuid, uuid, text, integer, smallint) from authenticated;
grant execute on function public.confirm_transfer_pair(uuid, uuid, uuid, text, integer, smallint) to service_role;

-- Round 7 remediation (blocker 7, completing the enforcement ask): dataService.ts's
-- assertValidManualLoanFields validates current_balance/origination_principal_amount/
-- interest_rate_percentage/minimum_payment_amount/term_months at the application boundary, but
-- the database itself — every manual_loans row's actual, final guarantee, independent of which
-- application code path writes to it — only ever checked loan_type. These five CHECK constraints
-- close that gap.
--
-- Every one is added `NOT VALID`, with a later, separate VALIDATE step (verified on PostgreSQL 17,
-- not assumed). What NOT VALID does and does not do:
--
--  1. `ADD CONSTRAINT ... CHECK (...) NOT VALID` does not scan existing rows when it is added.
--  2. It is enforced immediately for every INSERT, and for every UPDATE of ANY row — PostgreSQL
--     checks the complete resulting row against every CHECK constraint on each UPDATE, whichever
--     columns that UPDATE touches. (An earlier version of this comment said only updates touching
--     the constrained column were checked. That is wrong, and it mattered: it implied a legacy
--     violating row could simply be left for later. In fact such a row becomes un-updatable by
--     every write path the moment the constraint exists — proven on PostgreSQL 17 by a harness
--     test that updates only an unrelated column of a pre-existing violator and is rejected.)
--  3. That is why this migration opens with a dirty-data gate (see the top of this file): it takes
--     the locks, proves no existing row violates any of the nine constraints, and only then
--     installs them, all in one transaction — or aborts with nothing changed. So when this
--     migration has committed, no violating row exists and none can have been written since.
--  4. Marking the constraints validated (`ALTER TABLE ... VALIDATE CONSTRAINT ...`) is still a
--     separate, later, manual step, never run by this migration. Because of the gate it is
--     expected to succeed at any time; it takes only a SHARE UPDATE EXCLUSIVE lock (reads and
--     writes continue) and changes no data. The standalone read-only preflight queries in
--     supabase/preflight/20260912120000_phase_a_numeric_preflight.sql list any row that would
--     block it — or that would make the gate refuse this migration in the first place.
--
-- Round 10 remediation (finiteness): each numeric check below pairs `>= 0` with `< 'Infinity'`
-- rather than testing `>= 0` alone, and the gate and preflight queries are written the same way. An
-- unconstrained PostgreSQL `numeric` accepts 'NaN', 'Infinity' and '-Infinity', and PostgreSQL
-- orders NaN ABOVE every ordinary numeric — so `NaN >= 0` is TRUE and a bare non-negativity check
-- admits both NaN and +Infinity. Verified live before the fix: loans with NaN current_balance,
-- Infinity current_balance, NaN interest_rate_percentage and Infinity minimum_payment_amount all
-- inserted cleanly past the previous constraints, and the previous preflight query reported none of
-- them. `x >= 0 and x < 'Infinity'` rejects NaN (NaN < Infinity is false), rejects +Infinity
-- (Infinity < Infinity is false), rejects -Infinity (fails `>= 0`), and accepts every finite
-- non-negative value including 0. term_months is an integer and so cannot be non-finite.
alter table public.manual_loans
  add constraint manual_loans_current_balance_check
    check (current_balance >= 0 and current_balance < 'Infinity'::numeric) not valid;

alter table public.manual_loans
  add constraint manual_loans_origination_principal_amount_check
    check (origination_principal_amount is null
           or (origination_principal_amount >= 0 and origination_principal_amount < 'Infinity'::numeric)) not valid;

alter table public.manual_loans
  add constraint manual_loans_interest_rate_percentage_check
    check (interest_rate_percentage is null
           or (interest_rate_percentage >= 0 and interest_rate_percentage < 'Infinity'::numeric)) not valid;

alter table public.manual_loans
  add constraint manual_loans_minimum_payment_amount_check
    check (minimum_payment_amount is null
           or (minimum_payment_amount >= 0 and minimum_payment_amount < 'Infinity'::numeric)) not valid;

alter table public.manual_loans
  add constraint manual_loans_term_months_check
    check (term_months is null or term_months > 0) not valid;

-- The same hazard applies to the two per-transaction/per-payment numeric columns this feature
-- writes. transactions.amount is numeric(12,2), whose typmod rejects Infinity outright but still
-- accepts NaN; principal_portion and the manual-payment portions are unconstrained numeric and
-- accept all three non-finite values. Both are added NOT VALID for the same reasons, and are covered
-- by the same dirty-data gate and standalone preflight queries.
--
-- transactions.amount is deliberately only required to be FINITE, never non-negative: income and
-- refunds are negative in Plaid's sign convention (money out is positive), so a non-negativity check
-- there would be wrong.
alter table public.transactions
  add constraint transactions_amount_finite_check
    check (amount > -'Infinity'::numeric and amount < 'Infinity'::numeric) not valid;

alter table public.transactions
  add constraint transactions_principal_portion_check
    check (principal_portion is null
           or (principal_portion >= 0 and principal_portion < 'Infinity'::numeric)) not valid;

alter table public.manual_loan_payments
  add constraint manual_loan_payments_principal_portion_check
    check (principal_portion >= 0 and principal_portion < 'Infinity'::numeric) not valid;

alter table public.manual_loan_payments
  add constraint manual_loan_payments_interest_portion_check
    check (interest_portion >= 0 and interest_portion < 'Infinity'::numeric) not valid;

-- Round 8 remediation (blocker 3, closing the candidate-insertion phantom): confirm_transfer_pair
-- (Round 7) re-discovers candidates from inside its own locked transaction, but that protection
-- only holds if EVERY writer that can create or change a transfer candidate — not just the
-- functions in this migration — takes the SAME per-user advisory lock before mutating. Until now,
-- the one writer that did NOT was the Plaid-sync ingestion path itself: dataService.ts's
-- applyTransactionChanges issued plain, unlocked INSERT/UPDATE statements for newly-synced
-- transactions. A row inserted that way could become durable at ANY moment — including exactly
-- inside another locked function's own discovery-to-commit window — without ever contending for
-- the lock that's supposed to serialize every candidate-affecting writer for that user.
--
-- apply_synced_transaction_batch closes this by being the ONLY way applyTransactionChanges (see
-- its Round 8 rewrite) ever writes to `transactions`: it takes the per-user advisory lock FIRST,
-- verifies ownership of every account/transaction referenced, and only then performs the insert
-- and update. Classification itself (which role a row gets) still happens in TypeScript — this
-- function is a mechanical bulk write of already-decided rows, not a port of the classifier —
-- keeping the well-tested classifyRowLevel precedence logic exactly where it is; only the ACT of
-- persisting the result moves inside the lock.
--
-- Verified against a disposable PostgreSQL instance with the real two-process scenario this
-- exists to prevent: a session holding this function's lock (simulating an in-flight sync
-- inserting a new transaction) blocks a concurrent confirm_transfer_pair call for the same user;
-- once the sync commits and the lock releases, confirm_transfer_pair's own re-discovery correctly
-- sees the newly-synced row as a competing candidate and rejects the now-ambiguous pairing rather
-- than committing a decision made before that row existed. See this round's remediation report
-- for the exact transcript.
--
-- p_inserts / p_updates: JSONB arrays of complete row objects — see dataService.ts's
-- applyTransactionChanges for the exact shape each array element carries. auto_role/role_source/
-- role_confidence/classifier_version in an UPDATE element may be JSON null, meaning "this row's
-- semantic inputs didn't change, leave its role fields alone" (COALESCEd against the current
-- value) — mirroring the Phase A contract that an ordinary resync with unchanged semantic inputs
-- must not churn role fields at all.
create or replace function public.apply_synced_transaction_batch(
  p_user_id uuid,
  p_inserts jsonb,
  p_updates jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_insert_count integer;
  v_update_count integer;
  v_distinct_count integer;
  v_owned_count integer;
  v_affected_count integer;
  v_stale_count integer;
  v_dest_accounts uuid[];
  v_dest_categories uuid[];
  v_inserted jsonb;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  v_insert_count := coalesce(jsonb_array_length(p_inserts), 0);
  v_update_count := coalesce(jsonb_array_length(p_updates), 0);

  -- Reject duplicate plaid_transaction_ids outright (Round 9 remediation) — the table's own
  -- UNIQUE constraint would eventually catch a genuine collision at INSERT time anyway, but
  -- checking here fails fast with a clear message before locking or touching anything, exactly
  -- mirroring apply_transaction_semantic_roles's own duplicate-id rejection.
  if v_insert_count > 0 then
    select count(distinct x.plaid_transaction_id) into v_distinct_count
    from jsonb_to_recordset(p_inserts) as x(plaid_transaction_id text);
    if v_distinct_count is distinct from v_insert_count then
      raise exception 'apply_synced_transaction_batch: duplicate plaid_transaction_id supplied in p_inserts (% distinct of %)',
        v_distinct_count, v_insert_count;
    end if;
  end if;

  -- Reject duplicate update ids outright (Round 9 remediation, found via adversarial testing): an
  -- earlier version of this function computed `v_distinct_count` for the ownership check below
  -- but never compared it against `v_update_count` itself, so two objects in p_updates sharing
  -- the same `id` (different field values) passed ownership verification silently — the
  -- OWNED,DISTINCT count still matched. The actual `UPDATE ... FROM` statement further down would
  -- then have matched the same target row against BOTH source rows, and which one's values
  -- "won" is unspecified per Postgres's own multiple-match UPDATE...FROM behavior — confirmed
  -- live: it is not a documented, reliable choice. Rejecting the duplicate before anything is
  -- locked or written removes the ambiguity entirely rather than leaving it to be resolved by
  -- unspecified engine behavior.
  if v_update_count > 0 then
    select count(distinct x.id) into v_distinct_count
    from jsonb_to_recordset(p_updates) as x(id uuid);
    if v_distinct_count is distinct from v_update_count then
      raise exception 'apply_synced_transaction_batch: duplicate id supplied in p_updates (% distinct of %)',
        v_distinct_count, v_update_count;
    end if;
  end if;

  -- Verify ownership of every DESTINATION account BEFORE writing anything — for updates as well as
  -- inserts (Round 10 remediation). An earlier version validated only the CURRENT owner of each
  -- target transaction, never the replacement `account_id` the update supplies, so an update that
  -- named a legitimately-owned transaction could move it into ANOTHER user's account: the
  -- current-owner check passed, then the UPDATE happily wrote the foreign account_id. Confirmed
  -- live before the fix. Both accounts and plaid_items rows are locked (not just transactions), so
  -- the ownership chain proven here cannot be re-parented by a concurrent writer before we commit.
  -- The destination set is materialized into an array first because FOR UPDATE may not be combined
  -- with UNION at the same query level.
  if v_insert_count > 0 or v_update_count > 0 then
    select array_agg(distinct d.aid) into v_dest_accounts
    from (
      select x.account_id as aid from jsonb_to_recordset(coalesce(p_inserts, '[]'::jsonb)) as x(account_id uuid)
      union all
      select x.account_id from jsonb_to_recordset(coalesce(p_updates, '[]'::jsonb)) as x(account_id uuid)
    ) d;

    select count(*) into v_owned_count
    from (
      select a.id
      from unnest(v_dest_accounts) as u(aid)
      join public.accounts a on a.id = u.aid
      join public.plaid_items pi on pi.id = a.item_id
      where pi.user_id = p_user_id
      for update of a, pi
    ) locked;

    -- A null account_id survives into the array and can never join, so this also rejects it.
    if v_owned_count is distinct from cardinality(v_dest_accounts) then
      raise exception 'apply_synced_transaction_batch: one or more rows reference an account not owned by this user';
    end if;
  end if;

  -- budget_category_id is the other user-owned foreign reference this RPC accepts. Only the insert
  -- branch can set it (the UPDATE below deliberately never touches budget_category_id, so a resync
  -- cannot un-categorize an already-categorized row), so only inserts need validating.
  if v_insert_count > 0 then
    select array_agg(distinct x.budget_category_id) into v_dest_categories
    from jsonb_to_recordset(p_inserts) as x(budget_category_id uuid)
    where x.budget_category_id is not null;

    if v_dest_categories is not null then
      select count(*) into v_owned_count
      from (
        select bc.id
        from unnest(v_dest_categories) as u(bcid)
        join public.budget_categories bc on bc.id = u.bcid
        where bc.user_id = p_user_id
        for update of bc
      ) locked;

      if v_owned_count is distinct from cardinality(v_dest_categories) then
        raise exception 'apply_synced_transaction_batch: one or more insert rows reference a budget category not owned by this user';
      end if;
    end if;
  end if;

  -- Verify ownership of (and lock) every transaction referenced by an update row BEFORE updating
  -- anything. The locking SELECT carries no aggregate (Postgres forbids that combination — see
  -- apply_transaction_semantic_roles's own doc comment for the same fix), so counting happens in
  -- an outer, unlocked query over the already-locked set. Duplicates were already rejected above,
  -- so `v_distinct_count` here is exactly `v_update_count`.
  if v_update_count > 0 then
    select count(*) into v_owned_count
    from (
      select t.id
      from (select distinct x.id from jsonb_to_recordset(p_updates) as x(id uuid)) d
      join public.transactions t on t.id = d.id
      join public.accounts a on a.id = t.account_id
      join public.plaid_items pi on pi.id = a.item_id
      where pi.user_id = p_user_id
      for update of t
    ) locked;

    if v_owned_count is distinct from v_update_count then
      raise exception 'apply_synced_transaction_batch: one or more update rows reference a transaction not owned by this user';
    end if;

    -- Compare-and-swap against the snapshot the CALLER classified from (Round 10 remediation).
    -- applyTransactionChanges reads each existing row, decides in TypeScript whether to reclassify
    -- it and whether its stored principal_portion is still compatible with the incoming amount, and
    -- only THEN calls this function — so the advisory lock, acquired here, serializes the WRITES
    -- but does nothing about that earlier unlocked READ. The concrete corruption that allowed:
    -- sync reads T as unlinked/amount 100; a concurrent request links T to a loan with
    -- principal_portion 80 and commits; this batch then writes amount 20 plus non-loan role fields
    -- (both decisions having been made against the now-stale "unlinked" snapshot), leaving T linked
    -- with principal 80 > amount 20 and a role that contradicts its own loan link.
    --
    -- Every field the caller's decision actually read is echoed back as exp_* and re-checked here
    -- against the CURRENT locked row, so a batch built on any stale premise is rejected whole. The
    -- caller gets a hard error, the sync cursor is left unadvanced, and the retry re-reads fresh
    -- state — the same fail-closed contract the pre-existing linked-payment integrity check uses.
    select count(*) into v_stale_count
    from jsonb_to_recordset(p_updates) as x(
      id uuid, exp_account_id uuid, exp_amount numeric, exp_date date, exp_name text,
      exp_merchant_name text, exp_category text, exp_pfc_detailed text, exp_pfc_confidence text,
      exp_manual_loan_id uuid, exp_auto_role text, exp_principal_portion numeric
    )
    join public.transactions t on t.id = x.id
    where t.account_id is distinct from x.exp_account_id
       or t.amount is distinct from x.exp_amount
       or t.date is distinct from x.exp_date
       or t.name is distinct from x.exp_name
       or t.merchant_name is distinct from x.exp_merchant_name
       or t.category is distinct from x.exp_category
       or t.personal_finance_category_detailed is distinct from x.exp_pfc_detailed
       or t.personal_finance_category_confidence is distinct from x.exp_pfc_confidence
       or t.manual_loan_id is distinct from x.exp_manual_loan_id
       or t.auto_role is distinct from x.exp_auto_role
       or t.principal_portion is distinct from x.exp_principal_portion;

    if v_stale_count > 0 then
      raise exception 'apply_synced_transaction_batch: % update row(s) no longer match the state they were classified against (concurrent modification) — re-read and retry', v_stale_count;
    end if;

    -- Independent of the CAS above, re-assert the linked-payment invariant from CURRENT locked
    -- state: a row that is linked to a manual loan must keep principal_portion <= amount, and its
    -- amount must be a finite, positive number. NaN is deliberately excluded via `< 'Infinity'`
    -- rather than a `<= 0` test, because Postgres orders NaN ABOVE every ordinary numeric, so
    -- `NaN <= 0` is false and a naive comparison would let NaN straight through.
    select count(*) into v_stale_count
    from jsonb_to_recordset(p_updates) as x(id uuid, amount numeric)
    join public.transactions t on t.id = x.id
    where t.manual_loan_id is not null
      and (
        x.amount is null
        or not (x.amount > 0 and x.amount < 'Infinity'::numeric)
        or coalesce(t.principal_portion, 0) > x.amount
      );

    if v_stale_count > 0 then
      raise exception 'apply_synced_transaction_batch: % update row(s) would leave a manual-loan-linked transaction with a non-finite/non-positive amount or principal_portion greater than amount', v_stale_count;
    end if;
  end if;

  if v_insert_count > 0 then
    with ins as (
      insert into public.transactions (
        plaid_transaction_id, account_id, amount, iso_currency_code, date, name, merchant_name,
        category, personal_finance_category_detailed, personal_finance_category_confidence,
        plaid_category, pending, needs_review, budget_category_id, auto_role, role_source,
        role_confidence, classifier_version
      )
      select
        x.plaid_transaction_id, x.account_id, x.amount, x.iso_currency_code, x.date, x.name,
        x.merchant_name, x.category, x.personal_finance_category_detailed,
        x.personal_finance_category_confidence, x.plaid_category, x.pending, x.needs_review,
        x.budget_category_id, x.auto_role, x.role_source, x.role_confidence, x.classifier_version
      from jsonb_to_recordset(p_inserts) as x(
        plaid_transaction_id text, account_id uuid, amount numeric, iso_currency_code text,
        date date, name text, merchant_name text, category text,
        personal_finance_category_detailed text, personal_finance_category_confidence text,
        plaid_category text, pending boolean, needs_review boolean, budget_category_id uuid,
        auto_role text, role_source text, role_confidence text, classifier_version smallint
      )
      returning id, name, merchant_name, amount
    )
    -- Both the payload AND the row count come from the same aggregate over `ins` (Round 10
    -- remediation). GET DIAGNOSTICS ROW_COUNT must NOT be used here: it reports the row count of
    -- the statement just executed, which is this OUTER aggregate SELECT — always exactly 1 row,
    -- whatever `ins` inserted. That made every batch of two or more inserts raise a bogus "insert
    -- count mismatch" and roll back the whole sync; caught live, since the earlier round's tests
    -- only ever exercised single-row insert batches.
    select
      jsonb_agg(jsonb_build_object('id', id, 'name', name, 'merchant_name', merchant_name, 'amount', amount)),
      count(*)
    into v_inserted, v_affected_count
    from ins;

    if v_affected_count is distinct from v_insert_count then
      raise exception 'apply_synced_transaction_batch: insert count mismatch (expected %, got %)', v_insert_count, v_affected_count;
    end if;
  end if;

  if v_update_count > 0 then
    update public.transactions t
    set account_id = x.account_id,
        amount = x.amount,
        iso_currency_code = x.iso_currency_code,
        date = x.date,
        name = x.name,
        merchant_name = x.merchant_name,
        category = x.category,
        personal_finance_category_detailed = x.personal_finance_category_detailed,
        personal_finance_category_confidence = x.personal_finance_category_confidence,
        plaid_category = x.plaid_category,
        pending = x.pending,
        auto_role = coalesce(x.auto_role, t.auto_role),
        role_source = coalesce(x.role_source, t.role_source),
        role_confidence = coalesce(x.role_confidence, t.role_confidence),
        classifier_version = coalesce(x.classifier_version, t.classifier_version)
    from jsonb_to_recordset(p_updates) as x(
      id uuid, account_id uuid, amount numeric, iso_currency_code text, date date, name text,
      merchant_name text, category text, personal_finance_category_detailed text,
      personal_finance_category_confidence text, plaid_category text, pending boolean,
      auto_role text, role_source text, role_confidence text, classifier_version smallint
    )
    where t.id = x.id;

    get diagnostics v_affected_count = row_count;
    if v_affected_count is distinct from v_update_count then
      raise exception 'apply_synced_transaction_batch: update count mismatch (expected %, got %)', v_update_count, v_affected_count;
    end if;
  end if;

  return coalesce(v_inserted, '[]'::jsonb);
end;
$$;

revoke execute on function public.apply_synced_transaction_batch(uuid, jsonb, jsonb) from public;
revoke execute on function public.apply_synced_transaction_batch(uuid, jsonb, jsonb) from anon;
revoke execute on function public.apply_synced_transaction_batch(uuid, jsonb, jsonb) from authenticated;
grant execute on function public.apply_synced_transaction_batch(uuid, jsonb, jsonb) to service_role;

-- Round 8 remediation (createManualLoan retry-duplication, replacing the Round 7 time-window
-- heuristic): a genuine client-supplied idempotency key, backed by a real database uniqueness
-- guarantee and a replay-safe response — the exact "prove it, don't approximate it" fix the
-- earlier exact-field/30-second-window heuristic could not provide (it could neither survive a
-- delayed retry past its window, nor tell a genuine duplicate loan apart from a retry that
-- happened to reuse identical values). One row per (user, idempotency_key) the caller has ever
-- used for a loan creation; `loan_id` is what a replayed request re-fetches and returns.
--
-- Round 9 remediation (idempotency-key audit): `request_fingerprint` closes a gap the original
-- design left open — reusing the same key with a genuinely DIFFERENT payload (a client bug, or a
-- key collision) previously replayed the FIRST payload's loan silently, discarding whatever the
-- second, different request actually asked for with no error at all. A deterministic fingerprint
-- of every field the caller supplied is stored alongside the key; a replay must match it exactly,
-- or the call fails loudly (see create_manual_loan_idempotent below) rather than silently
-- returning a loan that doesn't reflect what was just asked for.
-- Round 10 remediation: `loan_id` was `not null ... on delete cascade`, which meant deleting a loan
-- also deleted the record that its idempotency key had ever been used — so a delayed retry of the
-- original creation (the exact case this table exists for) found no record, created a SECOND loan,
-- and silently resurrected deleted data. The reference is now nullable and ON DELETE SET NULL, so
-- the row survives as an immutable tombstone of the key: `loan_id is null` means "this key was
-- used, and the loan it produced has since been deleted," which create_manual_loan_idempotent
-- reports as a deterministic error rather than creating a replacement loan.
create table public.manual_loan_creation_requests (
  user_id uuid not null,
  idempotency_key text not null,
  loan_id uuid null references public.manual_loans(id) on delete set null,
  request_fingerprint text not null,
  created_at timestamp with time zone not null default now(),
  primary key (user_id, idempotency_key)
);

alter table public.manual_loan_creation_requests enable row level security;

-- Round 9 remediation: this table is new (unlike manual_loans/manual_loan_payments, which predate
-- this migration and already carry whatever table-level grants the base schema set up for them),
-- and RLS-enabled-with-no-policies only blocks row access for roles WITHOUT bypassrls — it does
-- nothing about the separate, more basic table-level GRANT system. Without an explicit grant here,
-- create_manual_loan_idempotent (security invoker, run as service_role) gets a bare "permission
-- denied for table manual_loan_creation_requests" the moment it touches this table — caught live
-- against a disposable Postgres instance, not by static review. No UPDATE/DELETE grant is given
-- because the function only ever SELECTs and INSERTs into this table.
-- Round 16 remediation: service_role is revoked too, BEFORE the narrow grant. This project's
-- default privileges (supabase/migrations/20260825195130_remote_schema.sql, pulled from the live
-- database) give anon, authenticated AND service_role every table privilege on each new table in
-- public, so a bare `grant select, insert` added to them rather than replacing them — verified on
-- Supabase's own PostgreSQL 17, where service_role held DELETE/UPDATE/TRUNCATE/... here.
revoke all on public.manual_loan_creation_requests from public;
revoke all on public.manual_loan_creation_requests from anon;
revoke all on public.manual_loan_creation_requests from authenticated;
revoke all on public.manual_loan_creation_requests from service_role;
grant select, insert on public.manual_loan_creation_requests to service_role;

-- Atomically replays an existing loan for a (user, idempotency_key) pair already seen — but ONLY
-- if the payload matches what was originally stored for that key — or creates a new one and
-- records the key + a fingerprint of its payload. The whole check-then-act sequence happens
-- inside one locked transaction, so two concurrent requests carrying the SAME key can never both
-- pass the "does this key exist yet" check and both insert: the per-(user,key) advisory lock (a
-- finer grain than the per-user lock used elsewhere in this migration, since loan creation never
-- touches `transactions` and so has no need to contend with those writers) serializes them, and
-- the second one simply reads back what the first one already committed. A genuinely different
-- key always creates a genuinely new loan, however similar its fields are to an existing one —
-- key REUSE is what this function keys off of, never field-value similarity.
create or replace function public.create_manual_loan_idempotent(
  p_user_id uuid,
  p_idempotency_key text,
  p_name text,
  p_loan_type text,
  p_current_balance numeric,
  p_origination_principal_amount numeric,
  p_interest_rate_percentage numeric,
  p_origination_date date,
  p_term_months integer,
  p_minimum_payment_amount numeric,
  p_next_payment_due_date date,
  p_notes text,
  p_match_text text
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_existing_loan_id uuid;
  v_existing_fingerprint text;
  v_key_already_used boolean;
  v_fingerprint text;
  v_new_loan_id uuid;
begin
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) = 0 then
    raise exception 'create_manual_loan_idempotent: idempotency_key is required';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text || ':' || p_idempotency_key));

  -- Round 10 remediation: the fingerprint was previously an md5 over the fields concatenated with
  -- E'\x01' separators and an E'\x02' null marker. Those are ordinary characters that PostgreSQL
  -- text can contain, so the field boundaries were forgeable and genuinely different payloads
  -- collided — verified live: notes='alpha\x01beta', match_text='gamma' produced the identical
  -- fingerprint to notes='alpha', match_text='beta\x01gamma', and the second, different request
  -- silently replayed the first one's loan. Building a jsonb object instead removes the ambiguity
  -- at the source: jsonb escapes control characters in its text output, orders its keys
  -- deterministically, and represents SQL NULL as a json null that no string value can imitate. The
  -- hash is sha256 rather than md5, and both sha256() and convert_to() are pg_catalog builtins, so
  -- this needs no extension and stays correct under `search_path = ''`.
  v_fingerprint := encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        jsonb_build_object(
          'name', p_name,
          'loan_type', p_loan_type,
          'current_balance', p_current_balance,
          'origination_principal_amount', p_origination_principal_amount,
          'interest_rate_percentage', p_interest_rate_percentage,
          'origination_date', p_origination_date,
          'term_months', p_term_months,
          'minimum_payment_amount', p_minimum_payment_amount,
          'next_payment_due_date', p_next_payment_due_date,
          'notes', p_notes,
          'match_text', p_match_text
        )::text,
        'UTF8'
      )
    ),
    'hex'
  );

  select loan_id, request_fingerprint, true
  into v_existing_loan_id, v_existing_fingerprint, v_key_already_used
  from public.manual_loan_creation_requests
  where user_id = p_user_id and idempotency_key = p_idempotency_key;

  -- NB: test the KEY's existence, not `loan_id is not null` — after the loan has been deleted the
  -- tombstone row survives with a null loan_id, and treating that as "key unused" is exactly the
  -- duplicate-creating bug the ON DELETE SET NULL change above exists to prevent.
  if coalesce(v_key_already_used, false) then
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception 'create_manual_loan_idempotent: idempotency_key % was already used for a different request payload', p_idempotency_key;
    end if;
    if v_existing_loan_id is null then
      raise exception 'create_manual_loan_idempotent: idempotency_key % was already used and the loan it created has since been deleted', p_idempotency_key;
    end if;
    return v_existing_loan_id;
  end if;

  insert into public.manual_loans (
    user_id, name, loan_type, current_balance, origination_principal_amount,
    interest_rate_percentage, origination_date, term_months, minimum_payment_amount,
    next_payment_due_date, notes, match_text
  ) values (
    p_user_id, p_name, p_loan_type, p_current_balance, p_origination_principal_amount,
    p_interest_rate_percentage, p_origination_date, p_term_months, p_minimum_payment_amount,
    p_next_payment_due_date, p_notes, p_match_text
  )
  returning id into v_new_loan_id;

  insert into public.manual_loan_creation_requests (user_id, idempotency_key, loan_id, request_fingerprint)
  values (p_user_id, p_idempotency_key, v_new_loan_id, v_fingerprint);

  return v_new_loan_id;
end;
$$;

revoke execute on function public.create_manual_loan_idempotent(uuid, text, text, text, numeric, numeric, numeric, date, integer, numeric, date, text, text) from public;
revoke execute on function public.create_manual_loan_idempotent(uuid, text, text, text, numeric, numeric, numeric, date, integer, numeric, date, text, text) from anon;
revoke execute on function public.create_manual_loan_idempotent(uuid, text, text, text, numeric, numeric, numeric, date, integer, numeric, date, text, text) from authenticated;
grant execute on function public.create_manual_loan_idempotent(uuid, text, text, text, numeric, numeric, numeric, date, integer, numeric, date, text, text) to service_role;

-- Round 10 remediation (manual-loan deletion atomicity): deletion used to be a read of the linked
-- transactions, then ONE SEPARATE unlink RPC PER ROW, then a separate direct DELETE of the loan —
-- three or more independent transactions with no shared lock. Four concrete failures followed from
-- that, all of them reachable:
--
--   1. A transaction linked AFTER the initial linked-row read but BEFORE the loan delete had its
--      manual_loan_id cleared by the FK's ON DELETE SET NULL, but kept a stale principal_portion
--      and a stale `manual_loan_link` role — a row claiming to be a payment on a deleted loan.
--   2. One unlink committing and a later one failing left the deletion half-done, with no record
--      of what still needed finishing.
--   3. Every unlink committing but the loan DELETE failing left the loan present with all its
--      payments detached, and a retry then saw no linked rows at all — the affected transaction
--      ids, which still needed relational reconciliation, were simply lost.
--   4. Reconciliation failing after a committed deletion could not be retried through the endpoint
--      at all, because the loan was already gone and the request reported it as missing.
--
-- This function replaces all of it with a single transaction: it takes the same per-user advisory
-- lock every other candidate-affecting writer takes, locks the loan and the COMPLETE linked set,
-- verifies that set still matches exactly what the caller classified against, reclassifies every
-- row, records a durable tombstone, and deletes the loan — atomically. Because the tombstone
-- carries the affected transaction ids and survives the loan, a retry after a post-commit
-- reconciliation failure replays them instead of reporting the loan as missing (failure 4), and no
-- partial state is reachable (failures 1-3).
--
-- Classification itself deliberately stays in TypeScript (transactionClassifier.ts is the single
-- source of truth for it, and porting it into SQL would fork that logic). The caller reads the
-- linked rows, classifies them, and passes the result in as p_reclassify — together with the
-- classifier inputs it observed for each row (exp_amount, exp_category, exp_pfc_detailed,
-- exp_pfc_confidence). This function then proves under the lock that the linked set it is about to
-- act on is EXACTLY the set the caller classified, AND that every row's classifier inputs are
-- unchanged — so a concurrent link, unlink or resync arriving in between is detected and the whole
-- call is rejected for the caller to retry with fresh state, rather than silently persisting a
-- role computed from superseded data.
create table public.manual_loan_deletions (
  user_id uuid not null,
  loan_id uuid not null,
  affected_transaction_ids uuid[] not null,
  reconciled_at timestamp with time zone null,
  created_at timestamp with time zone not null default now(),
  primary key (user_id, loan_id)
);

alter table public.manual_loan_deletions enable row level security;

-- Same explicit-grant reasoning as manual_loan_creation_requests above: a table created by this
-- migration carries no grants of its own, and RLS-with-no-policies does not substitute for them.
-- UPDATE is granted here (unlike that table) solely so a completed reconciliation can be marked.
-- Revoked from service_role before the narrow grant for the same default-privileges reason as
-- manual_loan_creation_requests above (Round 16 remediation).
revoke all on public.manual_loan_deletions from public;
revoke all on public.manual_loan_deletions from anon;
revoke all on public.manual_loan_deletions from authenticated;
revoke all on public.manual_loan_deletions from service_role;
grant select, insert, update on public.manual_loan_deletions to service_role;

create or replace function public.delete_manual_loan_atomic(
  p_user_id uuid,
  p_loan_id uuid,
  p_reclassify jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_reclassify_count integer;
  v_distinct_count integer;
  v_linked_ids uuid[];
  v_reclassify_ids uuid[];
  v_existing_ids uuid[];
  v_existing_reconciled timestamp with time zone;
  v_tombstone_found boolean;
  v_loan_found boolean;
  v_affected_count integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  -- Replay path: this (user, loan) was already deleted by an earlier call that committed. Return
  -- the recorded affected ids so the caller can re-run the reconciliation that failed after that
  -- commit, instead of reporting a loan that no longer exists as simply missing.
  select affected_transaction_ids, reconciled_at, true
  into v_existing_ids, v_existing_reconciled, v_tombstone_found
  from public.manual_loan_deletions
  where user_id = p_user_id and loan_id = p_loan_id;

  if coalesce(v_tombstone_found, false) then
    return jsonb_build_object(
      'replayed', true,
      'already_reconciled', v_existing_reconciled is not null,
      'affected_transaction_ids', to_jsonb(v_existing_ids)
    );
  end if;

  select true into v_loan_found
  from public.manual_loans l
  where l.id = p_loan_id and l.user_id = p_user_id
  for update;

  if not coalesce(v_loan_found, false) then
    raise exception 'delete_manual_loan_atomic: manual loan not found or not owned by user';
  end if;

  v_reclassify_count := coalesce(jsonb_array_length(p_reclassify), 0);

  select count(distinct r.id) into v_distinct_count
  from jsonb_to_recordset(coalesce(p_reclassify, '[]'::jsonb)) as r(id uuid);

  if v_distinct_count is distinct from v_reclassify_count then
    raise exception 'delete_manual_loan_atomic: duplicate id supplied in p_reclassify (% distinct of %)',
      v_distinct_count, v_reclassify_count;
  end if;

  -- Lock the COMPLETE current linked set AND its ownership chain. Round 11 remediation: this used to
  -- lock only `t`, so a concurrent re-parenting of the account or plaid item (the rows the
  -- `pi.user_id = p_user_id` test actually depends on) was neither waited for nor re-checked — the
  -- statement just read the pre-change snapshot and went ahead. Locking `a` and `pi` as well makes
  -- this wait for any such writer and then re-evaluate the ownership predicate against the
  -- committed row, so a row whose chain no longer leads to this user drops out of the set (and the
  -- set comparison below then rejects the call). The aggregate sits outside the locking select
  -- because PostgreSQL forbids FOR UPDATE alongside an aggregate.
  select array_agg(locked.id order by locked.id) into v_linked_ids
  from (
    select t.id
    from public.transactions t
    join public.accounts a on a.id = t.account_id
    join public.plaid_items pi on pi.id = a.item_id
    where t.manual_loan_id = p_loan_id and pi.user_id = p_user_id
    for update of t, a, pi
  ) locked;

  -- Round 11 remediation: ORDER BY is explicit. The comparison below is positional (array
  -- equality), and PostgreSQL does not guarantee aggregate output order without ORDER BY — the
  -- earlier version relied on DISTINCT happening to sort, which is an implementation detail.
  select array_agg(distinct r.id order by r.id) into v_reclassify_ids
  from jsonb_to_recordset(coalesce(p_reclassify, '[]'::jsonb)) as r(id uuid);

  -- Both arrays are now explicitly ascending, so this is a true set comparison. A concurrent link
  -- or unlink landing between the caller's read and this lock changes the set and is rejected here.
  if coalesce(v_linked_ids, '{}'::uuid[]) is distinct from coalesce(v_reclassify_ids, '{}'::uuid[]) then
    raise exception 'delete_manual_loan_atomic: the set of transactions linked to this loan changed since they were classified (concurrent modification) — re-read and retry';
  end if;

  -- Round 11 remediation: the id set alone is not enough. The caller's role decision for each row
  -- depends on that row's amount, primary category, detailed category and category confidence
  -- (transactionClassifier.ts's full input once manual_loan_id is cleared), all read OUTSIDE this
  -- lock. A concurrent sync can change any of them while leaving the row linked — e.g. Plaid
  -- re-categorizing an ordinary purchase as LOAN_PAYMENTS — and the id-only check then accepted and
  -- persisted a role computed from the superseded inputs. Every classifier input the caller saw is
  -- now echoed back as exp_* and compared against the locked row; any mismatch (including a
  -- missing exp_* field, which compares as null) rejects the whole call so the caller re-reads and
  -- reclassifies. The message deliberately shares the "changed since they were classified" phrase
  -- with the set check above, because the caller's correct response to both is the same retry.
  select count(*) into v_affected_count
  from jsonb_to_recordset(p_reclassify) as r(
    id uuid, exp_amount numeric, exp_category text, exp_pfc_detailed text, exp_pfc_confidence text
  )
  join public.transactions t on t.id = r.id
  where t.amount is distinct from r.exp_amount
     or t.category is distinct from r.exp_category
     or t.personal_finance_category_detailed is distinct from r.exp_pfc_detailed
     or t.personal_finance_category_confidence is distinct from r.exp_pfc_confidence;

  if v_affected_count > 0 then
    raise exception 'delete_manual_loan_atomic: % linked transaction(s) changed since they were classified (classifier inputs differ; concurrent modification) — re-read and retry', v_affected_count;
  end if;

  if coalesce(cardinality(v_linked_ids), 0) > 0 then
    update public.transactions t
    set manual_loan_id = null,
        principal_portion = null,
        auto_role = r.auto_role,
        role_source = r.role_source,
        role_confidence = r.role_confidence,
        classifier_version = r.classifier_version
    from jsonb_to_recordset(p_reclassify) as r(
      id uuid, auto_role text, role_source text, role_confidence text, classifier_version smallint
    )
    where t.id = r.id;

    get diagnostics v_affected_count = row_count;
    if v_affected_count is distinct from cardinality(v_linked_ids) then
      raise exception 'delete_manual_loan_atomic: reclassified row count mismatch (expected %, got %)',
        cardinality(v_linked_ids), v_affected_count;
    end if;
  end if;

  insert into public.manual_loan_deletions (user_id, loan_id, affected_transaction_ids)
  values (p_user_id, p_loan_id, coalesce(v_linked_ids, '{}'::uuid[]));

  delete from public.manual_loans where id = p_loan_id and user_id = p_user_id;

  get diagnostics v_affected_count = row_count;
  if v_affected_count is distinct from 1 then
    raise exception 'delete_manual_loan_atomic: expected to delete exactly 1 loan, deleted %', v_affected_count;
  end if;

  return jsonb_build_object(
    'replayed', false,
    'already_reconciled', false,
    'affected_transaction_ids', to_jsonb(coalesce(v_linked_ids, '{}'::uuid[]))
  );
end;
$$;

revoke execute on function public.delete_manual_loan_atomic(uuid, uuid, jsonb) from public;
revoke execute on function public.delete_manual_loan_atomic(uuid, uuid, jsonb) from anon;
revoke execute on function public.delete_manual_loan_atomic(uuid, uuid, jsonb) from authenticated;
grant execute on function public.delete_manual_loan_atomic(uuid, uuid, jsonb) to service_role;

-- Marks a committed deletion's post-commit reconciliation as finished. Kept separate from
-- delete_manual_loan_atomic on purpose: reconciliation runs in the application, AFTER that
-- function's transaction has committed, so until it succeeds the tombstone must stay unmarked and
-- keep driving retries.
create or replace function public.mark_manual_loan_deletion_reconciled(
  p_user_id uuid,
  p_loan_id uuid
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_affected_count integer;
begin
  update public.manual_loan_deletions
  set reconciled_at = now()
  where user_id = p_user_id and loan_id = p_loan_id;

  get diagnostics v_affected_count = row_count;
  if v_affected_count is distinct from 1 then
    raise exception 'mark_manual_loan_deletion_reconciled: no deletion record for this user/loan';
  end if;
end;
$$;

revoke execute on function public.mark_manual_loan_deletion_reconciled(uuid, uuid) from public;
revoke execute on function public.mark_manual_loan_deletion_reconciled(uuid, uuid) from anon;
revoke execute on function public.mark_manual_loan_deletion_reconciled(uuid, uuid) from authenticated;
grant execute on function public.mark_manual_loan_deletion_reconciled(uuid, uuid) to service_role;
