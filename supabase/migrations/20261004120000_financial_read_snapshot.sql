-- Financial read snapshot (Financial Semantics Phase B, integration slice I1 corrections).
--
-- WHY. A published aggregate must be computed from ONE coherent financial state and must never be
-- silently truncated. PostgREST caps a response at `max-rows`, so a large enough read needs several
-- requests — and each request is its own committed snapshot. A read assembled from several requests
-- can combine states that never existed together: a pending row from one page with the posted row
-- that replaced it on the next (counted twice), a loan payment's principal before an edit with another
-- payment's principal after it, a transaction with splits from a different allocation. The card-payment
-- matching version cannot detect that: it watches only the matching inputs, not principal, the loan
-- link, categories or splits.
--
-- WHAT. One function, one statement, one MVCC snapshot. It returns, as a single `jsonb` value (which is
-- not subject to the row cap), everything one read needs:
--
--   get_financial_read_snapshot(user, from, to, include_splits, include_budget_categories,
--                               include_card_states, card_states_from, card_states_to)
--
--   - `transactions`: the user's transactions on accounts INCLUDED in cash flow with `date` in
--     [from, to) (`to` null: open-ended), ordered (date, id). Every column the aggregation consumes —
--     amount, date, Plaid category, budget category, effective role and override, the manual-loan link
--     and principal — plus the lineage ids, the display fields a drill-down row shows, and the account's
--     name, nickname and type.
--   - `splits` (when asked): every split of those transactions, ordered (transaction_id, id).
--   - `budgetCategories` (when asked): the user's budget categories, ordered (sort_order, id).
--   - `cardPayments` (when asked): the result of the EXISTING reader get_card_payment_states(user,
--     card_states_from, card_states_to), called inside this statement. It is STABLE, so it runs on this
--     statement's snapshot: the matching versions and states describe exactly the transactions returned
--     beside them. Its freshness rule is unchanged — states are returned only when
--     evaluated_version = input_version.
--
-- LIMITS (development-stage safety limits, to be revisited with measurements before release): at most
-- 10 000 transactions and 25 000 splits. Beyond either, the function returns `tooLarge = true` with the
-- counts and NO rows; the backend then fails the request with `aggregate_too_large`. Nothing is ever
-- truncated, and the limits are constants here — a caller cannot raise them.
--
-- It is `language sql` with a single SELECT, STABLE, SECURITY INVOKER with an empty search_path, and
-- executable by service_role only. PostgREST runs a STABLE function in a read-only transaction.
--
-- Additive: no table, trigger, index or change to any existing function or to the C1 / S1 objects.
-- Rollback: `drop function public.get_financial_read_snapshot(uuid, date, date, boolean, boolean,
-- boolean, date, date);` (supabase/rollback/20261004120000_financial_read_snapshot_rollback.sql). A
-- backend without the function serves level-1 aggregates that fit one response exactly as before,
-- fails closed on larger ones, and reports the role-aware figures as unavailable.

create function public.get_financial_read_snapshot(
  p_user_id uuid,
  p_from date,
  p_to date default null,
  p_include_splits boolean default false,
  p_include_budget_categories boolean default false,
  p_include_card_states boolean default false,
  p_card_states_from date default null,
  p_card_states_to date default null
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with txn as materialized (
    select t.id, t.account_id, t.date, t.amount, t.category, t.budget_category_id, t.effective_role,
           t.user_role_override, t.manual_loan_id, t.principal_portion, t.name, t.merchant_name, t.pending,
           t.needs_review, t.plaid_transaction_id, t.pending_transaction_id,
           a.name as account_name, a.nickname as account_nickname, a.type as account_type,
           a.exclude_from_cash_flow as account_excluded
    from public.transactions t
    join public.accounts a on a.id = t.account_id
    join public.plaid_items i on i.id = a.item_id
    where i.user_id = p_user_id
      and a.exclude_from_cash_flow = false
      and t.date >= p_from
      and (p_to is null or t.date < p_to)
  ),
  spl as materialized (
    select s.id, s.transaction_id, s.budget_category_id, s.amount, s.note
    from public.transaction_splits s
    join txn on txn.id = s.transaction_id
    where p_include_splits
  ),
  totals as (
    select (select count(*) from txn) as transaction_count,
           (select count(*) from spl) as split_count
  )
  select case
    when c.transaction_count > 10000 or c.split_count > 25000 then
      jsonb_build_object(
        'tooLarge', true,
        'transactionCount', c.transaction_count,
        'splitCount', c.split_count,
        'maxTransactions', 10000,
        'maxSplits', 25000)
    else
      jsonb_build_object(
        'tooLarge', false,
        'transactionCount', c.transaction_count,
        'splitCount', c.split_count,
        'maxTransactions', 10000,
        'maxSplits', 25000,
        'transactions', (
          select coalesce(jsonb_agg(jsonb_build_object(
                   'id', x.id, 'account_id', x.account_id, 'date', x.date, 'amount', x.amount,
                   'category', x.category, 'budget_category_id', x.budget_category_id,
                   'effective_role', x.effective_role, 'user_role_override', x.user_role_override,
                   'manual_loan_id', x.manual_loan_id, 'principal_portion', x.principal_portion,
                   'name', x.name, 'merchant_name', x.merchant_name, 'pending', x.pending,
                   'needs_review', x.needs_review, 'plaid_transaction_id', x.plaid_transaction_id,
                   'pending_transaction_id', x.pending_transaction_id,
                   'accounts', jsonb_build_object('name', x.account_name, 'nickname', x.account_nickname,
                                                  'type', x.account_type,
                                                  'exclude_from_cash_flow', x.account_excluded))
                 order by x.date, x.id), '[]'::jsonb)
          from txn x),
        'splits', case when p_include_splits then (
          select coalesce(jsonb_agg(jsonb_build_object(
                   'id', s.id, 'transaction_id', s.transaction_id, 'budget_category_id', s.budget_category_id,
                   'amount', s.amount, 'note', s.note)
                 order by s.transaction_id, s.id), '[]'::jsonb)
          from spl s) end,
        'budgetCategories', case when p_include_budget_categories then (
          select coalesce(jsonb_agg(to_jsonb(bc) order by bc.sort_order, bc.id), '[]'::jsonb)
          from public.budget_categories bc
          where bc.user_id = p_user_id) end,
        'cardPayments', case when p_include_card_states then
          public.get_card_payment_states(p_user_id, p_card_states_from, p_card_states_to) end)
  end
  from totals c
$$;

comment on function public.get_financial_read_snapshot(uuid, date, date, boolean, boolean, boolean, date, date) is
  'One-statement, one-snapshot read of a user''s financial inputs for the role-aware and frozen aggregates '
  '(transactions on included accounts, optional splits, budget categories and card-payment states). Returns '
  'tooLarge with no rows beyond 10000 transactions or 25000 splits. service_role only.';

-- Supabase's default privileges grant EXECUTE on new public functions to anon/authenticated: revoke.
revoke all on function public.get_financial_read_snapshot(uuid, date, date, boolean, boolean, boolean, date, date)
  from public, anon, authenticated;
grant execute on function public.get_financial_read_snapshot(uuid, date, date, boolean, boolean, boolean, date, date)
  to service_role;

-- ---- Postcondition --------------------------------------------------------------------------------
do $$
declare
  v_sig constant text := 'public.get_financial_read_snapshot(uuid, date, date, boolean, boolean, boolean, date, date)';
begin
  perform 1
  from pg_proc p
  join pg_language l on l.oid = p.prolang
  where p.oid = v_sig::regprocedure
    and l.lanname = 'sql'
    and p.provolatile = 's'
    and not p.prosecdef
    and p.proconfig = array['search_path=""']
    and p.prorettype = 'jsonb'::regtype
    and not p.proretset
    and pg_get_userbyid(p.proowner) = current_user
    and not has_function_privilege('public', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute')
    and not has_function_privilege('authenticated', p.oid, 'execute')
    and has_function_privilege('service_role', p.oid, 'execute');
  if not found then
    raise exception 'financial read snapshot postcondition failed: % is not a STABLE, SECURITY INVOKER, '
                    'search_path-pinned sql function returning jsonb, owned by the migration role and '
                    'executable by service_role only', v_sig;
  end if;
  -- Exactly one function of this name exists: no overload a client grant could hide behind.
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'get_financial_read_snapshot') <> 1 then
    raise exception 'financial read snapshot postcondition failed: more than one get_financial_read_snapshot exists';
  end if;
end;
$$;
