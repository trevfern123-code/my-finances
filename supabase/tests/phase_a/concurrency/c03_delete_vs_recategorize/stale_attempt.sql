-- The deletion's RPC call, carrying the payload built from T BEFORE the sync (psql variable
-- `payload`, produced by the real classifier). It must block behind the sync's lock and then reject.
set role service_role;
select pg_sleep(1.5);

select th.assert(:'payload'::jsonb -> 0 ->> 'auto_role' = 'expense'
                 and :'payload'::jsonb -> 0 ->> 'exp_category' = 'GENERAL_MERCHANDISE',
  'precondition: the stale payload was classified from the pre-sync ordinary category');

select clock_timestamp() as started \gset
select th.expect_error(
  format('select public.delete_manual_loan_atomic(%L, %L, %L::jsonb)',
    '00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000d5', :'payload'),
  '%changed since they were classified%');
select th.assert(clock_timestamp() - :'started'::timestamptz > interval '1.5 seconds',
  'the deletion must have waited for the sync''s lock rather than running alongside it');

-- Rejected atomically: loan intact, T still linked, the sync's new category in place, loan role kept.
select th.assert(exists (select 1 from public.manual_loans where id = '00000000-0000-0000-0000-0000000000d5'), 'loan still exists');
select th.assert((select manual_loan_id = '00000000-0000-0000-0000-0000000000d5' and principal_portion = 50
                    and category = 'LOAN_PAYMENTS' and auto_role = 'debt_payment' and role_source = 'manual_loan_link'
                  from public.transactions where id = '00000000-0000-0000-0000-0000000000f1'),
  'T unchanged by the rejected deletion (still linked, principal 50, synced category, loan role)');
select th.assert(not exists (select 1 from public.manual_loan_deletions), 'no tombstone written');
