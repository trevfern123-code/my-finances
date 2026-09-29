set role service_role;
select th.assert((select budget_category_id = '00000000-0000-0000-0000-000000000cc2' and budget_category_source = 'mapping' and budget_category_set_seq is not null
                  from public.transactions where plaid_transaction_id = 'c11-q'),
  'posting first: the backfill then filled Q (same Plaid category as the pending row)');
select th.assert((select budget_category_id is null and budget_category_source = 'user' from public.transactions where id = '00000000-0000-0000-0000-000000000cd3'),
  'the user-cleared row was skipped');
