-- History-mode equivalent of seed.sql: the same two users, items, accounts and budget categories,
-- shaped for the REAL schema (supabase/migrations/*), which requires auth.users rows for its foreign
-- keys, a Plaid access token per item, and a Plaid id and name per account. Run as supabase_admin.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000aa', 'user-aa@phase-a.test'),
  ('00000000-0000-0000-0000-0000000000bb', 'user-bb@phase-a.test');
insert into public.plaid_items (id, user_id, plaid_item_id, access_token) values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000aa', 'item-aa', 'disposable-test-token-aa'),
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000bb', 'item-bb', 'disposable-test-token-bb');
insert into public.accounts (id, item_id, plaid_account_id, name) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001', 'acct-a1', 'AA Checking'),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000001', 'acct-a2', 'AA Savings'),
  ('00000000-0000-0000-0000-0000000000a9', '00000000-0000-0000-0000-000000000002', 'acct-a9', 'BB Checking');
insert into public.budget_categories (id, user_id, name) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000aa', 'AA category'),
  ('00000000-0000-0000-0000-0000000000c9', '00000000-0000-0000-0000-0000000000bb', 'BB category');
