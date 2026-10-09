-- The second removal (item 4): it queues on L1 behind the first and runs when that one has committed.
select th.wait_for_application('c37-holder');
select set_config('application_name', 'c37-contender', false);
begin;
set local role service_role;
do $$
declare
  v_result jsonb;
begin
  v_result := public.remove_plaid_item_local('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000004');
  insert into public.th_c37_outcome values ('contender', case when (v_result->>'replayed')::boolean then 'replayed' else 'removed' end);
  -- READ COMMITTED: this statement sees the first removal's outcome only if that transaction has committed.
  insert into public.th_c37_outcome
  select 'contender-saw', case when exists (select 1 from public.th_c37_outcome o where o.who = 'probe') then 'holder_committed' else 'holder_not_committed' end;
end $$;
commit;
