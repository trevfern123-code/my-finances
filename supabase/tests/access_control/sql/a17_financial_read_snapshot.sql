-- Financial read snapshot (migration 20261004120000): one STABLE, SECURITY INVOKER, search_path-pinned
-- sql function returning jsonb, executable by service_role only. It returns only the caller-named
-- user's rows on accounts included in cash flow, in a deterministic order, and nothing beyond its
-- limits. The migration's postcondition checks the catalog; this test also exercises it at runtime.

-- ---- Catalog --------------------------------------------------------------------------------------------
select th.assert((select count(*) from pg_proc p join pg_language l on l.oid = p.prolang
                  where p.oid = 'public.get_financial_read_snapshot(uuid, date, date, boolean, boolean, boolean, date, date)'::regprocedure
                    and l.lanname = 'sql' and p.provolatile = 's' and not p.prosecdef
                    and p.proconfig = array['search_path=""'] and p.prorettype = 'jsonb'::regtype
                    and has_function_privilege('service_role', p.oid, 'execute')
                    and not has_function_privilege('anon', p.oid, 'execute')
                    and not has_function_privilege('authenticated', p.oid, 'execute')
                    and not has_function_privilege('public', p.oid, 'execute')) = 1,
  'the function is STABLE sql, SECURITY INVOKER, search_path pinned, service_role only');
select th.assert((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'get_financial_read_snapshot') = 1,
  'there is exactly one get_financial_read_snapshot (no overload)');

-- ---- Data: user aa (two included accounts, one excluded) and user bb ---------------------------------------
insert into public.accounts (id, item_id, plaid_account_id, name, type, exclude_from_cash_flow) values
  ('00000000-0000-0000-0000-0000000a1701', '00000000-0000-0000-0000-000000000001', 'a17-ac', 'AA Checking', 'depository', false),
  ('00000000-0000-0000-0000-0000000a1702', '00000000-0000-0000-0000-000000000001', 'a17-ax', 'AA Card', 'credit', false),
  ('00000000-0000-0000-0000-0000000a1703', '00000000-0000-0000-0000-000000000001', 'a17-ae', 'AA Excluded', 'depository', true),
  ('00000000-0000-0000-0000-0000000b1701', '00000000-0000-0000-0000-000000000002', 'a17-bc', 'BB Checking', 'depository', false);
insert into public.budget_categories (id, user_id, name, sort_order) values
  ('00000000-0000-0000-0000-0000000a17c2', '00000000-0000-0000-0000-0000000000aa', 'A17 Second', 2),
  ('00000000-0000-0000-0000-0000000a17c1', '00000000-0000-0000-0000-0000000000aa', 'A17 First', 1),
  ('00000000-0000-0000-0000-0000000b17c1', '00000000-0000-0000-0000-0000000000bb', 'A17 BB', 1);
insert into public.manual_loans (id, user_id, name, current_balance) values
  ('00000000-0000-0000-0000-0000000a17d1', '00000000-0000-0000-0000-0000000000aa', 'A17 loan', 1000);
insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name, category, budget_category_id,
                                 auto_role, role_source, role_confidence, classifier_version) values
  ('00000000-0000-0000-0000-0000000a1713', '00000000-0000-0000-0000-0000000a1701', 'a17-t3', 30, '2026-09-02', 'Third', 'FOOD_AND_DRINK', '00000000-0000-0000-0000-0000000a17c1', 'expense', 'sign_default', 'low', 1),
  ('00000000-0000-0000-0000-0000000a1711', '00000000-0000-0000-0000-0000000a1701', 'a17-t1', 50, '2026-09-01', 'First', 'FOOD_AND_DRINK', null, 'expense', 'sign_default', 'low', 1),
  ('00000000-0000-0000-0000-0000000a1712', '00000000-0000-0000-0000-0000000a1702', 'a17-t2', 20, '2026-09-02', 'Second', null, null, 'expense', 'sign_default', 'low', 1),
  ('00000000-0000-0000-0000-0000000a1714', '00000000-0000-0000-0000-0000000a1701', 'a17-t4', 400, '2026-08-31', 'August', null, null, 'expense', 'sign_default', 'low', 1),
  ('00000000-0000-0000-0000-0000000a1715', '00000000-0000-0000-0000-0000000a1701', 'a17-t5', 75, '2026-10-01', 'October', null, null, 'expense', 'sign_default', 'low', 1),
  ('00000000-0000-0000-0000-0000000a1716', '00000000-0000-0000-0000-0000000a1703', 'a17-t6', 999, '2026-09-03', 'Excluded account', null, null, 'expense', 'sign_default', 'low', 1),
  ('00000000-0000-0000-0000-0000000b1711', '00000000-0000-0000-0000-0000000b1701', 'a17-tb', 70, '2026-09-02', 'BB row', null, '00000000-0000-0000-0000-0000000b17c1', 'expense', 'sign_default', 'low', 1);
insert into public.transaction_splits (id, transaction_id, budget_category_id, amount, note) values
  ('00000000-0000-0000-0000-0000000a17e2', '00000000-0000-0000-0000-0000000a1713', '00000000-0000-0000-0000-0000000a17c2', 10, 'b'),
  ('00000000-0000-0000-0000-0000000a17e1', '00000000-0000-0000-0000-0000000a1713', '00000000-0000-0000-0000-0000000a17c1', 20, 'a'),
  ('00000000-0000-0000-0000-0000000a17e3', '00000000-0000-0000-0000-0000000a1716', '00000000-0000-0000-0000-0000000a17c1', 999, 'excluded parent'),
  ('00000000-0000-0000-0000-0000000b17e1', '00000000-0000-0000-0000-0000000b1711', '00000000-0000-0000-0000-0000000b17c1', 70, 'bb');

-- ---- Runtime as service_role ------------------------------------------------------------------------------
begin;
set local role service_role;
create temporary table snap on commit drop as
  select public.get_financial_read_snapshot('00000000-0000-0000-0000-0000000000aa', '2026-09-01', '2026-10-01', true, true, true,
                                            '2026-09-01', '2026-10-01') as j;

select th.assert((select (j->>'tooLarge')::boolean from pg_temp.snap) = false, 'within the limits');
select th.assert((select (j->>'maxTransactions')::int = 10000 and (j->>'maxSplits')::int = 25000 from pg_temp.snap),
  'the limits are reported as the server constants');
-- Owner, date range [from, to) and included accounts only; deterministic (date, id) order.
select th.assert((select array_agg(e->>'id' order by ord) from pg_temp.snap, jsonb_array_elements(j->'transactions') with ordinality as t(e, ord))
                 = array['00000000-0000-0000-0000-0000000a1711', '00000000-0000-0000-0000-0000000a1712', '00000000-0000-0000-0000-0000000a1713'],
  'only user aa''s September rows on included accounts, ordered by (date, id)');
select th.assert((select (j->>'transactionCount')::int from pg_temp.snap) = 3, 'the count is the rows returned');
select th.assert((select j::text from pg_temp.snap) not like '%a17-tb%' and (select j::text from pg_temp.snap) not like '%BB row%'
                 and (select j::text from pg_temp.snap) not like '%0000000b17%',
  'nothing of user bb appears anywhere in the payload');
select th.assert((select j::text from pg_temp.snap) not like '%Excluded account%' and (select j::text from pg_temp.snap) not like '%excluded parent%',
  'rows and splits on an account excluded from cash flow are not returned');
-- Every consumed column is present on a row.
select th.assert((select (e ?& array['id', 'account_id', 'date', 'amount', 'category', 'budget_category_id', 'effective_role',
                                       'user_role_override', 'manual_loan_id', 'principal_portion', 'name', 'merchant_name',
                                       'pending', 'needs_review', 'plaid_transaction_id', 'pending_transaction_id', 'accounts'])
                  from pg_temp.snap, jsonb_array_elements(j->'transactions') e limit 1),
  'a transaction carries every consumed column, the lineage ids and its account');
select th.assert((select e->'accounts' from pg_temp.snap, jsonb_array_elements(j->'transactions') e
                  where e->>'id' = '00000000-0000-0000-0000-0000000a1712')
                 = '{"name": "AA Card", "nickname": null, "type": "credit", "exclude_from_cash_flow": false}'::jsonb,
  'the account block carries name, nickname, type and the inclusion flag');
select th.assert((select e->>'effective_role' = 'expense' and (e->>'amount')::numeric = 30 and e->>'date' = '2026-09-02'
                  from pg_temp.snap, jsonb_array_elements(j->'transactions') e where e->>'id' = '00000000-0000-0000-0000-0000000a1713'),
  'amount, date and effective role are the stored values');
-- Splits: only of the returned transactions, ordered (transaction_id, id).
select th.assert((select array_agg(e->>'id' order by ord) from pg_temp.snap, jsonb_array_elements(j->'splits') with ordinality as t(e, ord))
                 = array['00000000-0000-0000-0000-0000000a17e1', '00000000-0000-0000-0000-0000000a17e2'],
  'only the splits of the returned transactions, ordered by (transaction_id, id)');
-- Budget categories: the user's own, ordered (sort_order, id).
select th.assert((select array_agg(e->>'name' order by ord) from pg_temp.snap, jsonb_array_elements(j->'budgetCategories') with ordinality as t(e, ord))
                 = array['A17 First', 'A17 Second'],
  'only user aa''s budget categories, ordered by sort_order');
-- Card states come from the existing reader, in this statement: never evaluated here, so not fresh.
select th.assert((select j->'cardPayments' = public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa', '2026-09-01', '2026-10-01')
                  from pg_temp.snap),
  'cardPayments is exactly the existing reader''s result');
select th.assert((select (j->'cardPayments'->>'fresh')::boolean from pg_temp.snap) = false, 'unevaluated states are not fresh');

-- Optional parts are null when not asked for; an open-ended range has no upper bound.
select th.assert((select j->'splits' = 'null'::jsonb and j->'budgetCategories' = 'null'::jsonb and j->'cardPayments' = 'null'::jsonb
                  from (select public.get_financial_read_snapshot('00000000-0000-0000-0000-0000000000aa', '2026-09-01', '2026-10-01') as j) s),
  'splits, budget categories and card states are null unless requested');
select th.assert((select (j->>'transactionCount')::int
                  from (select public.get_financial_read_snapshot('00000000-0000-0000-0000-0000000000aa', '2026-08-01') as j) s) = 5,
  'an open-ended range returns every included row from the start date');
select th.assert((select (j->>'transactionCount')::int
                  from (select public.get_financial_read_snapshot('00000000-0000-0000-0000-0000000000bb', '2026-09-01', '2026-10-01') as j) s) = 1,
  'user bb''s snapshot holds only user bb''s row');
select th.assert((select (j->>'transactionCount')::int
                  from (select public.get_financial_read_snapshot(gen_random_uuid(), '2026-09-01', '2026-10-01') as j) s) = 0,
  'an unknown user gets an empty snapshot');

-- After an evaluation the embedded states are fresh and describe the returned rows.
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
select th.assert((select (j->'cardPayments'->>'fresh')::boolean and (j->'cardPayments'->>'inputVersion') = (j->'cardPayments'->>'evaluatedVersion')
                  from (select public.get_financial_read_snapshot('00000000-0000-0000-0000-0000000000aa', '2026-09-01', '2026-10-01',
                                                                  false, false, true, '2026-09-01', '2026-10-01') as j) s),
  'after an evaluation the embedded states are fresh');
rollback;

-- ---- Limits: beyond 10 000 transactions or 25 000 splits there are counts and NO rows -----------------------
begin;
insert into public.transactions (account_id, plaid_transaction_id, amount, date, auto_role, role_source, role_confidence, classifier_version)
select '00000000-0000-0000-0000-0000000a1701', 'a17-bulk-' || g, 1, '2026-07-15', 'expense', 'sign_default', 'low', 1
from generate_series(1, 10000) g;
set local role service_role;
select th.assert((select (j->>'tooLarge')::boolean = false and (j->>'transactionCount')::int = 10000 and jsonb_array_length(j->'transactions') = 10000
                  from (select public.get_financial_read_snapshot('00000000-0000-0000-0000-0000000000aa', '2026-07-01', '2026-08-01') as j) s),
  'exactly 10 000 transactions are returned in full');
reset role;
insert into public.transactions (account_id, plaid_transaction_id, amount, date, auto_role, role_source, role_confidence, classifier_version)
values ('00000000-0000-0000-0000-0000000a1701', 'a17-bulk-10001', 1, '2026-07-15', 'expense', 'sign_default', 'low', 1);
set local role service_role;
select th.assert((select (j->>'tooLarge')::boolean and (j->>'transactionCount')::int = 10001 and not (j ? 'transactions') and not (j ? 'splits')
                  from (select public.get_financial_read_snapshot('00000000-0000-0000-0000-0000000000aa', '2026-07-01', '2026-08-01', true) as j) s),
  '10 001 transactions: tooLarge with the count and no rows at all');
rollback;

begin;
-- The September snapshot already holds two splits; 24 998 more make exactly 25 000.
insert into public.transaction_splits (transaction_id, budget_category_id, amount)
select '00000000-0000-0000-0000-0000000a1711', '00000000-0000-0000-0000-0000000a17c1', 0.01 from generate_series(1, 24998);
set local role service_role;
select th.assert((select (j->>'tooLarge')::boolean = false and (j->>'splitCount')::int = 25000 and jsonb_array_length(j->'splits') = 25000
                  from (select public.get_financial_read_snapshot('00000000-0000-0000-0000-0000000000aa', '2026-09-01', '2026-10-01', true) as j) s),
  'exactly 25 000 splits are returned in full');
reset role;
insert into public.transaction_splits (transaction_id, budget_category_id, amount)
values ('00000000-0000-0000-0000-0000000a1711', '00000000-0000-0000-0000-0000000a17c1', 0.01);
set local role service_role;
select th.assert((select (j->>'tooLarge')::boolean and (j->>'splitCount')::int = 25001 and not (j ? 'transactions') and not (j ? 'splits')
                  from (select public.get_financial_read_snapshot('00000000-0000-0000-0000-0000000000aa', '2026-09-01', '2026-10-01', true) as j) s),
  '25 001 splits: tooLarge with the count and no rows at all');
select th.assert((select (j->>'tooLarge')::boolean = false
                  from (select public.get_financial_read_snapshot('00000000-0000-0000-0000-0000000000aa', '2026-09-01', '2026-10-01', false) as j) s),
  'the split limit does not apply when splits are not requested');
rollback;

-- ---- Runtime: a client request (anon key + the owner's JWT), and anon ---------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000aa","role":"authenticated"}';
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000aa';
select th.expect_error($q$ select public.get_financial_read_snapshot('00000000-0000-0000-0000-0000000000aa', '2026-09-01', '2026-10-01') $q$,
                       '%permission denied for function get_financial_read_snapshot%');
rollback;

begin;
set local role anon;
select th.expect_error($q$ select public.get_financial_read_snapshot('00000000-0000-0000-0000-0000000000aa', '2026-09-01', '2026-10-01') $q$,
                       '%permission denied for function get_financial_read_snapshot%');
rollback;
