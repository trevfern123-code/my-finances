select th.assert((select user_id from public.plaid_items where id = '00000000-0000-0000-0000-000000000001')
  = '00000000-0000-0000-0000-0000000000bb', 'precondition: the re-parenting committed');
select th.assert(exists (select 1 from public.manual_loans where id = '00000000-0000-0000-0000-0000000000d6'), 'loan not deleted');
select th.assert((select manual_loan_id = '00000000-0000-0000-0000-0000000000d6' and principal_portion = 10 and role_source = 'manual_loan_link'
                  from public.transactions where id = '00000000-0000-0000-0000-0000000000f2'),
  'G not reclassified on the strength of a stale ownership chain');
select th.assert(not exists (select 1 from public.manual_loan_deletions), 'no tombstone written');
