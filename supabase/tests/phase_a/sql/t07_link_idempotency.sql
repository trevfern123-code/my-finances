-- Post-audit blocker 1 (20260924120000_manual_loan_link_idempotency.sql): link_transaction_to_manual_loan
-- re-validates the existing link under its lock and never links or decrements twice.
set role service_role;

insert into public.manual_loans (id, user_id, name, current_balance) values
  ('00000000-0000-0000-0000-0000000001d1', '00000000-0000-0000-0000-0000000000aa', 'Idempotency Loan A', 1000),
  ('00000000-0000-0000-0000-0000000001d2', '00000000-0000-0000-0000-0000000000aa', 'Idempotency Loan B', 1000),
  ('00000000-0000-0000-0000-0000000001d9', '00000000-0000-0000-0000-0000000000bb', 'Other user loan', 1000);
insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name,
  auto_role, role_source, role_confidence, classifier_version) values
  ('00000000-0000-0000-0000-0000000001e1', '00000000-0000-0000-0000-0000000000a1', 'idem-e1', 100, '2026-09-10', 'Loan payment',
   'expense', 'sign_default', 'low', 1),
  ('00000000-0000-0000-0000-0000000001e9', '00000000-0000-0000-0000-0000000000a9', 'idem-e9', 100, '2026-09-10', 'Other user payment',
   'expense', 'sign_default', 'low', 1);

create function pg_temp.link(p_txn text, p_loan text, p_principal numeric) returns text language sql as $$
  select public.link_transaction_to_manual_loan('00000000-0000-0000-0000-0000000000aa', p_txn::uuid, p_loan::uuid, p_principal, 1::smallint)
$$;
create function pg_temp.balance(p_loan text) returns numeric language sql as $$
  select current_balance from public.manual_loans where id = p_loan::uuid
$$;

-- First link: linked, decremented once.
select th.assert(pg_temp.link('00000000-0000-0000-0000-0000000001e1', '00000000-0000-0000-0000-0000000001d1', 100) = 'linked', 'first link: linked');
select th.assert(pg_temp.balance('00000000-0000-0000-0000-0000000001d1') = 900, 'loan A decremented once (1000 -> 900)');
create temporary table after_link as select manual_loan_id, principal_portion, auto_role, role_source, classifier_version
  from public.transactions where id = '00000000-0000-0000-0000-0000000001e1';

-- Exact replay (same loan, same principal): no writes.
select th.assert(pg_temp.link('00000000-0000-0000-0000-0000000001e1', '00000000-0000-0000-0000-0000000001d1', 100) = 'already_linked', 'exact replay: already_linked');
select th.assert(pg_temp.link('00000000-0000-0000-0000-0000000001e1', '00000000-0000-0000-0000-0000000001d1', 100.00) = 'already_linked', 'numerically equal principal is the same principal');
select th.assert(pg_temp.balance('00000000-0000-0000-0000-0000000001d1') = 900, 'replays never decrement again');

-- Same loan, different principal (e.g. the user edited it since): no writes, the edit is kept.
update public.transactions set principal_portion = 70 where id = '00000000-0000-0000-0000-0000000001e1';
select th.assert(pg_temp.link('00000000-0000-0000-0000-0000000001e1', '00000000-0000-0000-0000-0000000001d1', 100) = 'already_linked_different_principal',
  'same loan, different principal: explicit outcome');
select th.assert((select principal_portion from public.transactions where id = '00000000-0000-0000-0000-0000000001e1') = 70, 'the existing principal is not overwritten');
select th.assert(pg_temp.balance('00000000-0000-0000-0000-0000000001d1') = 900, 'and the loan is not decremented');
update public.transactions set principal_portion = 100 where id = '00000000-0000-0000-0000-0000000001e1';

-- A stale candidate for ANOTHER loan: no writes to either loan, the link stays.
select th.assert(pg_temp.link('00000000-0000-0000-0000-0000000001e1', '00000000-0000-0000-0000-0000000001d2', 100) = 'linked_to_other_loan', 'other loan: explicit outcome');
select th.assert(pg_temp.balance('00000000-0000-0000-0000-0000000001d1') = 900, 'loan A untouched');
select th.assert(pg_temp.balance('00000000-0000-0000-0000-0000000001d2') = 1000, 'loan B untouched');
select th.assert((select row(manual_loan_id, principal_portion, auto_role, role_source, classifier_version)
                  from public.transactions where id = '00000000-0000-0000-0000-0000000001e1')
                 = (select row(manual_loan_id, principal_portion, auto_role, role_source, classifier_version) from after_link),
  'the transaction row is exactly as the first link left it');

-- A no-op outcome is never reported for rows that are not the caller's: ownership still raises first.
select th.expect_error($q$ select pg_temp.link('00000000-0000-0000-0000-0000000001e1', '00000000-0000-0000-0000-0000000001d9', 100) $q$,
  '%manual loan not found or not owned by user%');
select th.expect_error($q$ select pg_temp.link('00000000-0000-0000-0000-0000000001e9', '00000000-0000-0000-0000-0000000001d1', 100) $q$,
  '%transaction not found or not owned by user%');
-- Principal validation still applies to a genuinely new link (and rolls it back entirely).
insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name, auto_role, role_source, role_confidence, classifier_version)
values ('00000000-0000-0000-0000-0000000001e2', '00000000-0000-0000-0000-0000000000a1', 'idem-e2', 50, '2026-09-11', 'Small payment', 'expense', 'sign_default', 'low', 1);
select th.expect_error($q$ select pg_temp.link('00000000-0000-0000-0000-0000000001e2', '00000000-0000-0000-0000-0000000001d2', 80) $q$,
  '%must be a finite value between 0 and the transaction amount%');
select th.assert((select manual_loan_id is null from public.transactions where id = '00000000-0000-0000-0000-0000000001e2')
                 and pg_temp.balance('00000000-0000-0000-0000-0000000001d2') = 1000, 'a rejected link writes nothing');
reset role;

-- Security properties after the drop/recreate (the migration's own postcondition checks the same).
select th.assert((select p.prorettype = 'text'::regtype and not p.prosecdef and p.proconfig = array['search_path=""']
                         and l.lanname = 'plpgsql'
                         and p.proargnames = array['p_user_id', 'p_transaction_id', 'p_loan_id', 'p_principal_portion', 'p_classifier_version']
                         and not has_function_privilege('public', p.oid, 'execute')
                         and not has_function_privilege('anon', p.oid, 'execute')
                         and not has_function_privilege('authenticated', p.oid, 'execute')
                         and has_function_privilege('service_role', p.oid, 'execute')
                         and pg_get_userbyid(p.proowner) = (select pg_get_userbyid(p2.proowner) from pg_proc p2
                                                            where p2.oid = 'public.unlink_transaction_from_manual_loan(uuid, uuid, uuid, text, text, text, smallint)'::regprocedure)
                  from pg_proc p join pg_language l on l.oid = p.prolang
                  where p.oid = 'public.link_transaction_to_manual_loan(uuid, uuid, uuid, numeric, smallint)'::regprocedure),
  'recreated function: returns text; SECURITY INVOKER; search_path pinned; same arguments; service_role-only EXECUTE; same owner as its sibling functions');
