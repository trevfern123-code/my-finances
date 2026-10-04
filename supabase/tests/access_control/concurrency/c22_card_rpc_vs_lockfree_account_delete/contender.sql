-- The RPC: matches c22-p with c22-x (still visible: the delete is uncommitted). Its decision insert's FK
-- check waits on the writer's account row while it holds L2.
select th.wait_for_application('c22-writer-holding');
select set_config('application_name', 'c22-rpc', false);
begin;
set local role service_role;
do $$
declare
  v_result jsonb;
begin
  v_result := public.link_card_payment('00000000-0000-0000-0000-0000000000aa',
    (select id from public.transactions where plaid_transaction_id = 'c22-p'),
    (select id from public.transactions where plaid_transaction_id = 'c22-x'), 0, (select v from public.th_c22_state));
  insert into public.th_c22_outcome values ('contender', v_result->>'status');
exception when deadlock_detected then
  insert into public.th_c22_outcome values ('contender', 'deadlock');
end $$;
commit;
