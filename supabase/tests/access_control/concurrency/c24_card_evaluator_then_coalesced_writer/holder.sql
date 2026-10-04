-- Evaluator first: an evaluation keeps its transaction (L1 and L2) open until it has OBSERVED the
-- writer blocked on it.
begin;
set local role service_role;
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa', '2026-10-01T00:00:00Z');
reset role;
select set_config('application_name', 'c24-evaluator-holding-l2', false);
select th.wait_until_blocked_by(th.wait_for_application('c24-writer'), pg_backend_pid());
commit;
