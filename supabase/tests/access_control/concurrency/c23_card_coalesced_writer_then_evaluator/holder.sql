-- Writer first: ONE transaction makes three input writes (the first bumps; the others are coalesced into
-- it), holds L2 until it has OBSERVED the evaluator blocked on it, then commits.
begin;
set local role service_role;
update public.transactions set amount = 98 where plaid_transaction_id = 'c23-pay';
insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override) values
  ('00000000-0000-0000-0000-0000000c1c01', 'c23-extra', 55, '2026-09-05', 'credit_card_payment');
update public.transactions set amount = -97 where plaid_transaction_id = 'c23-card';
reset role;
select set_config('application_name', 'c23-writer-holding-l2', false);
select th.wait_until_blocked_by(th.wait_for_application('c23-evaluator'), pg_backend_pid());
commit;
