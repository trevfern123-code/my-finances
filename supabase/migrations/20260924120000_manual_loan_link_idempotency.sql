-- Post-audit blocker 1: link_transaction_to_manual_loan must not decrement a loan twice.
--
-- The deployed function (20260912120000) serializes callers with the per-user advisory lock and
-- row-locks the transaction, but never re-checks whether that transaction is ALREADY linked. Both
-- callers choose their candidates before taking the lock (loans.ts backfillMatchesForLoan /
-- linkNewTransactionsToManualLoans read "unlinked outflows", then link each one), so two overlapping
-- callers — or a retry — could each link the same transaction: the loan was decremented twice, or
-- the link moved to a second loan whose balance was decremented without restoring the first.
--
-- Now, under the same lock and row locks, the function re-reads the existing link and principal and
-- returns an explicit outcome instead of writing blindly:
--   'linked'                              was unlinked: linked, and the loan decremented (as before)
--   'already_linked'                      exact replay: same loan, same principal — no writes
--   'already_linked_different_principal'  same loan, another principal (e.g. edited since) — no writes
--   'linked_to_other_loan'                a stale candidate another loan already took — no writes
-- Ownership of the transaction and of the requested loan is verified first, exactly as before
-- (raising if either is not the caller's), so no outcome is ever reported for another user's rows.
--
-- Changing the return type (void -> text) requires DROP + CREATE; CREATE OR REPLACE cannot change
-- it. Both happen inside this migration's single transaction (the Supabase CLI applies a file as one
-- pipeline; `psql -1` / the SQL editor as one transaction), so other sessions keep seeing the old
-- function until commit — there is no moment without one — and any failure below rolls back to it.
-- Every other property of the function is captured before the drop and must be identical after the
-- create (owner, language, SECURITY INVOKER, search_path, volatility, strictness, parallel safety,
-- leakproofness, argument names and types, and EXECUTE for PUBLIC/anon/authenticated/service_role),
-- or the migration raises and nothing changes. DROP is not CASCADE: an unexpected dependent object
-- also aborts it.
--
-- No top-level SET LOCAL / LOCK TABLE here (see README "Replaying the history").
--
-- Deploy order: apply this migration BEFORE the backend that reads the outcome. The backend on
-- `main` does not call this function at all, so applying it early is invisible to live traffic.
--
-- Rollback (restores the previous behaviour, double-decrement included): re-run the
-- `create or replace function public.link_transaction_to_manual_loan` block and its four
-- revoke/grant statements from 20260912120000_transaction_semantic_roles.sql after
-- `drop function public.link_transaction_to_manual_loan(uuid, uuid, uuid, numeric, smallint);`.

do $$
declare
  v_props jsonb;
begin
  select jsonb_build_object(
           'owner', pg_get_userbyid(p.proowner),
           'language', l.lanname,
           'security_definer', p.prosecdef,
           'config', coalesce(p.proconfig, '{}'::text[]),
           'volatility', p.provolatile,
           'strict', p.proisstrict,
           'parallel', p.proparallel,
           'leakproof', p.proleakproof,
           'arg_names', p.proargnames,
           'arg_types', p.proargtypes::regtype[]::text[],
           'exec_public', has_function_privilege('public', p.oid, 'execute'),
           'exec_anon', has_function_privilege('anon', p.oid, 'execute'),
           'exec_authenticated', has_function_privilege('authenticated', p.oid, 'execute'),
           'exec_service_role', has_function_privilege('service_role', p.oid, 'execute'))
    into v_props
    from pg_proc p
    join pg_language l on l.oid = p.prolang
   where p.oid = 'public.link_transaction_to_manual_loan(uuid, uuid, uuid, numeric, smallint)'::regprocedure;

  -- The deployed function must already be in the intended secure state; preserving anything else
  -- would be preserving a defect, so refuse rather than carry it over.
  if v_props->>'security_definer' <> 'false'
     or v_props->'config' <> '["search_path=\"\""]'::jsonb
     or (v_props->>'exec_public')::boolean or (v_props->>'exec_anon')::boolean
     or (v_props->>'exec_authenticated')::boolean or not (v_props->>'exec_service_role')::boolean then
    raise exception 'link_transaction_to_manual_loan is not in its expected secure state before the repair: %', v_props;
  end if;

  perform set_config('post_audit.link_fn_before', v_props::text, true);
end
$$;

drop function public.link_transaction_to_manual_loan(uuid, uuid, uuid, numeric, smallint);

create function public.link_transaction_to_manual_loan(
  p_user_id uuid,
  p_transaction_id uuid,
  p_loan_id uuid,
  p_principal_portion numeric,
  p_classifier_version smallint
) returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_amount numeric;
  v_linked_loan_id uuid;
  v_linked_principal numeric;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  select t.amount, t.manual_loan_id, t.principal_portion
    into v_amount, v_linked_loan_id, v_linked_principal
  from public.transactions t
  join public.accounts a on a.id = t.account_id
  join public.plaid_items pi on pi.id = a.item_id
  where t.id = p_transaction_id
    and pi.user_id = p_user_id
  for update of t, a, pi;

  if not found then
    raise exception 'link_transaction_to_manual_loan: transaction not found or not owned by user';
  end if;

  perform 1 from public.manual_loans where id = p_loan_id and user_id = p_user_id for update;
  if not found then
    raise exception 'link_transaction_to_manual_loan: manual loan not found or not owned by user';
  end if;

  -- Re-validated UNDER the lock: callers choose candidates before taking it, so the transaction may
  -- have been linked since. Never link it again, and never decrement any loan a second time.
  if v_linked_loan_id is not null then
    if v_linked_loan_id <> p_loan_id then
      return 'linked_to_other_loan';
    end if;
    if v_linked_principal is not distinct from p_principal_portion then
      return 'already_linked';
    end if;
    return 'already_linked_different_principal';
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

  return 'linked';
end;
$$;

revoke execute on function public.link_transaction_to_manual_loan(uuid, uuid, uuid, numeric, smallint) from public;
revoke execute on function public.link_transaction_to_manual_loan(uuid, uuid, uuid, numeric, smallint) from anon;
revoke execute on function public.link_transaction_to_manual_loan(uuid, uuid, uuid, numeric, smallint) from authenticated;
grant execute on function public.link_transaction_to_manual_loan(uuid, uuid, uuid, numeric, smallint) to service_role;

-- Postcondition: identical to the captured properties in everything but the return type.
do $$
declare
  v_before jsonb := current_setting('post_audit.link_fn_before')::jsonb;
  v_after jsonb;
  v_returns text;
begin
  select jsonb_build_object(
           'owner', pg_get_userbyid(p.proowner),
           'language', l.lanname,
           'security_definer', p.prosecdef,
           'config', coalesce(p.proconfig, '{}'::text[]),
           'volatility', p.provolatile,
           'strict', p.proisstrict,
           'parallel', p.proparallel,
           'leakproof', p.proleakproof,
           'arg_names', p.proargnames,
           'arg_types', p.proargtypes::regtype[]::text[],
           'exec_public', has_function_privilege('public', p.oid, 'execute'),
           'exec_anon', has_function_privilege('anon', p.oid, 'execute'),
           'exec_authenticated', has_function_privilege('authenticated', p.oid, 'execute'),
           'exec_service_role', has_function_privilege('service_role', p.oid, 'execute')),
         p.prorettype::regtype::text
    into v_after, v_returns
    from pg_proc p
    join pg_language l on l.oid = p.prolang
   where p.oid = 'public.link_transaction_to_manual_loan(uuid, uuid, uuid, numeric, smallint)'::regprocedure;

  if v_after is distinct from v_before then
    raise exception 'link_transaction_to_manual_loan changed more than its return type. before: % after: %', v_before, v_after;
  end if;
  if v_returns <> 'text' then
    raise exception 'link_transaction_to_manual_loan returns % instead of text', v_returns;
  end if;
end
$$;
