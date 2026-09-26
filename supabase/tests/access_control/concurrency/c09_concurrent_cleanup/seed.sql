-- Item 1 (user aa) with a payment linked to L1 (1000 -> 900), confirmed removed at Plaid.
set role service_role;
insert into public.accounts (id, item_id, plaid_account_id, name) values
  ('00000000-0000-0000-0000-0000000009a1', '00000000-0000-0000-0000-000000000001', 'acct-c09', 'C09 Checking');
insert into public.manual_loans (id, user_id, name, current_balance) values
  ('00000000-0000-0000-0000-0000000009b1', '00000000-0000-0000-0000-0000000000aa', 'C09 Loan', 1000);
insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name,
  auto_role, role_source, role_confidence, classifier_version) values
  ('00000000-0000-0000-0000-0000000009d1', '00000000-0000-0000-0000-0000000009a1', 'c09-t1', 100, '2026-09-10', 'Loan payment',
   'expense', 'sign_default', 'low', 1);
select public.link_transaction_to_manual_loan('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000009d1',
  '00000000-0000-0000-0000-0000000009b1', 100, 1::smallint);
select public.begin_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001',
  public.plaid_item_removal_digest('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001'));
select public.record_plaid_item_removal_attempt('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', 'removed', null);
