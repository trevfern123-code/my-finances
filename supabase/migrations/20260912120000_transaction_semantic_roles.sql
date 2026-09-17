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

  if p_principal_portion is null or p_principal_portion < 0 or p_principal_portion > v_amount then
    raise exception 'link_transaction_to_manual_loan: principal_portion (%) must be between 0 and the transaction amount (%)',
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

  if p_new_principal_portion is null or p_new_principal_portion < 0 or p_new_principal_portion > v_amount then
    raise exception 'update_linked_payment_principal: principal_portion (%) must be between 0 and the transaction amount (%)',
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

  if p_principal_portion is null or p_principal_portion < 0 then
    raise exception 'create_manual_loan_payment: principal_portion must be a non-negative number';
  end if;
  if p_interest_portion is null or p_interest_portion < 0 then
    raise exception 'create_manual_loan_payment: interest_portion must be a non-negative number';
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

  if p_set_principal_portion and (p_principal_portion is null or p_principal_portion < 0) then
    raise exception 'update_manual_loan_payment: principal_portion must be a non-negative number';
  end if;
  if p_set_interest_portion and (p_interest_portion is null or p_interest_portion < 0) then
    raise exception 'update_manual_loan_payment: interest_portion must be a non-negative number';
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
-- Residual (disclosed, not closed by this function): a row matching the search criteria that is
-- INSERTED by a concurrent transaction after this function's own discovery query runs, but before
-- this function commits, is not locked by us (there is no row to lock until it exists) and so
-- cannot be detected by FOR UPDATE alone — only SERIALIZABLE isolation (or locking the entire
-- candidate keyspace some other way) closes that specific sub-case, and this function intentionally
-- does not attempt that: this project's other functions all rely on Postgres's default READ
-- COMMITTED isolation, changing it for one function only was judged a bigger, harder-to-verify
-- change than the risk it removes at this app's single-primary-user, personal-finance scale. Every
-- modification to an EXISTING row (the concrete scenario the review's own example describes — "a
-- concurrent request links B to a loan or changes B's amount") is fully closed, because that row
-- IS locked and re-read by this function's own discovery query.
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
-- Every one is added `NOT VALID`, a deliberate two-stage rollout rather than an ordinary CHECK
-- (verified against a disposable PostgreSQL instance for this round, not assumed):
--
--  1. `ALTER TABLE ... ADD CONSTRAINT ... CHECK (...) NOT VALID` takes only a brief metadata lock
--     and does NOT scan or lock existing rows at all — confirmed live: a row already violating
--     `current_balance >= 0` remained readable and untouched immediately after adding that exact
--     constraint NOT VALID. This is safe to apply to this table regardless of what unknown
--     existing production data it holds, which a same-migration ordinary (always-validated)
--     CHECK constraint is NOT — that variant scans and would abort the whole migration on the
--     first violating row, with no visibility into whether one exists before running it.
--  2. From the moment it's added, though, a NOT VALID constraint is FULLY enforced for every new
--     INSERT and every UPDATE that touches the constrained column — confirmed live: an insert of
--     a second violating row was rejected immediately after the NOT VALID constraint above was
--     added, well before anything validated existing rows. So this migration alone already closes
--     the write-path gap (Round 5 remediation, blocker 7's "database only checks loan_type"
--     finding) — no unvalidated new bad data can land, regardless of validation status.
--  3. Validating the constraint against whatever rows already exist (`ALTER TABLE ...
--     VALIDATE CONSTRAINT ...`) is intentionally a SEPARATE, LATER, MANUAL step — never run as
--     part of this migration, and never against production from this session (this project's
--     standing rule: never touch production Supabase directly). Confirmed live: VALIDATE
--     CONSTRAINT correctly refuses to complete while a violating row exists, and succeeds (flips
--     `pg_constraint.convalidated` to true) once none remain — a safe, non-destructive operation
--     that only ever reads and reports, never rewrites data. Before ever running it against
--     production, run this read-only preflight against the SAME database first (safe to run
--     anytime, changes nothing):
--
--       select id, user_id, name, current_balance, origination_principal_amount,
--              interest_rate_percentage, minimum_payment_amount, term_months
--       from public.manual_loans
--       where current_balance < 0
--          or (origination_principal_amount is not null and origination_principal_amount < 0)
--          or (interest_rate_percentage is not null and interest_rate_percentage < 0)
--          or (minimum_payment_amount is not null and minimum_payment_amount < 0)
--          or (term_months is not null and term_months <= 0);
--
--     An empty result means `VALIDATE CONSTRAINT` (run separately, once this migration itself has
--     been applied) will succeed immediately. Any returned row means that row needs a decision —
--     correct it or knowingly except it — before validating; the constraint keeps protecting every
--     NEW write in the meantime regardless of when (or whether) that validation step happens.
alter table public.manual_loans
  add constraint manual_loans_current_balance_check check (current_balance >= 0) not valid;

alter table public.manual_loans
  add constraint manual_loans_origination_principal_amount_check
    check (origination_principal_amount is null or origination_principal_amount >= 0) not valid;

alter table public.manual_loans
  add constraint manual_loans_interest_rate_percentage_check
    check (interest_rate_percentage is null or interest_rate_percentage >= 0) not valid;

alter table public.manual_loans
  add constraint manual_loans_minimum_payment_amount_check
    check (minimum_payment_amount is null or minimum_payment_amount >= 0) not valid;

alter table public.manual_loans
  add constraint manual_loans_term_months_check
    check (term_months is null or term_months > 0) not valid;
