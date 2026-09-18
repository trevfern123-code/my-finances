-- NaN / Infinity / -Infinity rejection everywhere a numeric invariant is enforced (Round 10 H2),
-- without breaking legitimate zero, negative-amount or null values.
set role service_role;

insert into public.manual_loans (id, user_id, name, current_balance)
values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000aa', 'Finite', 1000);
insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name, auto_role, role_source, role_confidence, classifier_version)
values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'fin-e1', 40, '2026-09-10', 'E1', 'expense', 'sign_default', 'low', 1);

-- Table-level constraints on manual_loans.
select th.expect_error($q$ insert into public.manual_loans (user_id, name, current_balance) values ('00000000-0000-0000-0000-0000000000aa', 'x', 'NaN') $q$, '%manual_loans_current_balance_check%');
select th.expect_error($q$ insert into public.manual_loans (user_id, name, current_balance) values ('00000000-0000-0000-0000-0000000000aa', 'x', 'Infinity') $q$, '%manual_loans_current_balance_check%');
select th.expect_error($q$ insert into public.manual_loans (user_id, name, current_balance) values ('00000000-0000-0000-0000-0000000000aa', 'x', '-Infinity') $q$, '%manual_loans_current_balance_check%');
select th.expect_error($q$ insert into public.manual_loans (user_id, name, current_balance) values ('00000000-0000-0000-0000-0000000000aa', 'x', -1) $q$, '%manual_loans_current_balance_check%');
select th.expect_error($q$ insert into public.manual_loans (user_id, name, current_balance, interest_rate_percentage) values ('00000000-0000-0000-0000-0000000000aa', 'x', 1, 'NaN') $q$, '%interest_rate_percentage_check%');
select th.expect_error($q$ insert into public.manual_loans (user_id, name, current_balance, minimum_payment_amount) values ('00000000-0000-0000-0000-0000000000aa', 'x', 1, 'Infinity') $q$, '%minimum_payment_amount_check%');
select th.expect_error($q$ insert into public.manual_loans (user_id, name, current_balance, origination_principal_amount) values ('00000000-0000-0000-0000-0000000000aa', 'x', 1, 'NaN') $q$, '%origination_principal_amount_check%');
insert into public.manual_loans (user_id, name, current_balance, interest_rate_percentage, minimum_payment_amount, origination_principal_amount)
values ('00000000-0000-0000-0000-0000000000aa', 'zero and null are fine', 0, null, 0, null);

-- Table-level constraints on transactions and manual_loan_payments.
select th.expect_error($q$ insert into public.transactions (account_id, plaid_transaction_id, amount, date) values ('00000000-0000-0000-0000-0000000000a1', 'nan', 'NaN', '2026-09-10') $q$, '%transactions_amount_finite_check%');
select th.expect_error($q$ insert into public.transactions (account_id, plaid_transaction_id, amount, date, principal_portion) values ('00000000-0000-0000-0000-0000000000a1', 'nanpp', 10, '2026-09-10', 'NaN') $q$, '%transactions_principal_portion_check%');
insert into public.transactions (account_id, plaid_transaction_id, amount, date) values ('00000000-0000-0000-0000-0000000000a1', 'negative-is-fine', -42.5, '2026-09-10');
select th.expect_error($q$ insert into public.manual_loan_payments (user_id, loan_id, date, principal_portion, interest_portion) values ('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000d1', '2026-09-10', 'NaN', 0) $q$, '%manual_loan_payments_principal_portion_check%');
select th.expect_error($q$ insert into public.manual_loan_payments (user_id, loan_id, date, principal_portion, interest_portion) values ('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000d1', '2026-09-10', 1, 'Infinity') $q$, '%manual_loan_payments_interest_portion_check%');

-- RPC-level guards.
select th.expect_error($q$ select public.create_manual_loan_payment('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000d1', '2026-09-10', 'NaN', 0, null) $q$, '%principal_portion must be a finite%');
select th.expect_error($q$ select public.create_manual_loan_payment('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000d1', '2026-09-10', 1, 'Infinity', null) $q$, '%interest_portion must be a finite%');
select th.expect_error($q$ select public.create_manual_loan_payment('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000d1', '2026-09-10', '-Infinity', 0, null) $q$, '%principal_portion must be a finite%');
select public.create_manual_loan_payment('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000d1', '2026-09-10', 100, 5, 'ok') as payment \gset
select th.assert((select current_balance from public.manual_loans where id = '00000000-0000-0000-0000-0000000000d1') = 900, 'finite payment applied to balance');
select th.expect_error(format('select public.update_manual_loan_payment(%L, %L, %L, false, null, true, %L, false, null, false, null)',
  '00000000-0000-0000-0000-0000000000aa', :'payment', '00000000-0000-0000-0000-0000000000d1', 'NaN'), '%principal_portion must be a finite%');
select th.expect_error($q$ select public.link_transaction_to_manual_loan('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1', 'NaN', 1::smallint) $q$, '%must be a finite value%');
select th.expect_error($q$ select public.link_transaction_to_manual_loan('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1', 'Infinity', 1::smallint) $q$, '%must be a finite value%');
select public.link_transaction_to_manual_loan('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1', 0, 1::smallint);
select th.expect_error($q$ select public.update_linked_payment_principal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1', 'NaN') $q$, '%must be a finite value%');
select th.assert((select current_balance from public.manual_loans where id = '00000000-0000-0000-0000-0000000000d1') = 900, 'balance never poisoned');

-- NOT VALID: created without scanning existing rows (all nine still unvalidated) yet enforced above.
reset role;
select th.assert((select count(*) from pg_constraint where contype = 'c' and not convalidated
  and conname in ('manual_loans_current_balance_check', 'manual_loans_origination_principal_amount_check',
    'manual_loans_interest_rate_percentage_check', 'manual_loans_minimum_payment_amount_check', 'manual_loans_term_months_check',
    'transactions_amount_finite_check', 'transactions_principal_portion_check',
    'manual_loan_payments_principal_portion_check', 'manual_loan_payments_interest_portion_check')) = 9,
  'all nine numeric constraints are NOT VALID');
