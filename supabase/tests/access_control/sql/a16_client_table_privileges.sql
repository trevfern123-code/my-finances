-- Client table privilege hardening (20261003120000). For the five targets (transactions, accounts,
-- transaction_splits, manual_loans, budget_categories):
--   * anon, authenticated and PUBLIC hold none of INSERT/UPDATE/DELETE/TRUNCATE/TRIGGER/REFERENCES/MAINTAIN,
--     at table or column level; the check is shown to detect a re-granted privilege;
--   * TRUNCATE and DML are refused with a PERMISSION error, not a foreign-key error or a zero-row result;
--   * intended reads and RLS isolation are unchanged;
--   * the backend's service-role write paths still change the intended rows, and still refuse other
--     users' rows;
--   * future tables created by postgres in public get no client write privilege.
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-0000000a1601', '00000000-0000-0000-0000-000000000001', 'a16-ac', 'AA Checking', 'depository'),
  ('00000000-0000-0000-0000-0000000b1601', '00000000-0000-0000-0000-000000000002', 'a16-bc', 'BB Checking', 'depository');
insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name, needs_review, auto_role, role_source, role_confidence, classifier_version) values
  ('00000000-0000-0000-0000-0000000a1611', '00000000-0000-0000-0000-0000000a1601', 'a16-t1', 50, '2026-09-01', 'Coffee', true, 'expense', 'sign_default', 'low', 1),
  ('00000000-0000-0000-0000-0000000a1612', '00000000-0000-0000-0000-0000000a1601', 'a16-t2', 120, '2026-09-02', 'Loan payment', false, 'expense', 'sign_default', 'low', 1),
  ('00000000-0000-0000-0000-0000000b1611', '00000000-0000-0000-0000-0000000b1601', 'a16-tb', 70, '2026-09-03', 'BB row', false, 'expense', 'sign_default', 'low', 1);
insert into public.budget_categories (id, user_id, name) values
  ('00000000-0000-0000-0000-0000000a16c1', '00000000-0000-0000-0000-0000000000aa', 'A16 Food'),
  ('00000000-0000-0000-0000-0000000b16c1', '00000000-0000-0000-0000-0000000000bb', 'A16 BB Food');
insert into public.manual_loans (id, user_id, name, current_balance) values
  ('00000000-0000-0000-0000-0000000a16d1', '00000000-0000-0000-0000-0000000000aa', 'A16 loan', 1000),
  ('00000000-0000-0000-0000-0000000b16d1', '00000000-0000-0000-0000-0000000000bb', 'A16 BB loan', 500);
insert into public.transaction_splits (transaction_id, budget_category_id, amount) values
  ('00000000-0000-0000-0000-0000000b1611', '00000000-0000-0000-0000-0000000b16c1', 70);
insert into public.transaction_carryovers (user_id, account_id, pending_plaid_transaction_id, pending_transaction_row_id,
                                           pending_amount, pending_date, needs_review, expires_at) values
  ('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000a1601', 'a16-pend', gen_random_uuid(), 9, '2026-09-01', false, now() - interval '1 day');

-- Every targeted privilege a client role (or PUBLIC) still holds on a target; '' when none.
create function pg_temp.client_write_privs() returns text language sql as $$
  select coalesce(string_agg(format('%s %s %s', t, r, p), '; ' order by t, r, p), '')
  from unnest(array['public.transactions', 'public.accounts', 'public.transaction_splits', 'public.manual_loans',
                    'public.budget_categories']) t
  cross join unnest(array['anon', 'authenticated', 'public']) r
  cross join unnest(array['insert', 'update', 'delete', 'truncate', 'trigger', 'references', 'maintain']) p
  where has_table_privilege(r, t::regclass, p)
     or (p in ('insert', 'update', 'references') and has_any_column_privilege(r, t::regclass, p)) $$;

-- ---- Catalog ------------------------------------------------------------------------------------------------------
select th.assert(pg_temp.client_write_privs() = '', 'no client role or PUBLIC holds a targeted privilege on the five tables: ' || pg_temp.client_write_privs());
select th.assert((select count(*) from pg_attribute where attrelid in ('public.transactions'::regclass, 'public.accounts'::regclass,
                    'public.transaction_splits'::regclass, 'public.manual_loans'::regclass, 'public.budget_categories'::regclass)
                    and attnum > 0 and attacl is not null) = 0, 'no column-level grants on the five tables');
select th.assert((select bool_and(has_table_privilege(r, t::regclass, 'select'))
                  from unnest(array['public.transactions', 'public.accounts', 'public.transaction_splits', 'public.manual_loans',
                                    'public.budget_categories']) t cross join unnest(array['anon', 'authenticated']) r),
  'SELECT for anon and authenticated is kept (RLS still decides which rows)');
select th.assert((select bool_and(has_table_privilege('service_role', t::regclass, p))
                  from unnest(array['public.transactions', 'public.accounts', 'public.transaction_splits', 'public.manual_loans',
                                    'public.budget_categories']) t
                  cross join unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'trigger', 'references', 'maintain']) p),
  'service_role keeps every privilege on the five tables');
select th.assert((select bool_and(relrowsecurity) from pg_class where oid in ('public.transactions'::regclass, 'public.accounts'::regclass,
                    'public.transaction_splits'::regclass, 'public.manual_loans'::regclass, 'public.budget_categories'::regclass))
                 and (select count(*) from pg_policy where polrelid in ('public.budget_categories'::regclass, 'public.manual_loans'::regclass) and polcmd = 'r') = 2
                 and not exists (select 1 from pg_policy where polrelid in ('public.transactions'::regclass, 'public.accounts'::regclass, 'public.transaction_splits'::regclass)),
  'RLS stays enabled with the same policies');

-- Negative control: the check detects a re-granted TRUNCATE (rolled back; nothing is broadened).
begin;
grant truncate on public.transaction_splits to authenticated;
select th.assert(pg_temp.client_write_privs() = 'public.transaction_splits authenticated truncate',
  'negative control: a re-granted TRUNCATE is detected (' || pg_temp.client_write_privs() || ')');
rollback;
select th.assert(pg_temp.client_write_privs() = '', 'negative control rolled back');

-- ---- Refusals: a PERMISSION error for TRUNCATE and DML, for both client roles ------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000aa","role":"authenticated"}';
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000aa';
select th.expect_error('truncate public.transaction_splits', '%permission denied for table transaction_splits%');
select th.expect_error('truncate public.transactions', '%permission denied for table transactions%');
select th.expect_error('truncate public.accounts', '%permission denied for table accounts%');
select th.expect_error('truncate public.manual_loans', '%permission denied for table manual_loans%');
select th.expect_error('truncate public.budget_categories', '%permission denied for table budget_categories%');
select th.expect_error($q$ update public.transactions set amount = amount + 1 where id = '00000000-0000-0000-0000-0000000a1611' $q$, '%permission denied for table transactions%');
select th.expect_error($q$ update public.transactions set needs_review = false where id = '00000000-0000-0000-0000-0000000a1611' $q$, '%permission denied for table transactions%');
select th.expect_error($q$ insert into public.transactions (account_id, plaid_transaction_id, amount, date) values ('00000000-0000-0000-0000-0000000a1601', 'a16-x', 1, '2026-09-09') $q$, '%permission denied for table transactions%');
select th.expect_error($q$ delete from public.transactions where id = '00000000-0000-0000-0000-0000000a1611' $q$, '%permission denied for table transactions%');
select th.expect_error($q$ update public.accounts set exclude_from_cash_flow = true where id = '00000000-0000-0000-0000-0000000a1601' $q$, '%permission denied for table accounts%');
select th.expect_error($q$ update public.accounts set nickname = 'n' where id = '00000000-0000-0000-0000-0000000a1601' $q$, '%permission denied for table accounts%');
select th.expect_error($q$ insert into public.transaction_splits (transaction_id, budget_category_id, amount) values ('00000000-0000-0000-0000-0000000a1611', '00000000-0000-0000-0000-0000000a16c1', 50) $q$, '%permission denied for table transaction_splits%');
select th.expect_error($q$ update public.manual_loans set current_balance = 0 where id = '00000000-0000-0000-0000-0000000a16d1' $q$, '%permission denied for table manual_loans%');
select th.expect_error($q$ delete from public.budget_categories where id = '00000000-0000-0000-0000-0000000a16c1' $q$, '%permission denied for table budget_categories%');
-- Reads are unchanged: owner-only rows where a policy exists, no rows where none does.
select th.assert((select count(*) from public.budget_categories) = 1 and (select id from public.budget_categories) = '00000000-0000-0000-0000-0000000a16c1',
  'authenticated reads only its own budget category');
select th.assert((select count(*) from public.manual_loans) = 1 and (select id from public.manual_loans) = '00000000-0000-0000-0000-0000000a16d1',
  'authenticated reads only its own manual loan');
select th.assert((select count(*) from public.transactions) = 0 and (select count(*) from public.accounts) = 0
                 and (select count(*) from public.transaction_splits) = 0, 'no rows of the policy-less tables are readable');
rollback;
begin;
set local role anon;
select th.expect_error('truncate public.transaction_splits', '%permission denied for table transaction_splits%');
select th.expect_error('truncate public.transactions', '%permission denied for table transactions%');
select th.expect_error('truncate public.accounts', '%permission denied for table accounts%');
select th.expect_error('truncate public.manual_loans', '%permission denied for table manual_loans%');
select th.expect_error('truncate public.budget_categories', '%permission denied for table budget_categories%');
select th.expect_error($q$ update public.transactions set amount = amount + 1 $q$, '%permission denied for table transactions%');
select th.assert((select count(*) from public.budget_categories) = 0 and (select count(*) from public.manual_loans) = 0
                 and (select count(*) from public.transactions) = 0, 'anon reads no rows');
rollback;
select th.assert((select count(*) from public.transaction_splits where transaction_id = '00000000-0000-0000-0000-0000000b1611') = 1,
  'the other user''s split is intact');

-- ---- Supported writes: the backend's service-role paths still change the intended rows ---------------------------------
set role service_role;
select public.set_transaction_budget_category('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000a1611', '00000000-0000-0000-0000-0000000a16c1');
select th.assert((select budget_category_id from public.transactions where id = '00000000-0000-0000-0000-0000000a1611') = '00000000-0000-0000-0000-0000000a16c1',
  'category: set_transaction_budget_category changed the row');
select public.approve_transaction('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000a1611');
select th.assert(not (select needs_review from public.transactions where id = '00000000-0000-0000-0000-0000000a1611'), 'approval: approve_transaction changed the row');
select count(*) from public.replace_transaction_splits('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000a1611',
  '[{"budget_category_id":"00000000-0000-0000-0000-0000000a16c1","amount":50,"note":null}]'::jsonb);
select th.assert((select count(*) from public.transaction_splits where transaction_id = '00000000-0000-0000-0000-0000000a1611') = 1,
  'splits: replace_transaction_splits wrote the split');
select th.assert(public.link_transaction_to_manual_loan('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000a1612',
                   '00000000-0000-0000-0000-0000000a16d1', 20, 1::smallint) = 'linked', 'loan link: link_transaction_to_manual_loan reports linked');
-- (A separate statement: a subquery in the calling statement reads that statement's snapshot, before the call's write.)
select th.assert((select manual_loan_id from public.transactions where id = '00000000-0000-0000-0000-0000000a1612') = '00000000-0000-0000-0000-0000000a16d1',
  'loan link: link_transaction_to_manual_loan linked the row');
select public.update_linked_payment_principal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000a1612', '00000000-0000-0000-0000-0000000a16d1', 30);
select th.assert((select principal_portion from public.transactions where id = '00000000-0000-0000-0000-0000000a1612') = 30,
  'loan payment edit: update_linked_payment_principal changed the row');
select th.assert(public.unlink_transaction_from_manual_loan('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000a1612',
                   '00000000-0000-0000-0000-0000000a16d1', 'expense', 'sign_default', 'low', 1::smallint), 'loan unlink: unlink_transaction_from_manual_loan reports success');
select th.assert((select manual_loan_id from public.transactions where id = '00000000-0000-0000-0000-0000000a1612') is null,
  'loan unlink: unlink_transaction_from_manual_loan unlinked the row');
select public.apply_synced_transaction_batch_v2('00000000-0000-0000-0000-0000000000aa',
  jsonb_build_array(jsonb_build_object('plaid_transaction_id', 'a16-sync', 'account_id', '00000000-0000-0000-0000-0000000a1601', 'amount', 12,
    'iso_currency_code', 'USD', 'date', '2026-09-10', 'name', 'Synced', 'merchant_name', null, 'category', null,
    'personal_finance_category_detailed', null, 'personal_finance_category_confidence', null, 'plaid_category', null, 'pending', false,
    'needs_review', false, 'budget_category_id', null, 'auto_role', 'expense', 'role_source', 'sign_default', 'role_confidence', 'low',
    'classifier_version', 1, 'pending_transaction_id', null)), '[]'::jsonb, '{}'::text[]);
select th.assert((select count(*) from public.transactions where plaid_transaction_id = 'a16-sync') = 1, 'sync: apply_synced_transaction_batch_v2 inserted the row');
update public.accounts set exclude_from_cash_flow = true where id = '00000000-0000-0000-0000-0000000a1601';
select th.assert((select exclude_from_cash_flow from public.accounts where id = '00000000-0000-0000-0000-0000000a1601'),
  'cash-flow inclusion: the backend''s direct accounts update changed the row');
delete from public.transaction_carryovers where user_id = '00000000-0000-0000-0000-0000000000aa' and consumed_at is null and expires_at < now();
select th.assert(not exists (select 1 from public.transaction_carryovers where pending_plaid_transaction_id = 'a16-pend'),
  'carry-over cleanup: the sweep deleted the expired row');
-- Ownership negatives through the same functions (as bb, on aa's rows).
select th.expect_error($q$ select public.set_transaction_budget_category('00000000-0000-0000-0000-0000000000bb', '00000000-0000-0000-0000-0000000a1611', '00000000-0000-0000-0000-0000000b16c1') $q$, '%not found or not owned by user%');
select th.expect_error($q$ select public.approve_transaction('00000000-0000-0000-0000-0000000000bb', '00000000-0000-0000-0000-0000000a1611') $q$, '%not found or not owned by user%');
select th.expect_error($q$ select public.replace_transaction_splits('00000000-0000-0000-0000-0000000000bb', '00000000-0000-0000-0000-0000000a1611', '[{"budget_category_id":"00000000-0000-0000-0000-0000000b16c1","amount":50,"note":null}]'::jsonb) $q$, '%not found or not owned by user%');
select th.expect_error($q$ select public.link_transaction_to_manual_loan('00000000-0000-0000-0000-0000000000bb', '00000000-0000-0000-0000-0000000a1612', '00000000-0000-0000-0000-0000000a16d1', 20, 1::smallint) $q$, '%not found or not owned by user%');
select th.expect_error($q$ select public.apply_synced_transaction_batch_v2('00000000-0000-0000-0000-0000000000bb', jsonb_build_array(jsonb_build_object('plaid_transaction_id', 'a16-sync-x', 'account_id', '00000000-0000-0000-0000-0000000a1601', 'amount', 12, 'iso_currency_code', 'USD', 'date', '2026-09-10', 'name', 'Synced', 'merchant_name', null, 'category', null, 'personal_finance_category_detailed', null, 'personal_finance_category_confidence', null, 'plaid_category', null, 'pending', false, 'needs_review', false, 'budget_category_id', null, 'auto_role', 'expense', 'role_source', 'sign_default', 'role_confidence', 'low', 'classifier_version', 1, 'pending_transaction_id', null)), '[]'::jsonb, '{}'::text[]) $q$, '%account not owned%');
reset role;

-- ---- Defaults: a new table created by postgres (the migration owner) in public -------------------------------------------
create table public.a16_default_probe (id integer);
select th.assert((select coalesce(string_agg(format('%s %s', r, p), ', '), '') from unnest(array['anon', 'authenticated', 'public']) r
                  cross join unnest(array['insert', 'update', 'delete', 'truncate', 'trigger', 'references', 'maintain']) p
                  where has_table_privilege(r, 'public.a16_default_probe'::regclass, p)) = '',
  'a future postgres-owned table in public grants no client write privilege');
select th.assert(has_table_privilege('anon', 'public.a16_default_probe'::regclass, 'select')
                 and has_table_privilege('authenticated', 'public.a16_default_probe'::regclass, 'select'),
  'its SELECT default for anon and authenticated is kept');
select th.assert((select bool_and(has_table_privilege('service_role', 'public.a16_default_probe'::regclass, p))
                  from unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'trigger', 'references', 'maintain']) p),
  'its service_role defaults are kept');
drop table public.a16_default_probe;
