-- The removal, waiting on the per-user lock.
select th.wait_for_application('c28-holder');
select set_config('application_name', 'c28-contender', false);
begin;
set local role service_role;
do $$
declare
  v_result jsonb;
begin
  v_result := public.remove_plaid_item_local('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001');
  insert into public.th_c28_outcome values ('contender', case when (v_result->>'replayed')::boolean then 'replayed' else 'removed' end);
end $$;
commit;
