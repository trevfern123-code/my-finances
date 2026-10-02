-- The lock-free writer.
select th.wait_for_application('c19-holder');
select set_config('application_name', 'c19-contender', false);
begin;
set local role service_role;
do $$
begin
  update public.transactions set amount = -98 where plaid_transaction_id = 'c19-x';
  insert into public.th_c19_outcome values ('contender', 'committed');
end $$;
commit;
