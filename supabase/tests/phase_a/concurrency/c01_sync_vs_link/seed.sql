-- Round 10 blocker 3. Sync classifies T from an unlinked snapshot (amount 100); a link to a loan
-- with principal 80 commits first; the sync then tries to write amount 20 plus non-loan roles.
set role service_role;
insert into public.manual_loans (id, user_id, name, current_balance)
values ('00000000-0000-0000-0000-0000000000d7', '00000000-0000-0000-0000-0000000000aa', 'Link Race Loan', 1000);
insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name, merchant_name,
  auto_role, role_source, role_confidence, classifier_version)
values ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000a1', 'link-race-t', 100, '2026-09-10',
  'Payment', 'Lender', 'expense', 'sign_default', 'low', 1);
