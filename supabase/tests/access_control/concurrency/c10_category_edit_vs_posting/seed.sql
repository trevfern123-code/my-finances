-- K15: a category edit racing the posting of the same pending row (continuity design §6, §8).
set role service_role;
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-000000000ca1', '00000000-0000-0000-0000-000000000001', 'acct-c10', 'Checking', 'depository');
insert into public.budget_categories (id, user_id, name) values
  ('00000000-0000-0000-0000-000000000cc1', '00000000-0000-0000-0000-0000000000aa', 'Groceries');
insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name, pending, category,
  auto_role, role_source, role_confidence, classifier_version)
values ('00000000-0000-0000-0000-000000000cd1', '00000000-0000-0000-0000-000000000ca1', 'c10-p', 52.10, '2026-09-10', 'Pending', true, 'FOOD_AND_DRINK',
  'expense', 'sign_default', 'low', 1);
