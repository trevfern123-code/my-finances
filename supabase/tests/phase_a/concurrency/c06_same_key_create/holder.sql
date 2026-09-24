-- Round 8 regression: two concurrent creates with the same idempotency key and payload.
set role service_role;
begin;
select public.create_manual_loan_idempotent('00000000-0000-0000-0000-0000000000aa', 'K-RACE', 'Race Loan', 'personal',
  500, null, null, null, null, null, null, null, null);
select pg_sleep(4);
commit;
