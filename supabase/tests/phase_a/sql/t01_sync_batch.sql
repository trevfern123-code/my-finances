-- apply_synced_transaction_batch: multi-row insert counts (Round 10 B1), destination ownership
-- (B2), snapshot CAS (B3), duplicate rejection, and all-or-nothing rollback.
set role service_role;

create function pg_temp.ins(p_plaid text, p_account text, p_amount numeric, p_category_id text default null) returns jsonb
language sql as $$
  select jsonb_build_object('plaid_transaction_id', p_plaid, 'account_id', p_account, 'amount', p_amount,
    'iso_currency_code', 'USD', 'date', '2026-09-10', 'name', p_plaid, 'merchant_name', null, 'category', null,
    'personal_finance_category_detailed', null, 'personal_finance_category_confidence', null, 'plaid_category', null,
    'pending', false, 'needs_review', true, 'budget_category_id', p_category_id,
    'auto_role', 'expense', 'role_source', 'sign_default', 'role_confidence', 'low', 'classifier_version', 1)
$$;

-- An update exactly as applyTransactionChanges builds it: new values + exp_* snapshot of the row as read.
create function pg_temp.upd(p_plaid text, p_new_account uuid, p_new_amount numeric, p_new_name text) returns jsonb
language sql as $$
  select jsonb_build_object('id', t.id, 'account_id', p_new_account, 'amount', p_new_amount, 'iso_currency_code', 'USD',
    'date', t.date, 'name', p_new_name, 'merchant_name', t.merchant_name, 'category', t.category,
    'personal_finance_category_detailed', t.personal_finance_category_detailed,
    'personal_finance_category_confidence', t.personal_finance_category_confidence, 'plaid_category', null, 'pending', false,
    'auto_role', null, 'role_source', null, 'role_confidence', null, 'classifier_version', null,
    'exp_account_id', t.account_id, 'exp_amount', t.amount, 'exp_date', t.date, 'exp_name', t.name,
    'exp_merchant_name', t.merchant_name, 'exp_category', t.category, 'exp_pfc_detailed', t.personal_finance_category_detailed,
    'exp_pfc_confidence', t.personal_finance_category_confidence, 'exp_manual_loan_id', t.manual_loan_id,
    'exp_auto_role', t.auto_role, 'exp_principal_portion', t.principal_portion)
  from public.transactions t where t.plaid_transaction_id = p_plaid
$$;

-- Insert counts: 1, 2, 5 and 0 rows all commit exactly what was sent.
select th.assert(jsonb_array_length(public.apply_synced_transaction_batch('00000000-0000-0000-0000-0000000000aa',
  jsonb_build_array(pg_temp.ins('one', '00000000-0000-0000-0000-0000000000a1', 1)), '[]')) = 1, 'one insert returned');
select th.assert(jsonb_array_length(public.apply_synced_transaction_batch('00000000-0000-0000-0000-0000000000aa',
  jsonb_build_array(pg_temp.ins('two-a', '00000000-0000-0000-0000-0000000000a1', 2),
                    pg_temp.ins('two-b', '00000000-0000-0000-0000-0000000000a2', 3, '00000000-0000-0000-0000-0000000000c1')), '[]')) = 2,
  'two inserts returned (Round 10 B1: this raised "insert count mismatch" before)');
select th.assert(jsonb_array_length(public.apply_synced_transaction_batch('00000000-0000-0000-0000-0000000000aa',
  (select jsonb_agg(pg_temp.ins('five-' || i, '00000000-0000-0000-0000-0000000000a1', i)) from generate_series(1, 5) i), '[]')) = 5,
  'five inserts returned');
select th.assert(public.apply_synced_transaction_batch('00000000-0000-0000-0000-0000000000aa', '[]', '[]') = '[]'::jsonb, 'empty batch is a no-op');
select th.assert((select count(*) from public.transactions) = 8, 'all 8 inserted rows committed');

-- Inserts and updates in one call.
select public.apply_synced_transaction_batch('00000000-0000-0000-0000-0000000000aa',
  jsonb_build_array(pg_temp.ins('combo-new', '00000000-0000-0000-0000-0000000000a1', 9)),
  jsonb_build_array(pg_temp.upd('one', '00000000-0000-0000-0000-0000000000a2', 99, 'moved-within-owner')));
select th.assert((select account_id = '00000000-0000-0000-0000-0000000000a2' and amount = 99 from public.transactions where plaid_transaction_id = 'one'),
  'owned transaction updated to another OWNED account');
select th.assert(exists (select 1 from public.transactions where plaid_transaction_id = 'combo-new'), 'insert in the same call committed');

-- Round 10 B2: an owned transaction may not be moved into another user's account.
select th.expect_error(format('select public.apply_synced_transaction_batch(%L, %L, %L)', '00000000-0000-0000-0000-0000000000aa', '[]',
  jsonb_build_array(pg_temp.upd('two-a', '00000000-0000-0000-0000-0000000000a9', 2, 'hijack'))), '%account not owned by this user%');
select th.assert((select account_id from public.transactions where plaid_transaction_id = 'two-a') = '00000000-0000-0000-0000-0000000000a1',
  'transaction still in its owner''s account');

-- A foreign target transaction.
insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name)
values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a9', 'bbs-row', 77, '2026-09-02', 'bb');
select th.expect_error(format('select public.apply_synced_transaction_batch(%L, %L, %L)', '00000000-0000-0000-0000-0000000000aa', '[]',
  jsonb_build_array(pg_temp.upd('bbs-row', '00000000-0000-0000-0000-0000000000a9', 1, 'x'))), '%not owned by this user%');
select th.assert((select amount from public.transactions where plaid_transaction_id = 'bbs-row') = 77, 'foreign row untouched');

-- A foreign budget category on insert.
select th.expect_error(format('select public.apply_synced_transaction_batch(%L, %L, %L)', '00000000-0000-0000-0000-0000000000aa',
  jsonb_build_array(pg_temp.ins('xcat', '00000000-0000-0000-0000-0000000000a1', 1, '00000000-0000-0000-0000-0000000000c9')), '[]'),
  '%budget category not owned by this user%');

-- Mixed valid + invalid rows roll back completely (inserts and updates alike).
select th.expect_error(format('select public.apply_synced_transaction_batch(%L, %L, %L)', '00000000-0000-0000-0000-0000000000aa',
  jsonb_build_array(pg_temp.ins('mix-ok', '00000000-0000-0000-0000-0000000000a1', 1), pg_temp.ins('mix-bad', '00000000-0000-0000-0000-0000000000a9', 1)),
  jsonb_build_array(pg_temp.upd('two-b', '00000000-0000-0000-0000-0000000000a2', 555, 'should-not-stick'))), '%account not owned by this user%');
select th.assert(not exists (select 1 from public.transactions where plaid_transaction_id in ('mix-ok', 'mix-bad', 'xcat')), 'no insert from a rejected batch');
select th.assert((select amount from public.transactions where plaid_transaction_id = 'two-b') = 3, 'no update from a rejected batch');

-- Round 10 B3 (single-session form; the two-session race is concurrency/c01): a stale snapshot.
select th.expect_error(format('select public.apply_synced_transaction_batch(%L, %L, %L)', '00000000-0000-0000-0000-0000000000aa', '[]',
  jsonb_build_array(pg_temp.upd('five-1', '00000000-0000-0000-0000-0000000000a1', 42, 'stale') || '{"exp_amount": 123456}')),
  '%no longer match the state they were classified against%');
select th.assert((select amount from public.transactions where plaid_transaction_id = 'five-1') = 1, 'stale update not applied');

-- Duplicates.
select th.expect_error(format('select public.apply_synced_transaction_batch(%L, %L, %L)', '00000000-0000-0000-0000-0000000000aa', '[]',
  jsonb_build_array(pg_temp.upd('five-2', '00000000-0000-0000-0000-0000000000a1', 111, 'a'), pg_temp.upd('five-2', '00000000-0000-0000-0000-0000000000a1', 222, 'b'))),
  '%duplicate id supplied in p_updates%');
select th.expect_error(format('select public.apply_synced_transaction_batch(%L, %L, %L)', '00000000-0000-0000-0000-0000000000aa',
  jsonb_build_array(pg_temp.ins('dup', '00000000-0000-0000-0000-0000000000a1', 1), pg_temp.ins('dup', '00000000-0000-0000-0000-0000000000a1', 2)), '[]'),
  '%duplicate plaid_transaction_id%');
-- Retrying an already-inserted row fails on the unique constraint and inserts nothing.
select th.expect_error(format('select public.apply_synced_transaction_batch(%L, %L, %L)', '00000000-0000-0000-0000-0000000000aa',
  jsonb_build_array(pg_temp.ins('one', '00000000-0000-0000-0000-0000000000a1', 1)), '[]'), '%transactions_plaid_transaction_id_key%');
