select th.assert(not exists (select 1 from public.transactions where plaid_transaction_id = 'c08-late'), 'the late batch wrote nothing');
select th.assert(not exists (select 1 from public.accounts where id = '00000000-0000-0000-0000-0000000008a1'), 'account deleted');
select th.assert((select status from public.plaid_item_removals where item_id = '00000000-0000-0000-0000-000000000001') = 'cleaned',
  'operation cleaned');
