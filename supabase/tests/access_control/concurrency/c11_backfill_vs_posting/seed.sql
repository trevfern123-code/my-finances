-- K19 (posting first): the mapping backfill waits on the posting, then fills the posted row (same Plaid
-- category) and still skips a user-cleared row.
set role service_role;
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-000000000cb1', '00000000-0000-0000-0000-000000000001', 'acct-c11', 'Checking', 'depository');
insert into public.budget_categories (id, user_id, name) values
  ('00000000-0000-0000-0000-000000000cc2', '00000000-0000-0000-0000-0000000000aa', 'Groceries');
insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name, pending, category,
  auto_role, role_source, role_confidence, classifier_version)
values ('00000000-0000-0000-0000-000000000cd2', '00000000-0000-0000-0000-000000000cb1', 'c11-p', 52.10, '2026-09-10', 'Pending', true, 'FOOD_AND_DRINK',
        'expense', 'sign_default', 'low', 1),
       ('00000000-0000-0000-0000-000000000cd3', '00000000-0000-0000-0000-000000000cb1', 'c11-u', 20, '2026-09-10', 'Cleared', false, 'FOOD_AND_DRINK',
        'expense', 'sign_default', 'low', 1);
select public.set_transaction_budget_category('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000cd3', null);
