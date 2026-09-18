-- delete_manual_loan_atomic: classifier-input CAS (Round 11 item 1), explicit ordering of the
-- reclassify id set (Round 11 item 3), set CAS, atomic rollback, tombstone replay, ownership.
set role service_role;

insert into public.manual_loans (id, user_id, name, current_balance)
values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000aa', 'Deletion Loan', 1000);

insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name, category,
  personal_finance_category_detailed, personal_finance_category_confidence,
  auto_role, role_source, role_confidence, classifier_version) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'del-e1', 40, '2026-09-10', 'E1',
   'GENERAL_MERCHANDISE', null, null, 'expense', 'sign_default', 'low', 1),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a1', 'del-e2', 60, '2026-09-10', 'E2',
   null, null, null, 'expense', 'sign_default', 'low', 1),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000a2', 'del-e3', 80, '2026-09-11', 'E3',
   'FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE', 'HIGH', 'expense', 'sign_default', 'low', 1);

select public.link_transaction_to_manual_loan('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1', 10, 1::smallint);
select public.link_transaction_to_manual_loan('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000d1', 20, 1::smallint);
select public.link_transaction_to_manual_loan('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000d1', 30, 1::smallint);

create temporary table linked_before as
select id, manual_loan_id, principal_portion, auto_role, role_source from public.transactions where manual_loan_id is not null;

-- Every rejection below must leave the loan and all three links exactly as they were.
create function pg_temp.assert_untouched(p_label text) returns void language plpgsql as $$
begin
  perform th.assert(exists (select 1 from public.manual_loans where id = '00000000-0000-0000-0000-0000000000d1'),
    p_label || ': loan must still exist');
  perform th.assert(
    (select count(*) from public.transactions t join linked_before b using (id)
     where t.manual_loan_id is not distinct from b.manual_loan_id
       and t.principal_portion is not distinct from b.principal_portion
       and t.auto_role is not distinct from b.auto_role
       and t.role_source is not distinct from b.role_source) = 3,
    p_label || ': all three linked rows must be unchanged');
  perform th.assert(not exists (select 1 from public.manual_loan_deletions where loan_id = '00000000-0000-0000-0000-0000000000d1'),
    p_label || ': no tombstone may be written');
end;
$$;

-- Item 1: a stale classifier input on ONE row (e1 was read before it became GENERAL_MERCHANDISE,
-- i.e. the caller saw category null) — the id set is still correct, so only the input CAS can catch it.
select th.expect_error($q$
  select public.delete_manual_loan_atomic('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000d1', '[
    {"id":"00000000-0000-0000-0000-0000000000e1","auto_role":"expense","role_source":"sign_default","role_confidence":"low","classifier_version":1,
     "exp_amount":40,"exp_category":null,"exp_pfc_detailed":null,"exp_pfc_confidence":null},
    {"id":"00000000-0000-0000-0000-0000000000e2","auto_role":"expense","role_source":"sign_default","role_confidence":"low","classifier_version":1,
     "exp_amount":60,"exp_category":null,"exp_pfc_detailed":null,"exp_pfc_confidence":null},
    {"id":"00000000-0000-0000-0000-0000000000e3","auto_role":"expense","role_source":"sign_default","role_confidence":"low","classifier_version":1,
     "exp_amount":80,"exp_category":"FOOD_AND_DRINK","exp_pfc_detailed":"FOOD_AND_DRINK_COFFEE","exp_pfc_confidence":"HIGH"}]')
$q$, '%changed since they were classified%');
select pg_temp.assert_untouched('stale exp_category');

-- Item 1: stale amount.
select th.expect_error($q$
  select public.delete_manual_loan_atomic('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000d1', '[
    {"id":"00000000-0000-0000-0000-0000000000e1","auto_role":"expense","role_source":"sign_default","role_confidence":"low","classifier_version":1,
     "exp_amount":41,"exp_category":"GENERAL_MERCHANDISE","exp_pfc_detailed":null,"exp_pfc_confidence":null},
    {"id":"00000000-0000-0000-0000-0000000000e2","auto_role":"expense","role_source":"sign_default","role_confidence":"low","classifier_version":1,
     "exp_amount":60,"exp_category":null,"exp_pfc_detailed":null,"exp_pfc_confidence":null},
    {"id":"00000000-0000-0000-0000-0000000000e3","auto_role":"expense","role_source":"sign_default","role_confidence":"low","classifier_version":1,
     "exp_amount":80,"exp_category":"FOOD_AND_DRINK","exp_pfc_detailed":"FOOD_AND_DRINK_COFFEE","exp_pfc_confidence":"HIGH"}]')
$q$, '%changed since they were classified%');
select pg_temp.assert_untouched('stale exp_amount');

-- Item 1: stale detailed category / confidence on e3.
select th.expect_error($q$
  select public.delete_manual_loan_atomic('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000d1', '[
    {"id":"00000000-0000-0000-0000-0000000000e1","auto_role":"expense","role_source":"sign_default","role_confidence":"low","classifier_version":1,
     "exp_amount":40,"exp_category":"GENERAL_MERCHANDISE","exp_pfc_detailed":null,"exp_pfc_confidence":null},
    {"id":"00000000-0000-0000-0000-0000000000e2","auto_role":"expense","role_source":"sign_default","role_confidence":"low","classifier_version":1,
     "exp_amount":60,"exp_category":null,"exp_pfc_detailed":null,"exp_pfc_confidence":null},
    {"id":"00000000-0000-0000-0000-0000000000e3","auto_role":"expense","role_source":"sign_default","role_confidence":"low","classifier_version":1,
     "exp_amount":80,"exp_category":"FOOD_AND_DRINK","exp_pfc_detailed":"FOOD_AND_DRINK_COFFEE","exp_pfc_confidence":"LOW"}]')
$q$, '%changed since they were classified%');
select pg_temp.assert_untouched('stale exp_pfc_confidence');

-- Item 1: a caller that omits the exp_* fields entirely (an older client) fails closed.
select th.expect_error($q$
  select public.delete_manual_loan_atomic('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000d1', '[
    {"id":"00000000-0000-0000-0000-0000000000e1","auto_role":"expense","role_source":"sign_default","role_confidence":"low","classifier_version":1},
    {"id":"00000000-0000-0000-0000-0000000000e2","auto_role":"expense","role_source":"sign_default","role_confidence":"low","classifier_version":1},
    {"id":"00000000-0000-0000-0000-0000000000e3","auto_role":"expense","role_source":"sign_default","role_confidence":"low","classifier_version":1}]')
$q$, '%changed since they were classified%');
select pg_temp.assert_untouched('missing exp_* fields');

-- Stale id set (a row linked after the caller's read is missing from the payload).
select th.expect_error($q$
  select public.delete_manual_loan_atomic('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000d1', '[
    {"id":"00000000-0000-0000-0000-0000000000e1","auto_role":"expense","role_source":"sign_default","role_confidence":"low","classifier_version":1,
     "exp_amount":40,"exp_category":"GENERAL_MERCHANDISE","exp_pfc_detailed":null,"exp_pfc_confidence":null}]')
$q$, '%set of transactions linked to this loan changed%');
select pg_temp.assert_untouched('stale id set');

-- Duplicate ids.
select th.expect_error($q$
  select public.delete_manual_loan_atomic('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000d1', '[
    {"id":"00000000-0000-0000-0000-0000000000e1","auto_role":"expense","role_source":"sign_default","role_confidence":"low","classifier_version":1,
     "exp_amount":40,"exp_category":"GENERAL_MERCHANDISE","exp_pfc_detailed":null,"exp_pfc_confidence":null},
    {"id":"00000000-0000-0000-0000-0000000000e1","auto_role":"income","role_source":"sign_default","role_confidence":"low","classifier_version":1,
     "exp_amount":40,"exp_category":"GENERAL_MERCHANDISE","exp_pfc_detailed":null,"exp_pfc_confidence":null}]')
$q$, '%duplicate id supplied in p_reclassify%');
select pg_temp.assert_untouched('duplicate ids');

-- Failure part-way through the write (third row carries an invalid role combination): the rows the
-- UPDATE already touched must roll back with it.
select th.expect_error($q$
  select public.delete_manual_loan_atomic('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000d1', '[
    {"id":"00000000-0000-0000-0000-0000000000e1","auto_role":"expense","role_source":"sign_default","role_confidence":"low","classifier_version":1,
     "exp_amount":40,"exp_category":"GENERAL_MERCHANDISE","exp_pfc_detailed":null,"exp_pfc_confidence":null},
    {"id":"00000000-0000-0000-0000-0000000000e2","auto_role":"expense","role_source":"sign_default","role_confidence":"low","classifier_version":1,
     "exp_amount":60,"exp_category":null,"exp_pfc_detailed":null,"exp_pfc_confidence":null},
    {"id":"00000000-0000-0000-0000-0000000000e3","auto_role":"expense","role_source":null,"role_confidence":"low","classifier_version":1,
     "exp_amount":80,"exp_category":"FOOD_AND_DRINK","exp_pfc_detailed":"FOOD_AND_DRINK_COFFEE","exp_pfc_confidence":"HIGH"}]')
$q$, '%transactions_role_fields_all_or_none_check%');
select pg_temp.assert_untouched('failure mid-write');

-- Cross-user: user bb cannot delete aa's loan.
select th.expect_error($q$
  select public.delete_manual_loan_atomic('00000000-0000-0000-0000-0000000000bb', '00000000-0000-0000-0000-0000000000d1', '[]')
$q$, '%manual loan not found or not owned by user%');
select pg_temp.assert_untouched('cross-user attempt');

-- A loan that never existed (and has no tombstone).
select th.expect_error($q$
  select public.delete_manual_loan_atomic('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-00000000dead', '[]')
$q$, '%manual loan not found or not owned by user%');

-- Item 3: the correct payload supplied in a SHUFFLED order (e3, e1, e2) must be accepted — the
-- set comparison is explicitly ordered on both sides, not dependent on input order.
select public.delete_manual_loan_atomic('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000d1', '[
  {"id":"00000000-0000-0000-0000-0000000000e3","auto_role":"expense","role_source":"sign_default","role_confidence":"low","classifier_version":1,
   "exp_amount":80,"exp_category":"FOOD_AND_DRINK","exp_pfc_detailed":"FOOD_AND_DRINK_COFFEE","exp_pfc_confidence":"HIGH"},
  {"id":"00000000-0000-0000-0000-0000000000e1","auto_role":"expense","role_source":"sign_default","role_confidence":"low","classifier_version":1,
   "exp_amount":40,"exp_category":"GENERAL_MERCHANDISE","exp_pfc_detailed":null,"exp_pfc_confidence":null},
  {"id":"00000000-0000-0000-0000-0000000000e2","auto_role":"income","role_source":"sign_default","role_confidence":"low","classifier_version":1,
   "exp_amount":60,"exp_category":null,"exp_pfc_detailed":null,"exp_pfc_confidence":null}]') as result \gset

select th.assert((:'result'::jsonb ->> 'replayed')::boolean = false, 'first deletion is not a replay');
select th.assert(:'result'::jsonb -> 'affected_transaction_ids' = '["00000000-0000-0000-0000-0000000000e1","00000000-0000-0000-0000-0000000000e2","00000000-0000-0000-0000-0000000000e3"]'::jsonb,
  'affected ids reported, in ascending order');
select th.assert(not exists (select 1 from public.manual_loans where id = '00000000-0000-0000-0000-0000000000d1'), 'loan deleted');
select th.assert((select count(*) from public.transactions
  where id in ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000e3')
    and manual_loan_id is null and principal_portion is null and role_source = 'sign_default') = 3,
  'every linked row unlinked, principal cleared, reclassified');
select th.assert((select auto_role from public.transactions where id = '00000000-0000-0000-0000-0000000000e2') = 'income',
  'each row got ITS OWN role from the payload, matched by id regardless of input order');
select th.assert((select cardinality(affected_transaction_ids) = 3 and reconciled_at is null
  from public.manual_loan_deletions where loan_id = '00000000-0000-0000-0000-0000000000d1'), 'tombstone records all three ids, unreconciled');

-- Replay after commit returns the recorded ids instead of "not found"; marking reconciled is reported.
select public.delete_manual_loan_atomic('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000d1', '[]') as replay \gset
select th.assert((:'replay'::jsonb ->> 'replayed')::boolean and not (:'replay'::jsonb ->> 'already_reconciled')::boolean, 'replay, not yet reconciled');
select th.assert(:'replay'::jsonb -> 'affected_transaction_ids' = :'result'::jsonb -> 'affected_transaction_ids', 'replay returns the same ids');
select public.mark_manual_loan_deletion_reconciled('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000d1');
select public.delete_manual_loan_atomic('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000d1', '[]') as replay2 \gset
select th.assert((:'replay2'::jsonb ->> 'already_reconciled')::boolean, 'replay after marking reports already_reconciled');
select th.expect_error($q$
  select public.mark_manual_loan_deletion_reconciled('00000000-0000-0000-0000-0000000000bb', '00000000-0000-0000-0000-0000000000d1')
$q$, '%no deletion record%');
