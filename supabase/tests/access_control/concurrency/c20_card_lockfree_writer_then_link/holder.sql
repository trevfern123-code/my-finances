-- The lock-free writer, holding the version row through its trigger bump.
begin;
do $$
declare
  v_contender integer;
  v_result jsonb;
begin
  perform set_config('role', 'service_role', true);
  update public.transactions set amount = -98 where plaid_transaction_id = 'c20-x';
  insert into public.th_c20_outcome values ('holder', 'committed');
  perform set_config('role', 'none', true);
  perform set_config('application_name', 'c20-holder', false);
  v_contender := th.wait_for_application('c20-contender');
  perform th.wait_until_blocked_by(v_contender, pg_backend_pid());
end $$;
commit;
