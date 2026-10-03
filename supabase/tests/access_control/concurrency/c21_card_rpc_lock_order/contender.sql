-- The RPC, with the current version: it must wait on L1 before touching the version row.
select th.wait_for_application('c21-holder');
select set_config('application_name', 'c21-contender', false);
begin;
set local role service_role;
do $$
declare
  v_result jsonb;
begin
  v_result := public.link_card_payment('00000000-0000-0000-0000-0000000000aa',
    (select id from public.transactions where plaid_transaction_id = 'c21-p'),
    (select id from public.transactions where plaid_transaction_id = 'c21-x'), 0, (select v from public.th_c21_state));
  insert into public.th_c21_outcome values ('contender', v_result->>'status');
end $$;
commit;
