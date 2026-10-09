-- A direct update (no advisory lock, no evaluation): its trigger bump waits on the version row.
select th.wait_for_application('c32-holder');
select set_config('application_name', 'c32-contender', false);
begin;
set local role service_role;
do $$
declare
  v_result jsonb;
begin
  update public.transactions set amount = 61 where plaid_transaction_id = 'c32-q';
  insert into public.th_c32_outcome values ('contender', 'updated');
end $$;
commit;
