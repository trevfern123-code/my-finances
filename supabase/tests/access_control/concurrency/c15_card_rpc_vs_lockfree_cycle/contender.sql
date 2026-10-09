-- A lock-free writer that starts once the RPC holds L2: takes row B (L3), then its trigger bump waits
-- for L2. The RPC observes this before writing B, so the cycle is established, not timed.
select th.wait_for_application('c15-rpc-holding-l2');
select set_config('application_name', 'c15-writer', false);
begin;
set local role service_role;
do $$
begin
  update public.transactions set amount = 202 where plaid_transaction_id = 'c15-b';
  insert into public.th_c15_outcome values ('contender', 'committed');
exception when deadlock_detected then
  insert into public.th_c15_outcome values ('contender', 'deadlock');
end $$;
commit;
