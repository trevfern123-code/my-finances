select th.assert((select count(*) from public.manual_loans where name = 'Race Loan') = 1, 'exactly one loan created');
select th.assert((select count(*) from public.manual_loan_creation_requests where idempotency_key = 'K-RACE') = 1, 'exactly one key record');
