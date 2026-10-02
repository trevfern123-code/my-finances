-- A writer in a NEW transaction on the already-stale user. Its first bump must take L2 (no earlier bump of
-- its own stands, so it may not skip), and it holds L2 until it has OBSERVED the evaluator blocked on it.
begin;
set local role service_role;
update public.transactions set amount = 98 where plaid_transaction_id = 'c25-pay';
reset role;
select set_config('application_name', 'c25-writer-holding-l2', false);
select th.wait_until_blocked_by(th.wait_for_application('c25-evaluator'), pg_backend_pid());
commit;
