-- Two loans whose match rules both match transaction T; two callers pick T as an unlinked candidate,
-- one for loan L1 and one for loan L2.
set role service_role;
insert into public.manual_loans (id, user_id, name, current_balance) values
  ('00000000-0000-0000-0000-0000000008d1', '00000000-0000-0000-0000-0000000000aa', 'Stale Loan 1', 1000),
  ('00000000-0000-0000-0000-0000000008d2', '00000000-0000-0000-0000-0000000000aa', 'Stale Loan 2', 1000);
insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name, auto_role, role_source, role_confidence, classifier_version)
values ('00000000-0000-0000-0000-0000000008e1', '00000000-0000-0000-0000-0000000000a1', 'stale-t', 100, '2026-09-10', 'Loan payment', 'expense', 'sign_default', 'low', 1);
