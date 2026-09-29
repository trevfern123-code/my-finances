-- Pending -> posted continuity: the category protocol (design §6, §6.1, §6.2) and the mutation RPCs.
--   * ACL: the five RPCs are service_role only; the trigger function is executable by nobody.
--   * budget_category_set_seq differs on EVERY new-backend category write — proven inside one
--     transaction, where now() would not differ (Codex cleanup point 1).
--   * K18: the mapping backfill skips user-cleared rows and carry-overs, labels what it fills.
--   * K20/K20b: an old backend's stamp-less UPDATE cannot fill a new-backend clear (the trigger pins it),
--     while the documented degradations still behave as today.
--   * replace_transaction_splits is atomic; approve_transaction clears the note.
set role service_role;

insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-0000000007a1', '00000000-0000-0000-0000-000000000001', 'acct-c7', 'Checking', 'depository'),
  ('00000000-0000-0000-0000-0000000007a9', '00000000-0000-0000-0000-000000000002', 'acct-b7', 'BB Checking', 'depository');
insert into public.budget_categories (id, user_id, name) values
  ('00000000-0000-0000-0000-0000000007c1', '00000000-0000-0000-0000-0000000000aa', 'Dining'),
  ('00000000-0000-0000-0000-0000000007c2', '00000000-0000-0000-0000-0000000000aa', 'Groceries'),
  ('00000000-0000-0000-0000-0000000007c9', '00000000-0000-0000-0000-0000000000bb', 'BB category');

create function pg_temp.row(p_id text, p_plaid text, p_amount numeric, p_pending boolean default false, p_plaid_category text default 'FOOD_AND_DRINK') returns void
language sql as $$
  insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name, pending, category,
    auto_role, role_source, role_confidence, classifier_version)
  values (p_id::uuid, '00000000-0000-0000-0000-0000000007a1', p_plaid, p_amount, '2026-09-10', 'Row ' || p_plaid, p_pending, p_plaid_category,
    'expense', 'sign_default', 'low', 1)
$$;
create function pg_temp.cat(p_id text) returns uuid language sql as $$ select budget_category_id from public.transactions where id = p_id::uuid $$;
create function pg_temp.src(p_id text) returns text language sql as $$ select budget_category_source from public.transactions where id = p_id::uuid $$;
create function pg_temp.seq(p_id text) returns bigint language sql as $$ select budget_category_set_seq from public.transactions where id = p_id::uuid $$;

-- ---- ACL -------------------------------------------------------------------------------------------
select th.assert(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
    and p.proname in ('apply_synced_transaction_batch_v2', 'set_transaction_budget_category', 'approve_transaction',
                      'replace_transaction_splits', 'backfill_category_mapping')
    and has_function_privilege('service_role', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute')
    and not has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('public', p.oid, 'execute')) = 5,
  'ACL: the five RPCs are service_role only');
select th.assert(not has_function_privilege('service_role', 'public.transactions_keep_user_cleared_category()', 'execute')
             and not has_function_privilege('authenticated', 'public.transactions_keep_user_cleared_category()', 'execute'),
  'ACL: the trigger function is executable by nobody');
select th.assert(not has_table_privilege('authenticated', 'public.transaction_carryovers', 'select')
             and not has_table_privilege('anon', 'public.transaction_carryovers', 'select')
             and has_table_privilege('service_role', 'public.transaction_carryovers', 'delete'),
  'ACL: transaction_carryovers is service_role only');
select th.assert((select count(*) from pg_indexes where schemaname = 'public'
                    and indexname in ('transactions_pending_transaction_id_idx',
                                      'transaction_carryovers_user_expiry_idx',
                                      'transaction_carryovers_account_idx',
                                      'transaction_carryovers_budget_category_idx',
                                      'transaction_carryovers_manual_loan_idx',
                                      'transaction_carryovers_consumed_transaction_idx')) = 6,
  'schema: all six continuity indexes exist, including every carry-over FK delete path');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa","role":"authenticated"}', true);
select th.expect_error($q$ select public.set_transaction_budget_category('00000000-0000-0000-0000-0000000000aa', gen_random_uuid(), null) $q$, '%permission denied%');
select th.expect_error($q$ select public.backfill_category_mapping('00000000-0000-0000-0000-0000000000aa', 'X', gen_random_uuid()) $q$, '%permission denied%');
select th.expect_error($q$ select * from public.transaction_carryovers $q$, '%permission denied%');
reset role;
set role service_role;

-- ---- The protocol marker differs on every write, even inside one transaction ------------------------
select pg_temp.row('00000000-0000-0000-0000-00000000071a', 's1', 10);
begin;
select public.set_transaction_budget_category('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-00000000071a', '00000000-0000-0000-0000-0000000007c1');
create temporary table seq1 as select pg_temp.seq('00000000-0000-0000-0000-00000000071a') as v;
select public.set_transaction_budget_category('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-00000000071a', null);
create temporary table seq2 as select pg_temp.seq('00000000-0000-0000-0000-00000000071a') as v;
select public.set_transaction_budget_category('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-00000000071a', '00000000-0000-0000-0000-0000000007c2');
create temporary table seq3 as select pg_temp.seq('00000000-0000-0000-0000-00000000071a') as v;
commit;
select th.assert((select v from seq1) < (select v from seq2) and (select v from seq2) < (select v from seq3),
  'marker: three writes in one transaction took three strictly increasing values (now() would be identical here)');
select th.assert(pg_temp.cat('00000000-0000-0000-0000-00000000071a') = '00000000-0000-0000-0000-0000000007c2' and pg_temp.src('00000000-0000-0000-0000-00000000071a') = 'user',
  'marker: the cleared-then-recategorised row ended with the user''s Groceries (the trigger let the stamped write through)');

-- ---- K18: the mapping backfill skips user clears (rows and carry-overs), labels its fills ------------
select pg_temp.row('00000000-0000-0000-0000-000000000781', 'r1', 10);
select pg_temp.row('00000000-0000-0000-0000-000000000782', 'r2', 10);
select pg_temp.row('00000000-0000-0000-0000-000000000783', 'r3', 10);
select pg_temp.row('00000000-0000-0000-0000-000000000784', 'r4', 10);
select pg_temp.row('00000000-0000-0000-0000-000000000785', 'r5', 10, false, 'GENERAL_MERCHANDISE');
select public.set_transaction_budget_category('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000781', null);   -- R1: cleared via the new RPC
update public.transactions set budget_category_source = 'mapping' where id = '00000000-0000-0000-0000-000000000783';                    -- R3: an old-backend clear (stale label)
select public.set_transaction_budget_category('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000784', '00000000-0000-0000-0000-0000000007c1'); -- R4: Dining/user
-- Carry-overs V1 (cleared via the RPC) and V2 (never categorised): pending rows removed before posting.
select pg_temp.row('00000000-0000-0000-0000-00000000078a', 'v1', 10, true);
select pg_temp.row('00000000-0000-0000-0000-00000000078b', 'v2', 10, true);
select public.set_transaction_budget_category('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-00000000078a', null);
select public.apply_synced_transaction_batch_v2('00000000-0000-0000-0000-0000000000aa', '[]', '[]', array['v1', 'v2']);
select th.assert((select count(*) from public.transaction_carryovers where pending_plaid_transaction_id in ('v1', 'v2') and consumed_at is null) = 2, 'K18: two unconsumed carry-overs');

select th.assert(public.backfill_category_mapping('00000000-0000-0000-0000-0000000000aa', 'FOOD_AND_DRINK', '00000000-0000-0000-0000-0000000007c2') = 2,
  'K18: exactly R2 and R3 were filled (return value 2)');
select th.assert(pg_temp.cat('00000000-0000-0000-0000-000000000781') is null and pg_temp.src('00000000-0000-0000-0000-000000000781') = 'user', 'K18: R1 (user clear) untouched');
select th.assert(pg_temp.cat('00000000-0000-0000-0000-000000000782') = '00000000-0000-0000-0000-0000000007c2' and pg_temp.src('00000000-0000-0000-0000-000000000782') = 'mapping'
                 and pg_temp.seq('00000000-0000-0000-0000-000000000782') is not null, 'K18: R2 filled, labelled, stamped');
select th.assert(pg_temp.cat('00000000-0000-0000-0000-000000000783') = '00000000-0000-0000-0000-0000000007c2' and pg_temp.src('00000000-0000-0000-0000-000000000783') = 'mapping', 'K18: R3 (old-backend clear) filled — the documented degradation');
select th.assert(pg_temp.cat('00000000-0000-0000-0000-000000000784') = '00000000-0000-0000-0000-0000000007c1', 'K18: R4 untouched');
select th.assert(pg_temp.cat('00000000-0000-0000-0000-000000000785') is null, 'K18: a different Plaid category untouched');
select th.assert((select budget_category_id is null and budget_category_source = 'user' from public.transaction_carryovers where pending_plaid_transaction_id = 'v1'), 'K18: V1 (user clear) untouched');
select th.assert((select budget_category_id = '00000000-0000-0000-0000-0000000007c2' and budget_category_source = 'mapping' and budget_category_set_seq is not null
                  from public.transaction_carryovers where pending_plaid_transaction_id = 'v2'), 'K18: V2 filled, labelled, stamped');
-- Backfill-first order of K19: the filled carry-over posts with the mapping's category.
select public.apply_synced_transaction_batch_v2('00000000-0000-0000-0000-0000000000aa',
  jsonb_build_array(jsonb_build_object('plaid_transaction_id', 'v2q', 'account_id', '00000000-0000-0000-0000-0000000007a1', 'amount', 10, 'iso_currency_code', 'USD',
    'date', '2026-09-12', 'name', 'Row v2q', 'merchant_name', null, 'category', 'FOOD_AND_DRINK', 'personal_finance_category_detailed', null,
    'personal_finance_category_confidence', null, 'plaid_category', null, 'pending', false, 'needs_review', true, 'budget_category_id', null,
    'auto_role', 'expense', 'role_source', 'sign_default', 'role_confidence', 'low', 'classifier_version', 1, 'pending_transaction_id', 'v2')), '[]', '{}');
select th.assert((select budget_category_id = '00000000-0000-0000-0000-0000000007c2' and budget_category_source = 'mapping' from public.transactions where plaid_transaction_id = 'v2q'),
  'K19 (backfill first): the posted row carries the backfilled category');
select th.expect_error($q$ select public.backfill_category_mapping('00000000-0000-0000-0000-0000000000aa', 'FOOD_AND_DRINK', '00000000-0000-0000-0000-0000000007c9') $q$,
  'budget_category_not_found:%');
select th.assert(public.backfill_category_mapping('00000000-0000-0000-0000-0000000000bb', 'FOOD_AND_DRINK', '00000000-0000-0000-0000-0000000007c9') = 0,
  'K18: bb''s backfill cannot reach aa''s rows');

-- ---- K20: an old backend's stamp-less backfill cannot fill a new-backend clear ------------------------
select pg_temp.row('00000000-0000-0000-0000-000000000791', 'k1', 10);
select pg_temp.row('00000000-0000-0000-0000-000000000792', 'k2', 10);
select pg_temp.row('00000000-0000-0000-0000-000000000793', 'k3', 10);
select public.set_transaction_budget_category('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000791', null);  -- k1: NULL/'user'/stamped
update public.transactions set budget_category_source = 'mapping' where id = '00000000-0000-0000-0000-000000000793';                   -- k3: NULL/'mapping'
create temporary table k1seq as select pg_temp.seq('00000000-0000-0000-0000-000000000791') as v;
-- The old backend's backfill: today's exact statement shape, no stamp.
update public.transactions set budget_category_id = '00000000-0000-0000-0000-0000000007c2'
where id in ('00000000-0000-0000-0000-000000000791', '00000000-0000-0000-0000-000000000792', '00000000-0000-0000-0000-000000000793');
select th.assert(pg_temp.cat('00000000-0000-0000-0000-000000000791') is null and pg_temp.src('00000000-0000-0000-0000-000000000791') = 'user'
                 and pg_temp.seq('00000000-0000-0000-0000-000000000791') = (select v from k1seq), 'K20: k1 pinned at NULL / user / same stamp');
select th.assert(pg_temp.cat('00000000-0000-0000-0000-000000000792') = '00000000-0000-0000-0000-0000000007c2' and pg_temp.src('00000000-0000-0000-0000-000000000792') is null, 'K20: k2 (null label) filled as today');
select th.assert(pg_temp.cat('00000000-0000-0000-0000-000000000793') = '00000000-0000-0000-0000-0000000007c2' and pg_temp.src('00000000-0000-0000-0000-000000000793') = 'mapping', 'K20: k3 (stale mapping label) filled as today');
-- The statement succeeded (no RAISE) — proven by reaching here. The new backend re-categorises k1 freely:
select public.set_transaction_budget_category('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000791', '00000000-0000-0000-0000-0000000007c1');
select th.assert(pg_temp.cat('00000000-0000-0000-0000-000000000791') = '00000000-0000-0000-0000-0000000007c1' and pg_temp.seq('00000000-0000-0000-0000-000000000791') > (select v from k1seq),
  'K20: a stamped write passes the trigger');

-- K20b: the accepted limitation — the old category endpoint (also stamp-less) cannot re-categorise a
-- new-backend clear, while the same statement on a null-labelled row succeeds, and a labelled non-null
-- row is not the pinned transition.
select pg_temp.row('00000000-0000-0000-0000-000000000794', 'k4', 10);
select pg_temp.row('00000000-0000-0000-0000-000000000795', 'k5', 10);
select public.set_transaction_budget_category('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000794', null);
update public.transactions set budget_category_id = '00000000-0000-0000-0000-0000000007c1' where id = '00000000-0000-0000-0000-000000000794';
select th.assert(pg_temp.cat('00000000-0000-0000-0000-000000000794') is null, 'K20b: pinned (documented limitation, rollback window only)');
update public.transactions set budget_category_id = '00000000-0000-0000-0000-0000000007c1' where id = '00000000-0000-0000-0000-000000000795';
select th.assert(pg_temp.cat('00000000-0000-0000-0000-000000000795') = '00000000-0000-0000-0000-0000000007c1', 'K20b: a null-labelled row is filled');
update public.transactions set budget_category_id = '00000000-0000-0000-0000-0000000007c2' where id = '00000000-0000-0000-0000-000000000784';   -- R4 Dining/user -> Groceries
select th.assert(pg_temp.cat('00000000-0000-0000-0000-000000000784') = '00000000-0000-0000-0000-0000000007c2', 'K20b: changing a non-null user category is not pinned');

-- ---- replace_transaction_splits: atomic, validated; approve clears the note ---------------------------
select pg_temp.row('00000000-0000-0000-0000-0000000007d1', 'sp1', 50);
select th.assert((select count(*) from public.replace_transaction_splits('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000007d1',
  '[{"budget_category_id":"00000000-0000-0000-0000-0000000007c1","amount":30,"note":null},{"budget_category_id":"00000000-0000-0000-0000-0000000007c2","amount":20,"note":"x"}]')) = 2,
  'splits: two rows inserted');
select th.expect_error($q$ select * from public.replace_transaction_splits('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000007d1',
  '[{"budget_category_id":"00000000-0000-0000-0000-0000000007c1","amount":30,"note":null},{"budget_category_id":"00000000-0000-0000-0000-0000000007c9","amount":20,"note":null}]') $q$,
  'splits_invalid:%');
select th.assert((select count(*) from public.transaction_splits where transaction_id = '00000000-0000-0000-0000-0000000007d1') = 2
             and (select sum(amount) from public.transaction_splits where transaction_id = '00000000-0000-0000-0000-0000000007d1') = 50,
  'splits: a rejected replacement (another user''s category in the LAST split) left the original two intact — atomic');
select th.expect_error($q$ select * from public.replace_transaction_splits('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000007d1',
  '[{"budget_category_id":"00000000-0000-0000-0000-0000000007c1","amount":30,"note":null}]') $q$, 'splits_unbalanced:%');
select th.expect_error($q$ select * from public.replace_transaction_splits('00000000-0000-0000-0000-0000000000bb', '00000000-0000-0000-0000-0000000007d1', '[]') $q$, 'transaction_not_found:%');
select * from public.replace_transaction_splits('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000007d1', '[]');
select th.assert(not exists (select 1 from public.transaction_splits where transaction_id = '00000000-0000-0000-0000-0000000007d1'), 'splits: an empty array clears');

update public.transactions set needs_review = true, review_note = 'Amount changed from 1.00 to 2.00' where id = '00000000-0000-0000-0000-0000000007d1';
select public.approve_transaction('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000007d1');
select th.assert((select needs_review = false and review_note is null from public.transactions where id = '00000000-0000-0000-0000-0000000007d1'), 'approve clears needs_review and the note');
select th.expect_error($q$ select public.approve_transaction('00000000-0000-0000-0000-0000000000bb', '00000000-0000-0000-0000-0000000007d1') $q$, 'transaction_not_found:%');
select th.expect_error($q$ select public.set_transaction_budget_category('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000007d1', '00000000-0000-0000-0000-0000000007c9') $q$,
  'budget_category_not_found:%');
