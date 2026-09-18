set role service_role;
select pg_sleep(1.5);
select clock_timestamp() as started \gset
select public.create_manual_loan_idempotent('00000000-0000-0000-0000-0000000000aa', 'K-RACE', 'Race Loan', 'personal',
  500, null, null, null, null, null, null, null, null) as loan_id \gset
select th.assert(clock_timestamp() - :'started'::timestamptz > interval '1.5 seconds', 'second create waited for the first');
select th.assert(:'loan_id'::uuid = (select loan_id from public.manual_loan_creation_requests where idempotency_key = 'K-RACE'),
  'second create replayed the first create''s loan');
