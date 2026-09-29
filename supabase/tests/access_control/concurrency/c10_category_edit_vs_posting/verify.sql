set role service_role;
select th.assert(not exists (select 1 from public.transactions where id = '00000000-0000-0000-0000-000000000cd1'), 'pending row gone');
select th.assert((select consumed_by_transaction_id = (select id from public.transactions where plaid_transaction_id = 'c10-q')
                  from public.transaction_carryovers
                  where user_id = '00000000-0000-0000-0000-0000000000aa' and pending_transaction_row_id = '00000000-0000-0000-0000-000000000cd1'),
  'the superseded lookup (user-scoped) finds the posted row');
select th.assert(not exists (select 1 from public.transaction_carryovers
                             where user_id = '00000000-0000-0000-0000-0000000000bb' and pending_transaction_row_id = '00000000-0000-0000-0000-000000000cd1'),
  'another user looking up the same id finds nothing');
select th.assert((select budget_category_id is null from public.transactions where plaid_transaction_id = 'c10-q'), 'the late edit wrote nothing');
