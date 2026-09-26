-- 20260926120000_linked_institution_management.sql: the removal state machine and exact manual-loan
-- restoration, against the real schema and the real link function.
--
-- Fixture (user aa): item 1 (the one removed) with accounts R1 and R2; item 3 (kept) with account K1.
-- Loans L1 (1000), L2 (50), L3 (500). On item 1: T1 linked to L1 (100); a pending T2 and its posted T3,
-- BOTH linked to L1 (100 each — transaction lineage is irrelevant: both applied, both are restored);
-- T4 linked to L2 at principal 100 but clamped to the 50 balance; T5 unlinked, with a split. On
-- item 3: T6 linked to L1 (200) — must survive untouched. User bb: item 2, account B1, T9 linked to
-- their own loan LB. Item 1 also has a recurring stream and a liability record; L3 has a manual payment.
set role service_role;

insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000aa', 'harness-item-a3', 'placeholder-token-a3', 'Kept Bank');
update public.plaid_items set institution_name = 'Removed Bank' where id = '00000000-0000-0000-0000-000000000001';
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-0000000004a1', '00000000-0000-0000-0000-000000000001', 'acct-r1', 'Removed Checking', 'depository'),
  ('00000000-0000-0000-0000-0000000004a2', '00000000-0000-0000-0000-000000000001', 'acct-r2', 'Removed Card', 'credit'),
  ('00000000-0000-0000-0000-0000000004a3', '00000000-0000-0000-0000-000000000003', 'acct-k1', 'Kept Checking', 'depository'),
  ('00000000-0000-0000-0000-0000000004a9', '00000000-0000-0000-0000-000000000002', 'acct-b1', 'BB Checking', 'depository');
insert into public.manual_loans (id, user_id, name, current_balance) values
  ('00000000-0000-0000-0000-0000000004b1', '00000000-0000-0000-0000-0000000000aa', 'L1', 1000),
  ('00000000-0000-0000-0000-0000000004b2', '00000000-0000-0000-0000-0000000000aa', 'L2', 50),
  ('00000000-0000-0000-0000-0000000004b3', '00000000-0000-0000-0000-0000000000aa', 'L3', 500),
  ('00000000-0000-0000-0000-0000000004b9', '00000000-0000-0000-0000-0000000000bb', 'LB', 300);
insert into public.budget_categories (id, user_id, name) values
  ('00000000-0000-0000-0000-0000000004c1', '00000000-0000-0000-0000-0000000000aa', 'AA category');

create function pg_temp.txn(p_id text, p_account text, p_plaid text, p_amount numeric, p_pending boolean default false) returns void
language sql as $$
  insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name, pending,
    auto_role, role_source, role_confidence, classifier_version)
  values (p_id::uuid, p_account::uuid, p_plaid, p_amount, '2026-09-10', 'Payment ' || p_plaid, p_pending,
    'expense', 'sign_default', 'low', 1)
$$;
create function pg_temp.link(p_user text, p_txn text, p_loan text, p_principal numeric) returns void
language plpgsql as $$
begin
  perform th.assert(public.link_transaction_to_manual_loan(p_user::uuid, p_txn::uuid, p_loan::uuid, p_principal, 1::smallint) = 'linked',
    'fixture link ' || p_txn);
end $$;
create function pg_temp.balance(p_loan text) returns numeric language sql as
  $$ select current_balance from public.manual_loans where id = p_loan::uuid $$;

select pg_temp.txn('00000000-0000-0000-0000-0000000004d1', '00000000-0000-0000-0000-0000000004a1', 'r-t1', 100);
select pg_temp.txn('00000000-0000-0000-0000-0000000004d2', '00000000-0000-0000-0000-0000000004a1', 'r-t2-pending', 100, true);
select pg_temp.txn('00000000-0000-0000-0000-0000000004d3', '00000000-0000-0000-0000-0000000004a1', 'r-t3-posted', 100);
select pg_temp.txn('00000000-0000-0000-0000-0000000004d4', '00000000-0000-0000-0000-0000000004a2', 'r-t4', 100);
select pg_temp.txn('00000000-0000-0000-0000-0000000004d5', '00000000-0000-0000-0000-0000000004a1', 'r-t5', 40);
select pg_temp.txn('00000000-0000-0000-0000-0000000004d6', '00000000-0000-0000-0000-0000000004a3', 'k-t6', 200);
select pg_temp.txn('00000000-0000-0000-0000-0000000004d9', '00000000-0000-0000-0000-0000000004a9', 'b-t9', 50);
select pg_temp.link('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000004d1', '00000000-0000-0000-0000-0000000004b1', 100);
select pg_temp.link('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000004d2', '00000000-0000-0000-0000-0000000004b1', 100);
select pg_temp.link('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000004d3', '00000000-0000-0000-0000-0000000004b1', 100);
select pg_temp.link('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000004d4', '00000000-0000-0000-0000-0000000004b2', 100);
select pg_temp.link('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000004d6', '00000000-0000-0000-0000-0000000004b1', 200);
select pg_temp.link('00000000-0000-0000-0000-0000000000bb', '00000000-0000-0000-0000-0000000004d9', '00000000-0000-0000-0000-0000000004b9', 50);
select public.create_manual_loan_payment('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000004b3', '2026-09-10', 60, 0, null);
insert into public.transaction_splits (transaction_id, budget_category_id, amount) values
  ('00000000-0000-0000-0000-0000000004d5', '00000000-0000-0000-0000-0000000004c1', 40);
insert into public.recurring_streams (item_id, account_id, plaid_stream_id, description, direction, frequency,
  average_amount, last_amount, first_date, last_date, status) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000004a1', 'stream-r', 'Rent', 'outflow', 'MONTHLY', 10, 10, '2026-01-01', '2026-09-01', 'MATURE');
insert into public.loans (item_id, account_id, plaid_account_id, loan_type) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000004a2', 'acct-r2', 'credit');

select th.assert(pg_temp.balance('00000000-0000-0000-0000-0000000004b1') = 500, 'fixture: L1 1000 - 100 - 100 - 100 - 200');
select th.assert(pg_temp.balance('00000000-0000-0000-0000-0000000004b2') = 0, 'fixture: L2 clamped at zero (applied 50 of 100)');
select th.assert((select loan_balance_applied from public.transactions where id = '00000000-0000-0000-0000-0000000004d4') = 50, 'fixture: T4 applied 50');
select th.assert(pg_temp.balance('00000000-0000-0000-0000-0000000004b3') = 440, 'fixture: L3 manual payment of 60');
select th.assert(pg_temp.balance('00000000-0000-0000-0000-0000000004b9') = 250, 'fixture: LB 300 - 50');

-- The independent expectation: sum of recorded applied amounts over item 1's linked rows, per loan.
create temporary table expected_restore as
  select t.manual_loan_id as loan_id, sum(t.loan_balance_applied) as restore
  from public.transactions t join public.accounts a on a.id = t.account_id
  where a.item_id = '00000000-0000-0000-0000-000000000001' and t.manual_loan_id is not null
  group by t.manual_loan_id;
select th.assert((select sum(restore) from expected_restore) = 350, 'expected restore: 300 to L1 + 50 to L2');

-- ---- Preview (read-only) -----------------------------------------------------------------------
create temporary table p as
  select public.preview_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001') as v;
select th.assert((select v->>'institution_name' = 'Removed Bank' and v->>'status' = 'active' from p), 'preview identifies the item');
select th.assert((select v->'counts' = '{"accounts":2,"transactions":5,"linked_transactions":4,"splits":1,"recurring_streams":1,"liabilities":1}'::jsonb from p),
  'preview counts');
select th.assert((select jsonb_array_length(v->'loan_restorations') = 2 from p), 'two loans to restore');
select th.assert((select (r->>'restore_amount')::numeric = 300 and (r->>'linked_transactions')::int = 3 and (r->>'current_balance')::numeric = 500
                    and (r->>'balance_after')::numeric = 800
                  from p, jsonb_array_elements(v->'loan_restorations') r where r->>'loan_id' = '00000000-0000-0000-0000-0000000004b1'),
  'L1: pending and posted rows both restored with T1: 300, 500 -> 800');
select th.assert((select (r->>'restore_amount')::numeric = 50 and (r->>'balance_after')::numeric = 50
                  from p, jsonb_array_elements(v->'loan_restorations') r where r->>'loan_id' = '00000000-0000-0000-0000-0000000004b2'),
  'L2: the clamped 50, not the 100 principal');
select th.assert((select (v->>'unrestorable_links')::int = 0 and length(v->>'digest') = 64 from p), 'nothing unrestorable; digest present');
select th.assert(public.preview_plaid_item_removal('00000000-0000-0000-0000-0000000000bb', '00000000-0000-0000-0000-000000000001') is null,
  'another user cannot preview the item');
select th.assert(pg_temp.balance('00000000-0000-0000-0000-0000000004b1') = 500, 'preview wrote nothing');

-- The digest ignores an ordinary new unlinked transaction but notices a new link.
select pg_temp.txn('00000000-0000-0000-0000-0000000004d7', '00000000-0000-0000-0000-0000000004a1', 'r-t7', 30);
select th.assert(public.plaid_item_removal_digest('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001')
                 = (select v->>'digest' from p), 'a new unlinked transaction does not change the digest');
select pg_temp.link('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000004d7', '00000000-0000-0000-0000-0000000004b3', 30);
select th.assert(public.plaid_item_removal_digest('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001')
                 <> (select v->>'digest' from p), 'a new link changes the digest');
insert into expected_restore values ('00000000-0000-0000-0000-0000000004b3', 30);

-- ---- Begin -------------------------------------------------------------------------------------
select th.expect_error($q$ select public.record_plaid_item_removal_attempt('00000000-0000-0000-0000-0000000000aa',
  '00000000-0000-0000-0000-000000000001', 'removed', null) $q$, '%no removal operation%');
select th.expect_error($q$ select public.remove_plaid_item_local('00000000-0000-0000-0000-0000000000aa',
  '00000000-0000-0000-0000-000000000001') $q$, '%no removal operation%');

select th.assert(public.begin_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001',
                 (select v->>'digest' from p))->>'outcome' = 'preview_stale', 'the pre-link preview is stale after a new link');
select th.assert(public.begin_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', null)->>'outcome'
                 = 'preview_stale', 'no digest is stale');
select th.assert(not exists (select 1 from public.plaid_item_removals), 'a stale begin records nothing');
select th.assert((select status from public.plaid_items where id = '00000000-0000-0000-0000-000000000001') = 'active', 'and leaves the item active');
select th.assert(public.begin_plaid_item_removal('00000000-0000-0000-0000-0000000000bb', '00000000-0000-0000-0000-000000000001',
                 public.plaid_item_removal_digest('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001'))->>'outcome'
                 = 'not_found', 'another user cannot begin removing the item');

create temporary table b as
  select public.begin_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001',
    public.plaid_item_removal_digest('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001')) as v;
select th.assert((select v->>'outcome' = 'started' and v->'removal'->>'status' = 'requested' and v->'removal'->>'status_before' = 'active'
                    and v->'removal'->>'plaid_item_id' = 'harness-item-a' and v->'removal'->>'institution_name' = 'Removed Bank' from b),
  'begin starts a requested operation');
select th.assert((select status from public.plaid_items where id = '00000000-0000-0000-0000-000000000001') = 'removing', 'item is removing');
select th.assert(public.begin_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', 'anything')->>'outcome'
                 = 'existing', 'a second begin resumes the same operation (digest ignored)');
select th.assert((select count(*) from public.plaid_item_removals) = 1, 'one operation per item');

-- The backstop: no ordinary UPDATE takes the item out of removing.
update public.plaid_items set status = 'active' where id = '00000000-0000-0000-0000-000000000001';
update public.plaid_items set status = 'login_required' where id = '00000000-0000-0000-0000-000000000001';
select th.assert((select status from public.plaid_items where id = '00000000-0000-0000-0000-000000000001') = 'removing',
  'a racing sync/status write cannot clear removing');
select th.expect_error($q$ update public.plaid_items set status = 'bogus' where id = '00000000-0000-0000-0000-000000000003' $q$,
  '%plaid_items_status_check%');

-- ---- Local cleanup is refused until Plaid removal is confirmed ----------------------------------
select th.expect_error($q$ select public.remove_plaid_item_local('00000000-0000-0000-0000-0000000000aa',
  '00000000-0000-0000-0000-000000000001') $q$, '%Plaid removal is not confirmed%');
select th.assert(exists (select 1 from public.plaid_items where id = '00000000-0000-0000-0000-000000000001')
                 and pg_temp.balance('00000000-0000-0000-0000-0000000004b1') = 500, 'nothing deleted or restored while requested');

-- ---- Plaid attempts ------------------------------------------------------------------------------
select th.expect_error($q$ select public.record_plaid_item_removal_attempt('00000000-0000-0000-0000-0000000000aa',
  '00000000-0000-0000-0000-000000000001', 'bogus', null) $q$, '%unknown outcome%');
select public.record_plaid_item_removal_attempt('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', 'retryable', null);
select public.record_plaid_item_removal_attempt('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', 'needs_attention', 'INVALID_ACCESS_TOKEN');
select th.assert((select status = 'requested' and attempts = 2 and last_outcome = 'needs_attention' and last_error_code = 'INVALID_ACCESS_TOKEN'
                  from public.plaid_item_removals), 'failed attempts keep the operation requested, with their outcome');
select th.expect_error($q$ select public.remove_plaid_item_local('00000000-0000-0000-0000-0000000000aa',
  '00000000-0000-0000-0000-000000000001') $q$, '%Plaid removal is not confirmed%');
select public.record_plaid_item_removal_attempt('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', 'already_removed', 'ITEM_NOT_FOUND');
select th.assert((select status = 'plaid_removed' and plaid_outcome = 'already_removed' and attempts = 3 and last_outcome is null
                    and plaid_removed_at is not null from public.plaid_item_removals), 'ITEM_NOT_FOUND confirms the Item is gone at Plaid');
select public.record_plaid_item_removal_attempt('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', 'retryable', null);
select th.assert((select status = 'plaid_removed' and attempts = 3 from public.plaid_item_removals), 'a late attempt changes nothing');
select th.expect_error($q$ select public.record_plaid_item_removal_attempt('00000000-0000-0000-0000-0000000000bb',
  '00000000-0000-0000-0000-000000000001', 'removed', null) $q$, '%no removal operation%');
select th.expect_error($q$ select public.remove_plaid_item_local('00000000-0000-0000-0000-0000000000bb',
  '00000000-0000-0000-0000-000000000001') $q$, '%no removal operation%');

-- ---- Cleanup -------------------------------------------------------------------------------------
create temporary table before_other as
  select (select jsonb_agg(to_jsonb(t) order by t.id) from public.transactions t
           where t.account_id in ('00000000-0000-0000-0000-0000000004a3', '00000000-0000-0000-0000-0000000004a9')) as txns,
         (select jsonb_agg(to_jsonb(pi) order by pi.id) from public.plaid_items pi
           where pi.id in ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003')) as items,
         (select jsonb_agg(to_jsonb(mp)) from public.manual_loan_payments mp) as payments;
create temporary table balances_before as select id, current_balance from public.manual_loans;

create temporary table c as
  select public.remove_plaid_item_local('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001') as v;
select th.assert((select (v->>'replayed')::boolean = false from c), 'cleanup ran');
select th.assert((select v->'deleted_counts' = '{"accounts":2,"transactions":6,"linked_transactions":5,"splits":1,"recurring_streams":1,"liabilities":1}'::jsonb from c),
  'deleted counts');

-- The invariant: every loan changed by exactly the sum of its recorded applied amounts on the item.
select th.assert(not exists (
  select 1 from balances_before bb join public.manual_loans ml on ml.id = bb.id
  left join expected_restore e on e.loan_id = bb.id
  where ml.current_balance <> bb.current_balance + coalesce(e.restore, 0)),
  'every loan balance moved by exactly Σ loan_balance_applied of the removed item''s rows (and no other loan moved)');
select th.assert((select sum((a->>'restored')::numeric) from c, jsonb_array_elements(v->'loan_adjustments') a)
                 = (select sum(restore) from expected_restore), 'total restored = Σ loan_balance_applied');
select th.assert(pg_temp.balance('00000000-0000-0000-0000-0000000004b1') = 800, 'L1: 500 + 300 (T6 on the kept item still applies its 200)');
select th.assert(pg_temp.balance('00000000-0000-0000-0000-0000000004b2') = 50, 'L2: exactly the clamped 50 back — its original balance');
select th.assert(pg_temp.balance('00000000-0000-0000-0000-0000000004b3') = 440, 'L3: 410 + T7''s 30; the manual payment''s 60 still applied');
select th.assert(pg_temp.balance('00000000-0000-0000-0000-0000000004b9') = 250, 'the other user''s loan is untouched');

select th.assert(not exists (select 1 from public.plaid_items where id = '00000000-0000-0000-0000-000000000001'), 'item deleted (with its token)');
select th.assert(not exists (select 1 from public.accounts where item_id = '00000000-0000-0000-0000-000000000001')
                 and not exists (select 1 from public.accounts where id in ('00000000-0000-0000-0000-0000000004a1', '00000000-0000-0000-0000-0000000004a2')),
  'its accounts deleted');
select th.assert(not exists (select 1 from public.transactions where plaid_transaction_id like 'r-%'), 'its transactions deleted');
select th.assert(not exists (select 1 from public.transaction_splits where transaction_id = '00000000-0000-0000-0000-0000000004d5'), 'its splits deleted');
select th.assert(not exists (select 1 from public.recurring_streams where item_id = '00000000-0000-0000-0000-000000000001')
                 and not exists (select 1 from public.loans where item_id = '00000000-0000-0000-0000-000000000001'),
  'its recurring streams and liability records deleted');
select th.assert((select jsonb_agg(to_jsonb(t) order by t.id) from public.transactions t
                  where t.account_id in ('00000000-0000-0000-0000-0000000004a3', '00000000-0000-0000-0000-0000000004a9')) = (select txns from before_other),
  'the kept item''s and the other user''s transactions are byte-for-byte unchanged');
select th.assert((select jsonb_agg(to_jsonb(pi) order by pi.id) from public.plaid_items pi
                  where pi.id in ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003')) = (select items from before_other),
  'other items unchanged');
select th.assert((select jsonb_agg(to_jsonb(mp)) from public.manual_loan_payments mp) = (select payments from before_other),
  'manual loan payments untouched');
select th.assert(exists (select 1 from public.budget_categories where id = '00000000-0000-0000-0000-0000000004c1'), 'budget categories untouched');

select th.assert((select status = 'cleaned' and cleaned_at is not null and reconciled_at is null
                    and jsonb_array_length(loan_adjustments) = 3 from public.plaid_item_removals), 'operation cleaned, awaiting follow-ups');
select th.assert((select (a->>'balance_before')::numeric = 0 and (a->>'balance_after')::numeric = 50 and a->>'loan_name' = 'L2'
                  from public.plaid_item_removals, jsonb_array_elements(loan_adjustments) a
                  where a->>'loan_id' = '00000000-0000-0000-0000-0000000004b2'), 'adjustments record before/after');

-- Replay: returns the stored result, changes nothing.
create temporary table balances_after as select id, current_balance from public.manual_loans;
select th.assert((select (v->>'replayed')::boolean and v->'loan_adjustments' = (select loan_adjustments from public.plaid_item_removals)
                  from (select public.remove_plaid_item_local('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001') as v) x),
  'a replayed cleanup returns the recorded result');
select th.assert(not exists (select 1 from balances_after ba join public.manual_loans ml on ml.id = ba.id where ml.current_balance <> ba.current_balance),
  'and restores nothing twice');
select th.assert(public.begin_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', null)->>'outcome'
                 = 'existing', 'begin after cleanup reports the finished operation');

-- Follow-ups.
select th.expect_error($q$ select public.mark_plaid_item_removal_reconciled('00000000-0000-0000-0000-0000000000bb',
  '00000000-0000-0000-0000-000000000001') $q$, '%no cleaned removal operation%');
select public.mark_plaid_item_removal_reconciled('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001');
create temporary table rec as select reconciled_at from public.plaid_item_removals;
select public.mark_plaid_item_removal_reconciled('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001');
select th.assert((select reconciled_at from public.plaid_item_removals) = (select reconciled_at from rec) and (select reconciled_at from rec) is not null,
  'marking reconciled is idempotent');

-- ---- A credential_error item cannot be removed ---------------------------------------------------
update public.plaid_items set status = 'credential_error' where id = '00000000-0000-0000-0000-000000000003';
select th.assert(public.begin_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000003',
                 public.plaid_item_removal_digest('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000003'))->>'outcome'
                 = 'connection_needs_attention', 'credential_error refuses removal');
select th.assert(not exists (select 1 from public.plaid_item_removals where item_id = '00000000-0000-0000-0000-000000000003'), 'nothing recorded');
update public.plaid_items set status = 'active' where id = '00000000-0000-0000-0000-000000000003';

-- ---- Fail closed on a missing applied amount -----------------------------------------------------
-- The guards make a missing amount impossible; remove them in a rolled-back transaction and fabricate
-- one. Begin refuses (nothing happens at Plaid); a cleanup forced into plaid_removed refuses too, and
-- neither deletes nor restores anything.
begin;
reset role;
alter table public.transactions drop constraint transactions_loan_balance_applied_required_check;
set role service_role;
update public.transactions set loan_balance_applied = null where id = '00000000-0000-0000-0000-0000000004d6';
select th.assert(public.begin_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000003',
                 public.plaid_item_removal_digest('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000003'))->>'outcome'
                 = 'manual_loan_reconciliation_required', 'begin refuses an item with an unrestorable link');
select th.assert((select (v->>'unrestorable_links')::int = 1
                  from (select public.preview_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000003') as v) x),
  'preview reports it');
reset role;
insert into public.plaid_item_removals (user_id, item_id, plaid_item_id, status_before, status, preview_digest, plaid_outcome, plaid_removed_at)
values ('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000003', 'harness-item-a3', 'active', 'plaid_removed', 'x', 'removed', now());
update public.plaid_items set status = 'removing' where id = '00000000-0000-0000-0000-000000000003';
set role service_role;
create temporary table before_fail as select pg_temp.balance('00000000-0000-0000-0000-0000000004b1') as l1;
select th.expect_error($q$ select public.remove_plaid_item_local('00000000-0000-0000-0000-0000000000aa',
  '00000000-0000-0000-0000-000000000003') $q$, '%manual-loan reconciliation required: remove_plaid_item_local%');
select th.assert(pg_temp.balance('00000000-0000-0000-0000-0000000004b1') = (select l1 from before_fail), 'nothing restored');
select th.assert(exists (select 1 from public.transactions where id = '00000000-0000-0000-0000-0000000004d6')
                 and exists (select 1 from public.plaid_items where id = '00000000-0000-0000-0000-000000000003'), 'nothing deleted');
select th.assert((select status from public.plaid_item_removals where item_id = '00000000-0000-0000-0000-000000000003') = 'plaid_removed',
  'the operation stays retryable');
rollback;
