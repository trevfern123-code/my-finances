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
create or replace function public.apply_transaction_semantic_roles(
  p_user_id uuid,
  p_transaction_ids uuid[],
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
begin
  v_input_count := coalesce(array_length(p_transaction_ids, 1), 0);
  if v_input_count = 0 then
    raise exception 'apply_transaction_semantic_roles: no transaction ids supplied';
  end if;

  -- Reject duplicate ids outright — otherwise a caller passing e.g. [X, X] could satisfy a naive
  -- "count matches" check without actually referring to two distinct rows.
  select count(distinct x) into v_distinct_count from unnest(p_transaction_ids) as x;
  if v_distinct_count is distinct from v_input_count then
    raise exception 'apply_transaction_semantic_roles: duplicate transaction ids supplied (% distinct of %)',
      v_distinct_count, v_input_count;
  end if;

  -- Verify ownership and LOCK the candidate rows inside this same transaction, before any write.
  -- The locking SELECT itself carries no aggregate (Postgres forbids that combination) — it just
  -- locks and returns each owned row's id; the surrounding array_agg (unlocked) is what counts
  -- them. An id that doesn't come back here (wrong user, or the row no longer exists) means the
  -- whole call fails — nothing is ever partially applied to the ids that DID resolve.
  select array_agg(owned.id) into v_owned_ids
  from (
    select t.id
    from public.transactions t
    join public.accounts a on a.id = t.account_id
    join public.plaid_items pi on pi.id = a.item_id
    where t.id = any(p_transaction_ids)
      and pi.user_id = p_user_id
    for update of t
  ) owned;

  v_owned_count := coalesce(array_length(v_owned_ids, 1), 0);

  if v_owned_count is distinct from v_input_count then
    raise exception 'apply_transaction_semantic_roles: ownership check failed (expected % owned rows, found %)',
      v_input_count, v_owned_count;
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
revoke execute on function public.apply_transaction_semantic_roles(uuid, uuid[], text, text, text, smallint) from public;
revoke execute on function public.apply_transaction_semantic_roles(uuid, uuid[], text, text, text, smallint) from anon;
revoke execute on function public.apply_transaction_semantic_roles(uuid, uuid[], text, text, text, smallint) from authenticated;
grant execute on function public.apply_transaction_semantic_roles(uuid, uuid[], text, text, text, smallint) to service_role;
