-- Item 1 (user aa) with account R1, confirmed removed at Plaid (ITEM_NOT_FOUND).
set role service_role;
insert into public.accounts (id, item_id, plaid_account_id, name) values
  ('00000000-0000-0000-0000-0000000008a1', '00000000-0000-0000-0000-000000000001', 'acct-c08', 'C08 Checking');
select public.begin_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001',
  public.plaid_item_removal_digest('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001'));
select public.record_plaid_item_removal_attempt('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001',
  'already_removed', 'ITEM_NOT_FOUND');
