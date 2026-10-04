-- A lock-free writer that starts only once the evaluation holds L2: its row write proceeds, its bump
-- waits on L2 (the evaluator confirms it observed this), and it lands after the evaluation published.
select th.wait_for_application('c13-evaluator-holding-l2');
select set_config('application_name', 'c13-writer', false);
set role service_role;
update public.transactions set amount = 98 where plaid_transaction_id = 'c13-pay';
