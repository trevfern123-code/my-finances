-- Round 10 blocker 5. Deletion classifies the linked set {E1}; a concurrent link adds E2 first.
set role service_role;
insert into public.manual_loans (id, user_id, name, current_balance)
values ('00000000-0000-0000-0000-0000000000d8', '00000000-0000-0000-0000-0000000000aa', 'Delete Race Loan', 1000);
insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name,
  auto_role, role_source, role_confidence, classifier_version) values
  ('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-0000000000a1', 'dr-e1', 50, '2026-09-10', 'E1', 'expense', 'sign_default', 'low', 1),
  ('00000000-0000-0000-0000-0000000000f5', '00000000-0000-0000-0000-0000000000a1', 'dr-e2', 60, '2026-09-10', 'E2', 'expense', 'sign_default', 'low', 1);
select public.link_transaction_to_manual_loan('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000f4',
  '00000000-0000-0000-0000-0000000000d8', 20, 1::smallint);
