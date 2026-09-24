-- Post-audit blocker 2: undoing a manual-loan payment must restore exactly what applying it took.
--
-- Every balance decrement clamps at zero (a loan balance is never negative), but every reversal
-- added back the full principal_portion. With a $50 balance, linking a $100-principal payment set
-- the balance to 0 (50 applied); unlinking it then set it to 100 — $50 of debt that never existed.
-- The same asymmetry hit editing a linked principal, editing/deleting a manual payment and Plaid
-- removing a linked transaction.
--
-- Now each application records the delta it actually applied, and each reversal restores exactly
-- that:
--   transactions.loan_balance_applied         set by link / linked-principal edit, used by unlink,
--                                             the next edit and Plaid removal
--   manual_loan_payments.balance_applied      set by create / principal edit, used by the next edit
--                                             and delete
-- Applying principal p to balance b takes least(p, b): the balance still never goes below zero,
-- and 0 <= applied <= p. Reversing adds `applied` back, so apply-then-undo returns the balance to
-- exactly its previous value in any order (the undos only add; they commute). An edit is "undo the
-- old application, apply the new principal" in one step; an edit that does not change the principal
-- changes nothing.
--
-- The applied path no longer rounds the balance to cents (`round(balance - p, 2)` before): rounding
-- would make the recorded delta differ from p and break exact reversal. The backend cent-normalizes
-- every principal, so for cent balances the results are identical to before.
--
-- Rows written before this migration have NULL here, since what they actually applied was never
-- recorded. Unlink, payment delete and Plaid removal keep exactly the previous behaviour for them
-- (restore the full principal_portion, rounded to cents); an edit undoes the full old principal, as
-- before, and records what the new principal applies. There is deliberately no backfill: a legacy
-- row's applied amount cannot be reconstructed (README "Wave 1 follow-ups": manual-loan
-- balance-as-of semantics).
--
-- transactions.loan_balance_applied is meaningful only while manual_loan_id is set. Unlinking
-- clears it; a row whose loan was deleted (delete_manual_loan_atomic, or the FK's ON DELETE SET
-- NULL) may keep a stale value, which nothing reads: every reader requires the link first, and
-- linking always overwrites it.
--
-- Apart from recording/restoring the applied delta, the seven functions below are unchanged:
-- same signatures, return types, locking order, ownership checks, validation, messages and
-- link outcomes (20260924120000). CREATE OR REPLACE keeps their owner and grants; the postcondition
-- at the end verifies the security properties anyway.
--
-- No top-level SET LOCAL / LOCK TABLE here (see README "Replaying the history"): both are inside
-- the DO block below, and hold until this file's single transaction ends.
--
-- Deploy order: apply after 20260924120000 and before the backend of the same commit (the backend
-- does not read the new columns; the order only matters for 20260924120000's outcome contract).

do $$
begin
  perform set_config('lock_timeout', '15s', true);
  lock table public.manual_loans, public.manual_loan_payments, public.transactions in access exclusive mode;
end
$$;

alter table public.transactions
  add column loan_balance_applied numeric
    constraint transactions_loan_balance_applied_check
    check (loan_balance_applied >= 0 and loan_balance_applied < 'Infinity'::numeric);

alter table public.manual_loan_payments
  add column balance_applied numeric
    constraint manual_loan_payments_balance_applied_check
    check (balance_applied >= 0 and balance_applied < 'Infinity'::numeric);

comment on column public.transactions.loan_balance_applied is
  'Amount this linked payment actually took off manual_loans.current_balance (principal_portion, clamped so the balance never goes negative). Restored exactly on unlink/edit/Plaid removal. NULL for links made before 20260924130000 (those restore principal_portion). Meaningful only while manual_loan_id is set.';
comment on column public.manual_loan_payments.balance_applied is
  'Amount this payment actually took off manual_loans.current_balance (principal_portion, clamped so the balance never goes negative). Restored exactly on edit/delete. NULL for payments made before 20260924130000 (those restore principal_portion).';

create or replace function public.link_transaction_to_manual_loan(
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
  v_balance numeric;
  v_applied numeric;
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

  select current_balance into v_balance from public.manual_loans where id = p_loan_id and user_id = p_user_id for update;
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

  -- Post-audit blocker 2: take at most the remaining balance, and remember exactly what was taken.
  v_applied := least(p_principal_portion, greatest(v_balance, 0));

  update public.transactions
  set manual_loan_id = p_loan_id,
      principal_portion = p_principal_portion,
      loan_balance_applied = v_applied,
      auto_role = 'debt_payment',
      role_source = 'manual_loan_link',
      role_confidence = 'high',
      classifier_version = p_classifier_version
  where id = p_transaction_id;

  update public.manual_loans
  set current_balance = v_balance - v_applied,
      updated_at = now()
  where id = p_loan_id;

  return 'linked';
end;
$$;

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
  v_applied numeric;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  select t.manual_loan_id, t.principal_portion, t.loan_balance_applied
    into v_manual_loan_id, v_principal_portion, v_applied
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
      loan_balance_applied = null,
      auto_role = p_auto_role,
      role_source = p_role_source,
      role_confidence = p_role_confidence,
      classifier_version = p_classifier_version
  where id = p_transaction_id;

  -- Restore exactly what the link took; a legacy link (NULL) keeps the previous behaviour.
  update public.manual_loans
  set current_balance = case when v_applied is null
                             then round((current_balance + coalesce(v_principal_portion, 0))::numeric, 2)
                             else current_balance + v_applied end,
      updated_at = now()
  where id = p_loan_id;

  return true;
end;
$$;

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
  v_old_applied numeric;
  v_amount numeric;
  v_restored numeric;
  v_applied numeric;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  select t.manual_loan_id, t.principal_portion, t.loan_balance_applied, t.amount
    into v_manual_loan_id, v_old_principal, v_old_applied, v_amount
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

  select current_balance into v_restored from public.manual_loans where id = p_loan_id and user_id = p_user_id for update;
  if not found then
    raise exception 'update_linked_payment_principal: manual loan not found or not owned by user';
  end if;

  -- Post-audit blocker 2: an unchanged principal is a no-op (re-applying it could otherwise move a
  -- balance that was clamped at link time).
  if p_new_principal_portion is not distinct from v_old_principal then
    return;
  end if;

  -- Undo the old application exactly (legacy NULL: as before, the full old principal), then apply
  -- the new principal to that balance.
  v_restored := v_restored + coalesce(v_old_applied, v_old_principal, 0);
  v_applied := least(p_new_principal_portion, greatest(v_restored, 0));

  update public.transactions
  set principal_portion = p_new_principal_portion,
      loan_balance_applied = v_applied
  where id = p_transaction_id;

  update public.manual_loans
  set current_balance = v_restored - v_applied,
      updated_at = now()
  where id = p_loan_id;
end;
$$;

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
  v_balance numeric;
  v_applied numeric;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  select current_balance into v_balance from public.manual_loans where id = p_loan_id and user_id = p_user_id for update;
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

  v_applied := least(p_principal_portion, greatest(v_balance, 0));

  insert into public.manual_loan_payments (user_id, loan_id, date, principal_portion, interest_portion, notes, balance_applied)
  values (p_user_id, p_loan_id, p_date, p_principal_portion, p_interest_portion, p_notes, v_applied)
  returning id into v_payment_id;

  update public.manual_loans
  set current_balance = v_balance - v_applied,
      updated_at = now()
  where id = p_loan_id;

  return v_payment_id;
end;
$$;

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
  v_balance numeric;
  v_old_principal numeric;
  v_old_applied numeric;
  v_rebalance boolean;
  v_applied numeric;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  select current_balance into v_balance from public.manual_loans where id = p_loan_id and user_id = p_user_id for update;
  if not found then
    raise exception 'update_manual_loan_payment: manual loan not found or not owned by user';
  end if;

  select principal_portion, balance_applied into v_old_principal, v_old_applied
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

  -- Post-audit blocker 2: undo the old application exactly (legacy NULL: the full old principal),
  -- then apply the new principal. An unchanged principal moves nothing.
  v_rebalance := p_set_principal_portion and p_principal_portion is distinct from v_old_principal;
  if v_rebalance then
    v_balance := v_balance + coalesce(v_old_applied, v_old_principal, 0);
    v_applied := least(p_principal_portion, greatest(v_balance, 0));
  end if;

  update public.manual_loan_payments
  set date = case when p_set_date then p_date else date end,
      principal_portion = case when p_set_principal_portion then p_principal_portion else principal_portion end,
      interest_portion = case when p_set_interest_portion then p_interest_portion else interest_portion end,
      notes = case when p_set_notes then p_notes else notes end,
      balance_applied = case when v_rebalance then v_applied else balance_applied end
  where id = p_payment_id;

  if v_rebalance then
    update public.manual_loans
    set current_balance = v_balance - v_applied,
        updated_at = now()
    where id = p_loan_id;
  end if;
end;
$$;

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
  v_applied numeric;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  perform 1 from public.manual_loans where id = p_loan_id and user_id = p_user_id for update;
  if not found then
    raise exception 'delete_manual_loan_payment: manual loan not found or not owned by user';
  end if;

  select principal_portion, balance_applied into v_principal, v_applied
  from public.manual_loan_payments
  where id = p_payment_id and loan_id = p_loan_id
  for update;

  if not found then
    return;
  end if;

  delete from public.manual_loan_payments where id = p_payment_id;

  update public.manual_loans
  set current_balance = case when v_applied is null
                             then round((current_balance + coalesce(v_principal, 0))::numeric, 2)
                             else current_balance + v_applied end,
      updated_at = now()
  where id = p_loan_id;
end;
$$;

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
    select t.id, t.manual_loan_id, t.principal_portion, t.loan_balance_applied
    from public.transactions t
    join public.accounts a on a.id = t.account_id
    join public.plaid_items pi on pi.id = a.item_id
    where t.plaid_transaction_id = any(p_plaid_transaction_ids)
      and pi.user_id = p_user_id
      and t.manual_loan_id is not null
    for update of t
  loop
    update public.manual_loans
    set current_balance = case when r.loan_balance_applied is null
                               then round((current_balance + coalesce(r.principal_portion, 0))::numeric, 2)
                               else current_balance + r.loan_balance_applied end,
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

-- Postcondition: CREATE OR REPLACE keeps each function's owner and ACL; verify the security
-- properties and signatures are still exactly what 20260912120000/20260924120000 established.
do $$
declare
  v_fn text;
  v_bad text := '';
begin
  foreach v_fn in array array[
    'public.link_transaction_to_manual_loan(uuid, uuid, uuid, numeric, smallint)|text',
    'public.unlink_transaction_from_manual_loan(uuid, uuid, uuid, text, text, text, smallint)|boolean',
    'public.update_linked_payment_principal(uuid, uuid, uuid, numeric)|void',
    'public.create_manual_loan_payment(uuid, uuid, date, numeric, numeric, text)|uuid',
    'public.update_manual_loan_payment(uuid, uuid, uuid, boolean, date, boolean, numeric, boolean, numeric, boolean, text)|void',
    'public.delete_manual_loan_payment(uuid, uuid, uuid)|void',
    'public.delete_transactions_and_restore_loan_balances(uuid, text[])|void'
  ] loop
    perform 1
    from pg_proc p
    where p.oid = split_part(v_fn, '|', 1)::regprocedure
      and p.prorettype = split_part(v_fn, '|', 2)::regtype
      and not p.prosecdef
      and p.proconfig = array['search_path=""']
      and p.proowner = (select proowner from pg_proc where oid = 'public.delete_manual_loan_atomic(uuid, uuid, jsonb)'::regprocedure)
      and not has_function_privilege('public', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('authenticated', p.oid, 'execute')
      and has_function_privilege('service_role', p.oid, 'execute');
    if not found then
      v_bad := v_bad || E'\n  ' || v_fn;
    end if;
  end loop;
  if v_bad <> '' then
    raise exception 'manual-loan functions lost a security property or changed signature:%', v_bad;
  end if;
end
$$;
