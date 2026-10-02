-- A lock-free writer (no advisory lock — an old backend or a direct update): its trigger bump takes
-- the user's version row (L2). It announces that, then holds L2 until it has OBSERVED the evaluator
-- blocked on it (bounded coordination; no sleep), and only then commits.
begin;
set local role service_role;
update public.transactions set amount = 98 where plaid_transaction_id = 'c12-pay';
reset role;
select set_config('application_name', 'c12-writer-holding-l2', false);
select th.wait_until_blocked_by(th.wait_for_application('c12-evaluator'), pg_backend_pid());
commit;
