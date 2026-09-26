-- Item 1 (user aa) with account R1 and an unlinked payment T1, and loan L1 at 1000. The removal is
-- already confirmed at Plaid (plaid_removed), so local cleanup is the next step.
set role service_role;
insert into public.accounts (id, item_id, plaid_account_id, name) values
  ('00000000-0000-0000-0000-0000000007a1', '00000000-0000-0000-0000-000000000001', 'acct-c07', 'C07 Checking');
insert into public.manual_loans (id, user_id, name, current_balance) values
  ('00000000-0000-0000-0000-0000000007b1', '00000000-0000-0000-0000-0000000000aa', 'C07 Loan', 1000);
insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name,
  auto_role, role_source, role_confidence, classifier_version) values
  ('00000000-0000-0000-0000-0000000007d1', '00000000-0000-0000-0000-0000000007a1', 'c07-t1', 100, '2026-09-10', 'Loan payment',
   'expense', 'sign_default', 'low', 1);
select public.begin_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001',
  public.plaid_item_removal_digest('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001'));
select public.record_plaid_item_removal_attempt('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', 'removed', null);
