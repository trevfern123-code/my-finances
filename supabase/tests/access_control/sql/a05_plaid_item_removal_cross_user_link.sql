-- Linked Institution Management (Codex review of bc87477): a transaction of user aa's item that is
-- linked to user bb's manual loan must stop a removal BEFORE it exists or reaches Plaid — not only at
-- local cleanup, which runs after Plaid removal is irreversible.
--
-- No write path creates such a row (link_transaction_to_manual_loan checks both owners), so it is
-- fabricated here directly, the way a stray manual write or corruption would. Preview and begin must
-- both see it even though the loan is another user's (an owner-filtered join would hide it).
set role service_role;

insert into public.accounts (id, item_id, plaid_account_id, name) values
  ('00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-000000000001', 'acct-x1', 'AA Checking'),
  ('00000000-0000-0000-0000-0000000005a9', '00000000-0000-0000-0000-000000000002', 'acct-x9', 'BB Checking');
insert into public.manual_loans (id, user_id, name, current_balance) values
  ('00000000-0000-0000-0000-0000000005b1', '00000000-0000-0000-0000-0000000000aa', 'AA loan', 1000),
  ('00000000-0000-0000-0000-0000000005b9', '00000000-0000-0000-0000-0000000000bb', 'BB secret loan name', 300);
insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name,
  auto_role, role_source, role_confidence, classifier_version) values
  ('00000000-0000-0000-0000-0000000005d1', '00000000-0000-0000-0000-0000000005a1', 'x-own', 100, '2026-09-10', 'Own payment',
   'expense', 'sign_default', 'low', 1),
  ('00000000-0000-0000-0000-0000000005d2', '00000000-0000-0000-0000-0000000005a1', 'x-foreign', 50, '2026-09-10', 'Foreign-linked payment',
   'expense', 'sign_default', 'low', 1);
-- A legitimate link on the same item (aa's own loan)...
select th.assert(public.link_transaction_to_manual_loan('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000005d1',
  '00000000-0000-0000-0000-0000000005b1', 100, 1::smallint) = 'linked', 'fixture: own link');
-- ...and the fabricated cross-user one: aa's transaction pointing at bb's loan, with a recorded amount.
update public.transactions
set manual_loan_id = '00000000-0000-0000-0000-0000000005b9', principal_portion = 50, loan_balance_applied = 50,
    auto_role = 'debt_payment', role_source = 'manual_loan_link', role_confidence = 'high'
where id = '00000000-0000-0000-0000-0000000005d2';

create temporary table before_state as
  select (select jsonb_agg(to_jsonb(ml) order by ml.id) from public.manual_loans ml) as loans,
         (select jsonb_agg(to_jsonb(t) order by t.id) from public.transactions t) as txns,
         (select jsonb_agg(to_jsonb(a) order by a.id) from public.accounts a) as accounts,
         (select jsonb_agg(jsonb_build_object('id', pi.id, 'status', pi.status) order by pi.id) from public.plaid_items pi) as items;

-- 1. The blocker sees it.
select th.assert(public.plaid_item_removal_blocker('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001')
                 = 'manual_loan_ownership_mismatch', 'blocker: manual_loan_ownership_mismatch');

-- 2. Preview reports it (blocked) without revealing anything about bb's loan.
create temporary table p as
  select public.preview_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001') as v;
select th.assert((select v->>'blocker' = 'manual_loan_ownership_mismatch' and (v->>'ownership_mismatch_links')::int = 1 from p),
  'preview is blocked and counts the foreign-linked row');
select th.assert((select jsonb_array_length(v->'loan_restorations') = 1
                    and v->'loan_restorations'->0->>'loan_id' = '00000000-0000-0000-0000-0000000005b1' from p),
  'loan_restorations lists only aa''s own loan');
select th.assert((select position('0000000005b9' in v::text) = 0 and position('BB secret' in v::text) = 0 from p),
  'the preview never names bb''s loan');

-- 3. Begin refuses — even with the current, correct digest — before creating anything.
create temporary table b as
  select public.begin_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001',
    public.plaid_item_removal_digest('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001')) as v;
select th.assert((select v = '{"outcome": "manual_loan_ownership_mismatch"}'::jsonb from b),
  format('begin refuses with the fixed code only (got %s)', (select v from b)));
select th.assert(not exists (select 1 from public.plaid_item_removals), 'no removal operation was created');
select th.assert((select status from public.plaid_items where id = '00000000-0000-0000-0000-000000000001') = 'active',
  'the item is not marked removing');

-- 4-6. Nothing changed anywhere: no balance, no item/account/transaction row.
select th.assert((select jsonb_agg(to_jsonb(ml) order by ml.id) from public.manual_loans ml) = (select loans from before_state),
  'no manual-loan balance changed (either user''s)');
select th.assert((select jsonb_agg(to_jsonb(t) order by t.id) from public.transactions t) = (select txns from before_state),
  'no transaction changed or was deleted');
select th.assert((select jsonb_agg(to_jsonb(a) order by a.id) from public.accounts a) = (select accounts from before_state),
  'no account changed or was deleted');
select th.assert((select jsonb_agg(jsonb_build_object('id', pi.id, 'status', pi.status) order by pi.id) from public.plaid_items pi)
                 = (select items from before_state), 'no item changed or was deleted');

-- A retried begin is refused the same way (it is not a one-off).
select th.assert(public.begin_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001',
                 public.plaid_item_removal_digest('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001'))->>'outcome'
                 = 'manual_loan_ownership_mismatch', 'a retried begin is refused too');

-- Defense in depth: even an operation forced past begin (written directly, as no function would) is
-- refused by cleanup, which touches nothing. (Forced in a transaction that is rolled back.)
begin;
reset role;
insert into public.plaid_item_removals (user_id, item_id, plaid_item_id, status_before, status, preview_digest, plaid_outcome, plaid_removed_at)
values ('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', 'harness-item-a', 'active', 'plaid_removed', 'x', 'removed', now());
update public.plaid_items set status = 'removing' where id = '00000000-0000-0000-0000-000000000001';
set role service_role;
select th.expect_error($q$ select public.remove_plaid_item_local('00000000-0000-0000-0000-0000000000aa',
  '00000000-0000-0000-0000-000000000001') $q$, 'manual_loan_ownership_mismatch: remove_plaid_item_local:%');
select th.assert((select jsonb_agg(to_jsonb(ml) order by ml.id) from public.manual_loans ml) = (select loans from before_state)
                 and (select jsonb_agg(to_jsonb(t) order by t.id) from public.transactions t) = (select txns from before_state),
  'cleanup refused without touching any loan or transaction');
rollback;

-- Once the stray link is gone (repaired by whoever investigates), removal is possible again.
reset role;
update public.transactions set manual_loan_id = null, principal_portion = null, loan_balance_applied = null,
  auto_role = 'expense', role_source = 'sign_default', role_confidence = 'low'
where id = '00000000-0000-0000-0000-0000000005d2';
set role service_role;
select th.assert(public.plaid_item_removal_blocker('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001') is null,
  'no blocker after the repair');
select th.assert(public.begin_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001',
                 public.plaid_item_removal_digest('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001'))->>'outcome'
                 = 'started', 'begin starts normally');
