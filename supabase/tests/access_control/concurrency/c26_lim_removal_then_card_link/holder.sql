-- The removal completes and holds its locks.
begin;
do $$
declare
  v_contender integer;
  v_result jsonb;
begin
  perform set_config('role', 'service_role', true);
  v_result := public.remove_plaid_item_local('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001');
  insert into public.th_c26_outcome values ('holder', case when (v_result->>'replayed')::boolean then 'replayed' else 'removed' end);
  perform set_config('role', 'none', true);
  perform set_config('application_name', 'c26-holder', false);
  v_contender := th.wait_for_application('c26-contender');
  perform th.wait_until_blocked_by(v_contender, pg_backend_pid());
end $$;
commit;
