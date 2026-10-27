-- The removal: it writes a hold that names the kept card's account while the writer holds that row.
select th.wait_for_application('c36-holder');
select set_config('application_name', 'c36-contender', false);
begin;
set local role service_role;
do $$
declare
  v_result jsonb;
begin
  v_result := public.remove_plaid_item_local('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001');
  insert into public.th_c36_outcome values ('contender', case when (v_result->>'replayed')::boolean then 'replayed' else 'removed' end);
end $$;
commit;
