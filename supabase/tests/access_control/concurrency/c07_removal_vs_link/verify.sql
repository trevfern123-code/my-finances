select th.assert((select current_balance from public.manual_loans where id = '00000000-0000-0000-0000-0000000007b1') = 1000,
  'the late link was applied and then restored exactly: back to 1000');
select th.assert(not exists (select 1 from public.transactions where id = '00000000-0000-0000-0000-0000000007d1'), 'T1 deleted');
select th.assert(not exists (select 1 from public.plaid_items where id = '00000000-0000-0000-0000-000000000001'), 'item deleted');
select th.assert((select status from public.plaid_item_removals where item_id = '00000000-0000-0000-0000-000000000001') = 'cleaned',
  'operation cleaned');
