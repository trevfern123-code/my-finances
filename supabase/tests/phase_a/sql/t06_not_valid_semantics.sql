-- Round 16: proves the corrected documentation. A NOT VALID CHECK constraint is checked against the
-- COMPLETE row on every later UPDATE — so an update touching only an UNRELATED column of a
-- pre-existing violating row fails. (This is why the migration refuses to install the constraints
-- over dirty data at all.) The pre-existing violator is manufactured by briefly removing a
-- constraint as the table owner, exactly reproducing "row predates the constraint".

alter table public.manual_loans drop constraint manual_loans_current_balance_check;
insert into public.manual_loans (id, user_id, name, current_balance)
values ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000aa', 'legacy violator', -5);
alter table public.manual_loans
  add constraint manual_loans_current_balance_check
    check (current_balance >= 0 and current_balance < 'Infinity'::numeric) not valid;

alter table public.transactions drop constraint transactions_amount_finite_check;
insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name)
values ('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-0000000000a1', 'legacy-nan', 'NaN', '2026-09-01', 'legacy');
alter table public.transactions
  add constraint transactions_amount_finite_check
    check (amount > -'Infinity'::numeric and amount < 'Infinity'::numeric) not valid;

select th.assert((select not convalidated from pg_constraint where conname = 'manual_loans_current_balance_check'),
  'precondition: constraint is NOT VALID');

-- The violating rows are still readable...
select th.assert((select current_balance = -5 from public.manual_loans where id = '00000000-0000-0000-0000-00000000aa01'),
  'pre-existing violator was not scanned or changed when the NOT VALID constraint was added');

-- ...but an update of an UNRELATED column is rejected, as service_role and as the table owner.
set role service_role;
select th.expect_error($q$ update public.manual_loans set notes = 'just a note' where id = '00000000-0000-0000-0000-00000000aa01' $q$,
  '%manual_loans_current_balance_check%');
select th.expect_error($q$ update public.transactions set name = 'renamed' where id = '00000000-0000-0000-0000-00000000aa02' $q$,
  '%transactions_amount_finite_check%');
reset role;
select th.expect_error($q$ update public.manual_loans set name = 'renamed' where id = '00000000-0000-0000-0000-00000000aa01' $q$,
  '%manual_loans_current_balance_check%');

-- Fixing the violating column (one UPDATE correcting every bad column) is accepted.
update public.manual_loans set current_balance = 0, notes = 'corrected' where id = '00000000-0000-0000-0000-00000000aa01';
update public.transactions set amount = 0 where id = '00000000-0000-0000-0000-00000000aa02';
