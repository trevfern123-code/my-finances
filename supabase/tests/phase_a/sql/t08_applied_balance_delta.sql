-- Post-audit blocker 2 (20260924130000_manual_loan_applied_balance_delta.sql): every reversal restores
-- exactly what its application took off the balance, never more — while the balance still never
-- goes negative. The first section uses only the functions and balances (no new column), so with
-- FOLLOWUP_MIGRATIONS="20260924120000_manual_loan_link_idempotency.sql" it fails on the defect itself.
set role service_role;

create function pg_temp.loan(p_id text, p_balance numeric) returns void language sql as $$
  insert into public.manual_loans (id, user_id, name, current_balance)
  values (p_id::uuid, '00000000-0000-0000-0000-0000000000aa', 'Delta loan ' || right(p_id, 3), p_balance)
$$;
create function pg_temp.txn(p_id text, p_amount numeric) returns void language sql as $$
  insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name,
    auto_role, role_source, role_confidence, classifier_version)
  values (p_id::uuid, '00000000-0000-0000-0000-0000000000a1', 'delta-' || right(p_id, 3), p_amount, '2026-09-10', 'Loan payment',
    'expense', 'sign_default', 'low', 1)
$$;
create function pg_temp.link(p_txn text, p_loan text, p_principal numeric) returns void language plpgsql as $$
begin
  perform public.link_transaction_to_manual_loan('00000000-0000-0000-0000-0000000000aa', p_txn::uuid, p_loan::uuid, p_principal, 1::smallint);
end $$;
create function pg_temp.unlink(p_txn text, p_loan text) returns void language plpgsql as $$
begin
  perform th.assert(public.unlink_transaction_from_manual_loan('00000000-0000-0000-0000-0000000000aa', p_txn::uuid, p_loan::uuid,
    'expense', 'sign_default', 'low', 1::smallint), 'unlink performed');
end $$;
create function pg_temp.edit(p_txn text, p_loan text, p_principal numeric) returns void language sql as $$
  select public.update_linked_payment_principal('00000000-0000-0000-0000-0000000000aa', p_txn::uuid, p_loan::uuid, p_principal)
$$;
create function pg_temp.pay(p_loan text, p_principal numeric) returns uuid language sql as $$
  select public.create_manual_loan_payment('00000000-0000-0000-0000-0000000000aa', p_loan::uuid, '2026-09-10', p_principal, 0, null)
$$;
create function pg_temp.edit_pay(p_payment uuid, p_loan text, p_principal numeric) returns void language sql as $$
  select public.update_manual_loan_payment('00000000-0000-0000-0000-0000000000aa', p_payment, p_loan::uuid,
    false, null, true, p_principal, false, null, false, null)
$$;
create function pg_temp.unpay(p_payment uuid, p_loan text) returns void language sql as $$
  select public.delete_manual_loan_payment('00000000-0000-0000-0000-0000000000aa', p_payment, p_loan::uuid)
$$;
create function pg_temp.expect(p_loan text, p_balance numeric, p_what text) returns void language plpgsql as $$
declare v numeric;
begin
  select current_balance into v from public.manual_loans where id = p_loan::uuid;
  perform th.assert(v = p_balance, format('%s: balance %s, expected %s', p_what, v, p_balance));
end $$;

-- 1. The audit's case: $50 balance, $100-principal payment linked, then unlinked.
select pg_temp.loan('00000000-0000-0000-0000-000000000201', 50);
select pg_temp.txn('00000000-0000-0000-0000-000000000301', 100);
select pg_temp.link('00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000201', 100);
select pg_temp.expect('00000000-0000-0000-0000-000000000201', 0, 'link clamps at zero (never negative)');
select pg_temp.unlink('00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000201');
select pg_temp.expect('00000000-0000-0000-0000-000000000201', 50, 'unlink restores the $50 taken, not the $100 principal');

-- 2. Manual payments: the same case through create/delete.
create temporary table ids (name text primary key, id uuid);
insert into ids select 'p1', pg_temp.pay('00000000-0000-0000-0000-000000000201', 100);
select pg_temp.expect('00000000-0000-0000-0000-000000000201', 0, 'payment clamps at zero');
select pg_temp.unpay((select id from ids where name = 'p1'), '00000000-0000-0000-0000-000000000201');
select pg_temp.expect('00000000-0000-0000-0000-000000000201', 50, 'payment delete restores only the $50 taken');

-- 3. Plaid removal of a clamped link.
select pg_temp.link('00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000201', 100);
select pg_temp.expect('00000000-0000-0000-0000-000000000201', 0, 'relinked');
select public.delete_transactions_and_restore_loan_balances('00000000-0000-0000-0000-0000000000aa', array['delta-301']);
select pg_temp.expect('00000000-0000-0000-0000-000000000201', 50, 'Plaid removal restores only the $50 taken');
select th.assert(not exists (select 1 from public.transactions where id = '00000000-0000-0000-0000-000000000301'), 'removed transaction deleted');

-- 4. Zero boundaries.
select pg_temp.loan('00000000-0000-0000-0000-000000000202', 100);
select pg_temp.txn('00000000-0000-0000-0000-000000000302', 100);
select pg_temp.link('00000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-000000000202', 100);
select pg_temp.expect('00000000-0000-0000-0000-000000000202', 0, 'principal exactly equal to the balance');
select pg_temp.unlink('00000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-000000000202');
select pg_temp.expect('00000000-0000-0000-0000-000000000202', 100, 'exact-balance link fully restored');
select pg_temp.loan('00000000-0000-0000-0000-000000000203', 0);
select pg_temp.link('00000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-000000000203', 30);
select pg_temp.expect('00000000-0000-0000-0000-000000000203', 0, 'link to a zero balance');
select pg_temp.unlink('00000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-000000000203');
select pg_temp.expect('00000000-0000-0000-0000-000000000203', 0, 'unlink from a zero balance adds nothing back');
select pg_temp.link('00000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-000000000202', 0);
select pg_temp.expect('00000000-0000-0000-0000-000000000202', 100, 'zero principal takes nothing');
select pg_temp.unlink('00000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-000000000202');
select pg_temp.expect('00000000-0000-0000-0000-000000000202', 100, 'and restores nothing');
insert into ids select 'p0', pg_temp.pay('00000000-0000-0000-0000-000000000203', 25);
select pg_temp.expect('00000000-0000-0000-0000-000000000203', 0, 'payment against a zero balance');
select pg_temp.unpay((select id from ids where name = 'p0'), '00000000-0000-0000-0000-000000000203');
select pg_temp.expect('00000000-0000-0000-0000-000000000203', 0, 'deleting it adds nothing back');

-- 5. Linked-principal edits, up and down, across the zero boundary.
select pg_temp.loan('00000000-0000-0000-0000-000000000204', 50);
select pg_temp.txn('00000000-0000-0000-0000-000000000304', 100);
select pg_temp.link('00000000-0000-0000-0000-000000000304', '00000000-0000-0000-0000-000000000204', 30);
select pg_temp.expect('00000000-0000-0000-0000-000000000204', 20, 'link 30 of 50');
select pg_temp.edit('00000000-0000-0000-0000-000000000304', '00000000-0000-0000-0000-000000000204', 80);
select pg_temp.expect('00000000-0000-0000-0000-000000000204', 0, 'edit up past the balance clamps');
select pg_temp.edit('00000000-0000-0000-0000-000000000304', '00000000-0000-0000-0000-000000000204', 10);
select pg_temp.expect('00000000-0000-0000-0000-000000000204', 40, 'edit back down restores the clamped application, then takes 10');
select pg_temp.edit('00000000-0000-0000-0000-000000000304', '00000000-0000-0000-0000-000000000204', 45);
select pg_temp.expect('00000000-0000-0000-0000-000000000204', 5, 'edit up within the balance');
select pg_temp.unlink('00000000-0000-0000-0000-000000000304', '00000000-0000-0000-0000-000000000204');
select pg_temp.expect('00000000-0000-0000-0000-000000000204', 50, 'unlink after edits restores the original balance');

-- 6. Manual-payment edits, up and down; non-principal edits and unchanged principals move nothing.
insert into ids select 'p2', pg_temp.pay('00000000-0000-0000-0000-000000000204', 30);
select pg_temp.expect('00000000-0000-0000-0000-000000000204', 20, 'payment 30 of 50');
select pg_temp.edit_pay((select id from ids where name = 'p2'), '00000000-0000-0000-0000-000000000204', 70);
select pg_temp.expect('00000000-0000-0000-0000-000000000204', 0, 'payment edited up past the balance clamps');
select pg_temp.edit_pay((select id from ids where name = 'p2'), '00000000-0000-0000-0000-000000000204', 5);
select pg_temp.expect('00000000-0000-0000-0000-000000000204', 45, 'payment edited back down');
select public.update_manual_loan_payment('00000000-0000-0000-0000-0000000000aa', (select id from ids where name = 'p2'),
  '00000000-0000-0000-0000-000000000204', true, '2026-09-11', false, null, true, 3, true, 'note');
select pg_temp.expect('00000000-0000-0000-0000-000000000204', 45, 'date/interest/notes edit leaves the balance alone');
select pg_temp.unpay((select id from ids where name = 'p2'), '00000000-0000-0000-0000-000000000204');
select pg_temp.expect('00000000-0000-0000-0000-000000000204', 50, 'payment delete after edits restores the original balance');

-- 7. Out-of-order undo: two applications, the second clamped; undo in either order.
select pg_temp.loan('00000000-0000-0000-0000-000000000205', 150);
select pg_temp.txn('00000000-0000-0000-0000-000000000305', 100);
select pg_temp.txn('00000000-0000-0000-0000-000000000306', 100);
select pg_temp.link('00000000-0000-0000-0000-000000000305', '00000000-0000-0000-0000-000000000205', 100);
select pg_temp.link('00000000-0000-0000-0000-000000000306', '00000000-0000-0000-0000-000000000205', 100);
select pg_temp.expect('00000000-0000-0000-0000-000000000205', 0, 'A takes 100, B the remaining 50');
select pg_temp.unlink('00000000-0000-0000-0000-000000000305', '00000000-0000-0000-0000-000000000205');
select pg_temp.expect('00000000-0000-0000-0000-000000000205', 100, 'undo A first: its full 100');
select pg_temp.unlink('00000000-0000-0000-0000-000000000306', '00000000-0000-0000-0000-000000000205');
select pg_temp.expect('00000000-0000-0000-0000-000000000205', 150, 'then B: its 50 — exactly the original');
select pg_temp.link('00000000-0000-0000-0000-000000000305', '00000000-0000-0000-0000-000000000205', 100);
insert into ids select 'p3', pg_temp.pay('00000000-0000-0000-0000-000000000205', 100);
select pg_temp.expect('00000000-0000-0000-0000-000000000205', 0, 'link 100 then payment of 100 (takes 50)');
select public.delete_transactions_and_restore_loan_balances('00000000-0000-0000-0000-0000000000aa', array['delta-305']);
select pg_temp.expect('00000000-0000-0000-0000-000000000205', 100, 'Plaid removes the first application');
select pg_temp.unpay((select id from ids where name = 'p3'), '00000000-0000-0000-0000-000000000205');
select pg_temp.expect('00000000-0000-0000-0000-000000000205', 150, 'then the payment is deleted — exactly the original');

-- 8. Exact round trip through a mixed sequence, including a sub-cent balance.
select pg_temp.loan('00000000-0000-0000-0000-000000000206', 1234.567);
select pg_temp.txn('00000000-0000-0000-0000-000000000307', 700);
select pg_temp.txn('00000000-0000-0000-0000-000000000308', 900);
select pg_temp.link('00000000-0000-0000-0000-000000000307', '00000000-0000-0000-0000-000000000206', 600.10);
insert into ids select 'p4', pg_temp.pay('00000000-0000-0000-0000-000000000206', 333.33);
select pg_temp.link('00000000-0000-0000-0000-000000000308', '00000000-0000-0000-0000-000000000206', 899.99);
select pg_temp.expect('00000000-0000-0000-0000-000000000206', 0, 'three applications exhaust the balance');
select pg_temp.edit('00000000-0000-0000-0000-000000000307', '00000000-0000-0000-0000-000000000206', 12.34);
insert into ids select 'p5', pg_temp.pay('00000000-0000-0000-0000-000000000206', 0.01);
select pg_temp.edit_pay((select id from ids where name = 'p4'), '00000000-0000-0000-0000-000000000206', 1000);
select pg_temp.unlink('00000000-0000-0000-0000-000000000308', '00000000-0000-0000-0000-000000000206');
select pg_temp.unpay((select id from ids where name = 'p5'), '00000000-0000-0000-0000-000000000206');
select pg_temp.unpay((select id from ids where name = 'p4'), '00000000-0000-0000-0000-000000000206');
select pg_temp.unlink('00000000-0000-0000-0000-000000000307', '00000000-0000-0000-0000-000000000206');
select pg_temp.expect('00000000-0000-0000-0000-000000000206', 1234.567, 'every application undone, in another order: exactly the original');

-- ---- From here on the new columns are referenced directly. ----

-- 9. What is recorded: 0 <= applied <= principal, cleared on unlink.
select pg_temp.loan('00000000-0000-0000-0000-000000000207', 40);
select pg_temp.txn('00000000-0000-0000-0000-000000000309', 100);
select pg_temp.link('00000000-0000-0000-0000-000000000309', '00000000-0000-0000-0000-000000000207', 100);
select th.assert((select loan_balance_applied = 40 and principal_portion = 100 from public.transactions
                  where id = '00000000-0000-0000-0000-000000000309'), 'link records the 40 actually applied');
insert into ids select 'p6', pg_temp.pay('00000000-0000-0000-0000-000000000207', 10);
select th.assert((select balance_applied = 0 and principal_portion = 10 from public.manual_loan_payments
                  where id = (select id from ids where name = 'p6')), 'payment against a zero balance records 0');
select pg_temp.unlink('00000000-0000-0000-0000-000000000309', '00000000-0000-0000-0000-000000000207');
select th.assert((select loan_balance_applied is null and manual_loan_id is null from public.transactions
                  where id = '00000000-0000-0000-0000-000000000309'), 'unlink clears the recorded delta');
select th.assert(not exists (select 1 from public.transactions where manual_loan_id is not null
                             and not (loan_balance_applied between 0 and principal_portion)), 'every linked row: 0 <= applied <= principal');
select th.assert(not exists (select 1 from public.manual_loan_payments
                             where not (balance_applied between 0 and principal_portion)), 'every payment: 0 <= applied <= principal');

-- 10. An unchanged principal is a no-op, even after the balance was edited by hand.
select pg_temp.link('00000000-0000-0000-0000-000000000309', '00000000-0000-0000-0000-000000000207', 100);
update public.manual_loans set current_balance = 1000 where id = '00000000-0000-0000-0000-000000000207';
select pg_temp.edit('00000000-0000-0000-0000-000000000309', '00000000-0000-0000-0000-000000000207', 100);
select pg_temp.expect('00000000-0000-0000-0000-000000000207', 1000, 'unchanged linked principal moves nothing');
select pg_temp.edit_pay((select id from ids where name = 'p6'), '00000000-0000-0000-0000-000000000207', 10);
select pg_temp.expect('00000000-0000-0000-0000-000000000207', 1000, 'unchanged payment principal moves nothing');
select th.assert((select loan_balance_applied = 40 from public.transactions where id = '00000000-0000-0000-0000-000000000309'),
  'and records nothing new');

-- 11. Legacy rows (NULL: linked/paid before the migration) keep the previous behaviour.
select pg_temp.loan('00000000-0000-0000-0000-000000000208', 0);
insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name, manual_loan_id, principal_portion,
  auto_role, role_source, role_confidence, classifier_version) values
  ('00000000-0000-0000-0000-000000000310', '00000000-0000-0000-0000-0000000000a1', 'delta-310', 100, '2026-09-01', 'Legacy payment',
   '00000000-0000-0000-0000-000000000208', 100, 'debt_payment', 'manual_loan_link', 'high', 1),
  ('00000000-0000-0000-0000-000000000311', '00000000-0000-0000-0000-0000000000a1', 'delta-311', 100, '2026-09-02', 'Legacy payment',
   '00000000-0000-0000-0000-000000000208', 60.004, 'debt_payment', 'manual_loan_link', 'high', 1),
  ('00000000-0000-0000-0000-000000000312', '00000000-0000-0000-0000-0000000000a1', 'delta-312', 100, '2026-09-03', 'Legacy payment',
   '00000000-0000-0000-0000-000000000208', 30, 'debt_payment', 'manual_loan_link', 'high', 1);
insert into public.manual_loan_payments (id, user_id, loan_id, date, principal_portion, interest_portion) values
  ('00000000-0000-0000-0000-000000000401', '00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000208', '2026-09-01', 40, 0),
  ('00000000-0000-0000-0000-000000000402', '00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000208', '2026-09-02', 20, 0);
select th.assert((select count(*) = 3 from public.transactions where loan_balance_applied is null and manual_loan_id = '00000000-0000-0000-0000-000000000208')
                 and (select count(*) = 2 from public.manual_loan_payments where balance_applied is null and loan_id = '00000000-0000-0000-0000-000000000208'),
  'legacy rows carry NULL');
select pg_temp.unlink('00000000-0000-0000-0000-000000000310', '00000000-0000-0000-0000-000000000208');
select pg_temp.expect('00000000-0000-0000-0000-000000000208', 100, 'legacy unlink restores the full principal, as before');
select public.delete_transactions_and_restore_loan_balances('00000000-0000-0000-0000-0000000000aa', array['delta-311']);
select pg_temp.expect('00000000-0000-0000-0000-000000000208', 160, 'legacy Plaid removal: full principal, rounded to cents, as before');
select pg_temp.unpay('00000000-0000-0000-0000-000000000401', '00000000-0000-0000-0000-000000000208');
select pg_temp.expect('00000000-0000-0000-0000-000000000208', 200, 'legacy payment delete: full principal, as before');
update public.manual_loans set current_balance = 20 where id = '00000000-0000-0000-0000-000000000208';
select pg_temp.edit('00000000-0000-0000-0000-000000000312', '00000000-0000-0000-0000-000000000208', 10);
select pg_temp.expect('00000000-0000-0000-0000-000000000208', 40, 'legacy linked edit: undo the full old 30, take 10 (as before)');
select th.assert((select loan_balance_applied = 10 from public.transactions where id = '00000000-0000-0000-0000-000000000312'),
  'and records the new application');
select pg_temp.unlink('00000000-0000-0000-0000-000000000312', '00000000-0000-0000-0000-000000000208');
select pg_temp.expect('00000000-0000-0000-0000-000000000208', 50, 'which is then restored exactly');
select pg_temp.edit_pay('00000000-0000-0000-0000-000000000402', '00000000-0000-0000-0000-000000000208', 70);
select pg_temp.expect('00000000-0000-0000-0000-000000000208', 0, 'legacy payment edit: undo 20, take the remaining 70');
select th.assert((select balance_applied = 70 from public.manual_loan_payments where id = '00000000-0000-0000-0000-000000000402'),
  'and records it');
select pg_temp.unpay('00000000-0000-0000-0000-000000000402', '00000000-0000-0000-0000-000000000208');
select pg_temp.expect('00000000-0000-0000-0000-000000000208', 70, 'then restores exactly that');

-- 12. A loan deleted under a link (FK ON DELETE SET NULL) leaves a stale delta nobody reads; relinking
-- overwrites it.
select pg_temp.loan('00000000-0000-0000-0000-000000000209', 30);
select pg_temp.loan('00000000-0000-0000-0000-000000000210', 10);
select pg_temp.txn('00000000-0000-0000-0000-000000000313', 100);
select pg_temp.link('00000000-0000-0000-0000-000000000313', '00000000-0000-0000-0000-000000000209', 25);
reset role;
delete from public.manual_loans where id = '00000000-0000-0000-0000-000000000209';
set role service_role;
select th.assert((select manual_loan_id is null and loan_balance_applied = 25 from public.transactions
                  where id = '00000000-0000-0000-0000-000000000313'), 'stale delta left by the FK');
select pg_temp.link('00000000-0000-0000-0000-000000000313', '00000000-0000-0000-0000-000000000210', 25);
select th.assert((select loan_balance_applied = 10 from public.transactions where id = '00000000-0000-0000-0000-000000000313'),
  'relinking records its own delta');
select pg_temp.unlink('00000000-0000-0000-0000-000000000313', '00000000-0000-0000-0000-000000000210');
select pg_temp.expect('00000000-0000-0000-0000-000000000210', 10, 'and restores exactly that, not the stale 25');

-- 13. The recorded delta must be a finite non-negative number.
select th.expect_error($q$ update public.transactions set loan_balance_applied = -1 where id = '00000000-0000-0000-0000-000000000313' $q$,
  '%transactions_loan_balance_applied_check%');
select th.expect_error($q$ update public.transactions set loan_balance_applied = 'NaN' where id = '00000000-0000-0000-0000-000000000313' $q$,
  '%transactions_loan_balance_applied_check%');
select th.expect_error($q$ update public.manual_loan_payments set balance_applied = 'Infinity' where id = (select id from ids where name = 'p6') $q$,
  '%manual_loan_payments_balance_applied_check%');
reset role;
