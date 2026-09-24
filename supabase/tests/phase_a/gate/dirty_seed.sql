-- PRE-migration rows violating each of the nine new constraints exactly once (ids ...00d1-...00d9
-- are violators), plus valid rows (...00e*) that must never be reported. Works on both the scaffold
-- and the real schema. Violators whose ids end in d1..d9 map 1:1 to the constraints in this order:
--   d1 manual_loans_current_balance_check            d6 transactions_amount_finite_check
--   d2 manual_loans_origination_principal_amount     d7 transactions_principal_portion_check
--   d3 manual_loans_interest_rate_percentage         d8 manual_loan_payments_principal_portion_check
--   d4 manual_loans_minimum_payment_amount           d9 manual_loan_payments_interest_portion_check
--   d5 manual_loans_term_months_check
insert into public.manual_loans (id, user_id, name, current_balance, origination_principal_amount, interest_rate_percentage, minimum_payment_amount, term_months) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000aa', 'neg balance',   -5,    null,       null,  null, null),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000aa', 'inf principal', 10,    'Infinity', null,  null, null),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000aa', 'nan rate',      10,    null,       'NaN', null, null),
  ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000aa', 'neg min pay',   10,    null,       null,  -1,   null),
  ('00000000-0000-0000-0000-0000000000d5', '00000000-0000-0000-0000-0000000000aa', 'zero term',     10,    null,       null,  null, 0),
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000aa', 'valid loan',    1000,  5000,       4.5,   100,  60),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000aa', 'zero balance',  0,     null,       null,  null, null);

insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name, manual_loan_id, principal_portion) values
  ('00000000-0000-0000-0000-0000000000d6', '00000000-0000-0000-0000-0000000000a1', 'dirty-nan-amount', 'NaN', '2026-09-01', 'NaN amount', null, null),
  ('00000000-0000-0000-0000-0000000000d7', '00000000-0000-0000-0000-0000000000a1', 'dirty-neg-principal', 50, '2026-09-01', 'neg principal', '00000000-0000-0000-0000-0000000000e1', -1),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000a1', 'clean-expense', 42.10, '2026-09-01', 'Coffee', null, null),
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000a1', 'clean-income', -1500, '2026-09-01', 'Paycheck', null, null);

insert into public.manual_loan_payments (id, user_id, loan_id, date, principal_portion, interest_portion) values
  ('00000000-0000-0000-0000-0000000000d8', '00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000e1', '2026-08-01', 'NaN', 0),
  ('00000000-0000-0000-0000-0000000000d9', '00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000e1', '2026-08-02', 1, -2),
  ('00000000-0000-0000-0000-0000000000e5', '00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000e1', '2026-08-03', 100, 5);
